import { checkout } from "@/server/payments";
import { ApiError } from "@/server/errors";
import { handle, json } from "@/server/http";
import { limitReservation } from "@/server/rate-limit";
import { reservationId } from "@/server/validation";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    await limitReservation(request.headers, "checkout");
    const id = reservationId.safeParse((await ctx.params).id);
    if (!id.success) throw new ApiError(400, "INVALID_ID", "Niepoprawny identyfikator rezerwacji.");
    return json(await checkout(id.data));
  });
}
