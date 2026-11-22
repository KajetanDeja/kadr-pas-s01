import { handle, json } from "@/server/http";
import { getLoyalty } from "@/server/loyalty";
import { limitReservation } from "@/server/rate-limit";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return handle(async () => {
    await limitReservation(request.headers, "loyalty");
    return json(await getLoyalty(new URL(request.url).searchParams.get("email") ?? ""));
  });
}
