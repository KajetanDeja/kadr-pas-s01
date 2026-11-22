import "dotenv/config";
import { readFile, appendFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { parseConfig } from "../src/server/config";

// Explicit setup command for the firm's Sandbox. Never logs credentials.
const c = parseConfig(process.env);
if (!c.VOUCHERIFY_APPLICATION_ID || !c.VOUCHERIFY_SECRET_KEY) throw new Error("Uzupełnij Application Keys Voucherify w .env.");
const cardCampaign = z.object({ id: z.string(), name: z.string(), voucher: z.object({ loyalty_card: z.object({ points: z.number() }) }).optional() });
async function call(path: string, body?: unknown) {
  const response = await fetch(new URL(`/v1/${path}`, c.VOUCHERIFY_API_URL), {
    method: body ? "POST" : "GET", redirect: "error", headers: { "Content-Type": "application/json", "X-App-Id": c.VOUCHERIFY_APPLICATION_ID!, "X-App-Token": c.VOUCHERIFY_SECRET_KEY! },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) throw new Error(`Konfiguracja kampanii: HTTP ${response.status}`);
  return response.json();
}
try {
  const existing = await readFile(".env", "utf8");
  const additions: string[] = [];
  if (!c.VOUCHERIFY_CAMPAIGN_ID) {
    const list = z.object({ campaigns: z.array(cardCampaign) }).parse(await call("loyalties?limit=100"));
    const name = "KADR PAS S01";
    const campaign = list.campaigns.find(item => item.name === name) ?? cardCampaign.parse(await call("loyalties", {
      name, description: "PAS S01 Etap III — testowy program punktowy kina KADR",
      type: "AUTO_UPDATE", join_once: true, auto_join: false, vouchers_count: 1,
      voucher: { type: "LOYALTY_CARD", loyalty_card: { points: 0 }, code_config: { pattern: "KADR-L-##########" } }
    }));
    if (campaign.voucher?.loyalty_card.points !== 0) throw new Error("Kampania musi tworzyć karty z saldem 0; powitanie nalicza aplikacja.");
    additions.push(`VOUCHERIFY_CAMPAIGN_ID=${campaign.id}`);
    console.log("Kampania gotowa:", campaign.name, campaign.id);
  } else console.log("VOUCHERIFY_CAMPAIGN_ID jest już ustawione.");
  if (!c.CRON_SECRET) additions.push(`CRON_SECRET=${randomBytes(32).toString("hex")}`);
  if (additions.length) {
    // Append only: preserve existing secrets and concurrent user edits.
    await appendFile(".env", `${existing.endsWith("\n") ? "" : "\n"}${additions.join("\n")}\n`);
    console.log("Dopisano do .env:", additions.map(line => line.split("=", 1)[0]).join(", "));
  }
} catch (error) {
  console.error(error instanceof Error && /^(Konfiguracja kampanii: HTTP|Kampania musi)/.test(error.message) ? error.message : "Nie udało się skonfigurować kampanii. Sprawdź połączenie i ustawienia projektu Sandbox.");
  process.exitCode = 1;
}
