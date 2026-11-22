import "dotenv/config";
import { setTimeout as sleep } from "node:timers/promises";
import { db } from "../src/server/db";
import { runJobs } from "../src/server/jobs";

let stopped = false;
process.on("SIGINT", () => { stopped = true; });
process.on("SIGTERM", () => { stopped = true; });
try {
  do {
    try { const result = await runJobs(1); if (result.completed || result.retried) console.log("KADR: zadania", result); }
    catch (error) { console.error("KADR: proces zadań", error instanceof Error ? error.name : "UnknownError"); }
    if (process.argv.includes("--once")) break;
    await sleep(5000);
  } while (!stopped);
} finally { await db().$disconnect(); }
