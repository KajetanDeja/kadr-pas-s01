import { handle, json, readRawBody } from "@/server/http";
import { processResendWebhook } from "@/server/mail";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  return handle(async () => {
    await processResendWebhook(await readRawBody(request, 256 * 1024), request.headers);
    return json({ received: true });
  });
}
