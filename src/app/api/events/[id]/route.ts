import { getEvent } from "@/server/booking";
import { handle, json } from "@/server/http";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(_: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => json(await getEvent((await ctx.params).id)));
}
