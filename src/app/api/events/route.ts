import { db } from "@/server/db";
import { handle, json } from "@/server/http";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET() {
  return handle(async () => json(await db().event.findMany({ orderBy: [{ startsAt: "asc" }, { id: "asc" }] })));
}
