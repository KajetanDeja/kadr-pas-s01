import { timingSafeEqual } from "node:crypto";
import { config } from "@/server/config";
import { ApiError } from "@/server/errors";
import { handle, json } from "@/server/http";
import { runJobs } from "@/server/jobs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function GET(request: Request) {
  return handle(async () => {
    const secret = config().CRON_SECRET;
    if (!secret) throw new ApiError(503, "JOBS_UNAVAILABLE", "Proces zadań nie jest skonfigurowany.");
    const expected = Buffer.from(`Bearer ${secret}`), given = Buffer.from(request.headers.get("authorization") ?? "");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new ApiError(401, "UNAUTHORIZED", "Brak dostępu.");
    return json(await runJobs(1));
  });
}
