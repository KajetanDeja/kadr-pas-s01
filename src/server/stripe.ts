import Stripe from "stripe";
import { config } from "./config";
import { ApiError } from "./errors";

export function paymentConfig() {
  const settings = config();
  if (!settings.STRIPE_SECRET_KEY || !settings.STRIPE_WEBHOOK_SECRET || !settings.APP_URL) {
    throw new ApiError(503, "PAYMENTS_UNAVAILABLE", "Płatności są chwilowo niedostępne. Spróbuj ponownie później.");
  }
  return { secretKey: settings.STRIPE_SECRET_KEY, webhookSecret: settings.STRIPE_WEBHOOK_SECRET, origin: new URL(settings.APP_URL).origin };
}

export function stripe() {
  // Wyłącznie runner może wstrzyknąć transport przed startem Node. Nie ma
  // zmiennej środowiskowej ani parametru HTTP zmieniającego serwer Stripe.
  const transport = (globalThis as typeof globalThis & {
    kadrStripeTransport?: { host: string; port: number; protocol: "http" };
  }).kadrStripeTransport;
  return new Stripe(paymentConfig().secretKey, { timeout: 5000, maxNetworkRetries: 1, ...transport });
}

export async function stripeCall<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) {
    if (error instanceof ApiError) throw error;
    // Nie ujawniamy wiadomości SDK, danych klienta ani kluczy.
    console.error("KADR: Stripe niedostępny", error instanceof Error ? error.name : "UnknownError");
    throw new ApiError(503, "STRIPE_UNAVAILABLE", "Stripe chwilowo nie odpowiada. Spróbuj ponownie.");
  }
}
