import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const envPath = fileURLToPath(new URL("../.env", import.meta.url));
const values = dotenv.parse(readFileSync(envPath));
const key = values.STRIPE_SECRET_KEY;
if (!key || !/^sk_test_[A-Za-z0-9]+$/.test(key)) throw new Error("Ustaw STRIPE_SECRET_KEY=sk_test_… w lokalnym .env.");
const origin = new URL(values.APP_URL ?? "http://127.0.0.1:3000");
if (origin.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)) {
  throw new Error("Ten skrypt jest lokalny. APP_URL musi wskazywać localhost przez HTTP.");
}

const listener = spawn("stripe", [
  "listen", "--skip-update", "--color", "off", "--events-from", "@self",
  "--events", "checkout.session.completed,checkout.session.expired,refund.created,refund.updated,refund.failed",
  "--forward-to", `${origin.origin}/api/webhooks/stripe`
], { env: { ...process.env, STRIPE_API_KEY: key }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: process.platform === "win32" });

let pending = "", configured = false;
function lineOutput(text) {
  if (!configured) {
    const secret = text.match(/whsec_[A-Za-z0-9]+/)?.[0];
    if (secret) {
      const current = readFileSync(envPath, "utf8");
      const line = `STRIPE_WEBHOOK_SECRET=${secret}`;
      const updated = /^STRIPE_WEBHOOK_SECRET\s*=.*$/m.test(current)
        ? current.replace(/^STRIPE_WEBHOOK_SECRET\s*=.*$/m, line)
        : `${current.trimEnd()}\n${line}\n`;
      writeFileSync(envPath, updated);
      chmodSync(envPath, 0o600);
      configured = true;
      console.log("Webhook gotowy. STRIPE_WEBHOOK_SECRET zapisany w lokalnym .env (wartość ukryta).");
      console.log("Uruchom lub zrestartuj aplikację w drugim terminalu: npm run dev");
    }
  }
  // Nigdy nie przekazujemy sekretów CLI do logów, nawet w komunikacie błędu.
  process.stdout.write(text.replace(/(?:whsec_|sk_test_|sk_live_|pk_test_)[A-Za-z0-9]+/g, "[sekret ukryty]"));
}
function output(chunk) {
  // Buforujemy do końca linii, aby sekret podzielony na dwa chunki też
  // został ukryty w całości. Nie drukujemy niekompletnego fragmentu.
  pending += chunk.toString();
  let end;
  while ((end = pending.indexOf("\n")) !== -1) {
    const line = pending.slice(0, end + 1);
    pending = pending.slice(end + 1);
    lineOutput(line);
  }
}
listener.stdout.on("data", output);
listener.stderr.on("data", output);
listener.on("error", (error) => {
  console.error(error.code === "ENOENT" ? "Brak Stripe CLI. Zainstaluj: npm install -g @stripe/cli" : "Nie udało się uruchomić Stripe CLI.");
  process.exitCode = 1;
});
listener.on("exit", (code, signal) => {
  if (!configured && !signal) console.error("Nie uzyskano sekretu webhooka. Sprawdź klucz testowy i dostęp do Stripe.");
  process.exitCode = signal ? 0 : code ?? 1;
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => listener.kill(signal));
