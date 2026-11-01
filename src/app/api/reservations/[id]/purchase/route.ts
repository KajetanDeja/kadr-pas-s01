import { purchase } from "@/server/booking";
import { ApiError } from "@/server/errors";
import { handle, json } from "@/server/http";
import { reservationId } from "@/server/validation";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function POST(_: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const id = reservationId.safeParse((await ctx.params).id);
    if (!id.success) throw new ApiError(400, "INVALID_ID", "Niepoprawny identyfikator rezerwacji.");
    const { serverNow, ...result } = await purchase(id.data);
    return json(result, 200, { "X-Server-Time": serverNow.toISOString() });
  });
}
