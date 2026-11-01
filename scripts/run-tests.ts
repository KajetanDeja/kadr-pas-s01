import "dotenv/config";
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { createDb } from "../src/server/db";
import { seed } from "../prisma/seed";

const mode = process.argv[2];
if (!["api", "vercel", "ttl120"].includes(mode)) throw new Error("Wybierz api, vercel albo ttl120.");
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test") || new URL(url).pathname === new URL(process.env.DATABASE_URL!).pathname) {
  throw new Error("Testy wymagają osobnej TEST_DATABASE_URL z nazwą bazy zakończoną _test, różną od bazy aplikacji.");
}
const env: NodeJS.ProcessEnv = {
  // Nadpisujemy oba URL-e: odziedziczony pooler produkcyjny nie może wyprowadzić testów poza bazę testową.
  ...process.env, DATABASE_URL: url, DATABASE_URL_POOLED: url, NODE_ENV: "production",
  RESERVATION_TTL_SECONDS: mode === "ttl120" ? "120" : "3",
  TRUSTED_PROXY_SECRET: randomBytes(32).toString("hex"),
  // Zwykłe testy lokalne nie mogą odziedziczyć zaufania do platformy z hosta CI.
  VERCEL: mode === "vercel" ? "1" : "0",
  VERCEL_ENV: mode === "vercel" ? "production" : "development",
  TEST_PROXY_MODE: mode === "vercel" ? "vercel" : "nginx",
  TEST_BASE_URL: "http://127.0.0.1:3101", TEST_SECOND_URL: "http://127.0.0.1:3102"
};
const children: ChildProcess[] = [];
function run(args: string[]) {
  return new Promise<void>((accept, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: "inherit", windowsHide: true });
    children.push(child);
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? accept() : reject(new Error(`Polecenie zakończone kodem ${code}: ${args[0]}`)));
  });
}
async function freePort(port: number) {
  await new Promise<void>((accept, reject) => {
    const server = createServer();
    server.once("error", () => reject(new Error(`Port ${port} jest zajęty. Zatrzymaj poprzedni serwer testowy.`)));
    server.listen(port, "127.0.0.1", () => server.close(() => accept()));
  });
}
async function start(port: number) {
  await freePort(port);
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], { env, stdio: "inherit", windowsHide: true });
  children.push(child);
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw new Error("Serwer testowy nie wystartował.");
    try { if ((await fetch(`http://127.0.0.1:${port}/api/events`)).ok) return; } catch { /* start w toku */ }
    await sleep(250);
  }
  throw new Error("Przekroczono czas uruchamiania serwera testowego.");
}
try {
  await run(["node_modules/prisma/build/index.js", "migrate", "deploy"]);
  const db = createDb(url);
  try { await seed(db); } finally { await db.$disconnect(); }
  await start(3101);
  if (mode !== "ttl120") await start(3102);
  await run(["--import", "tsx", "--test", mode === "ttl120" ? "tests/ttl120.test.ts" : "tests/api.test.ts"]);
} catch (e) {
  console.error(e instanceof Error ? e.message : "Błąd testów."); process.exitCode = 1;
} finally {
  for (const child of children) if (child.exitCode === null) child.kill();
}
