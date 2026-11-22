import { db } from "@/server/db";
import { ApiError } from "@/server/errors";
import { handle, json } from "@/server/http";
import { getLoyalty } from "@/server/loyalty";
import { limitReservation } from "@/server/rate-limit";
import { reservationId } from "@/server/validation";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    await limitReservation(request.headers, "loyalty");
    const id = reservationId.safeParse((await ctx.params).id);
    if (!id.success) throw new ApiError(400, "INVALID_ID", "Niepoprawny identyfikator rezerwacji.");
    const r = await db().reservation.findUnique({ where: { id: id.data } });
    if (!r) throw new ApiError(404, "RESERVATION_NOT_FOUND", "Nie znaleziono rezerwacji.");
    const result = await getLoyalty(r.email);
    return json({ points: result.points });
  });
}
