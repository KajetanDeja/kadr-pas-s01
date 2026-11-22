import { ApiError } from "@/server/errors";
import { handle, json, readRawBody } from "@/server/http";
import { processStripeEvent } from "@/server/payments";
import { paymentConfig, stripe } from "@/server/stripe";
import { runJobs } from "@/server/jobs";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function POST(request: Request) {
  return handle(async () => {
    const { webhookSecret } = paymentConfig();
    const signature = request.headers.get("stripe-signature");
    if (!signature) throw new ApiError(400, "INVALID_SIGNATURE", "Brak podpisu Stripe.");
    const raw = await readRawBody(request, 256 * 1024);
    let event;
    try { event = stripe().webhooks.constructEvent(raw, signature, webhookSecret); }
    catch { throw new ApiError(400, "INVALID_SIGNATURE", "Niepoprawny podpis Stripe."); }
    await processStripeEvent(event);
    // The durable job already exists before this best-effort immediate run.
    // Provider failures cannot roll back payment or require an open browser.
    await runJobs(1);
    return json({ received: true });
  });
}
