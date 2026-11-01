import { reserve } from "@/server/booking";
import { handle, json, readReservationInput } from "@/server/http";
import { limitReservation } from "@/server/rate-limit";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function POST(request: Request) {
  return handle(async () => {
    await limitReservation(request.headers);
    const input = await readReservationInput(request);
    const { serverNow, ...result } = await reserve(input);
    return json(result, 201, { "X-Server-Time": serverNow.toISOString() });
  });
}
