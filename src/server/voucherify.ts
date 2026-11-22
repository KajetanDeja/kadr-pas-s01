import { createHash } from "node:crypto";
import { z } from "zod";
import { config } from "./config";
import { db } from "./db";
import { ApiError } from "./errors";

export class VoucherifyError extends Error {
  constructor(public status: number, public key: string, public retryAfter?: number) { super("Voucherify request failed"); }
}
export const loyaltyUnavailable = () => new ApiError(503, "LOYALTY_UNAVAILABLE", "Punkty są chwilowo niedostępne. Spróbuj ponownie później.");
export function loyaltyConfig() {
  const c = config();
  if (!c.VOUCHERIFY_APPLICATION_ID || !c.VOUCHERIFY_SECRET_KEY || !c.VOUCHERIFY_CAMPAIGN_ID) throw loyaltyUnavailable();
  return { appId: c.VOUCHERIFY_APPLICATION_ID, secret: c.VOUCHERIFY_SECRET_KEY, campaign: c.VOUCHERIFY_CAMPAIGN_ID, origin: c.VOUCHERIFY_API_URL };
}

async function budget(appId: string) {
  const key = `voucherify:${createHash("sha256").update(appId).digest("hex")}`;
  const [bucket] = await db().$queryRaw<{ attempts: number; retry: number }[]>`
    INSERT INTO "RateLimit" (key, attempts, "expiresAt") VALUES (${key}, 1, clock_timestamp() + interval '1 hour')
    ON CONFLICT (key) DO UPDATE SET
      attempts = CASE WHEN "RateLimit"."expiresAt" <= clock_timestamp() THEN 1 ELSE LEAST("RateLimit".attempts + 1, 1000000) END,
      "expiresAt" = CASE WHEN "RateLimit"."expiresAt" <= clock_timestamp() THEN clock_timestamp() + interval '1 hour' ELSE "RateLimit"."expiresAt" END
    RETURNING attempts, GREATEST(1, CEIL(EXTRACT(EPOCH FROM ("expiresAt" - clock_timestamp()))))::int AS retry`;
  // Keep five of the Sandbox's 100 calls for dashboard/manual troubleshooting.
  if (bucket.attempts > 95) throw new ApiError(503, "LOYALTY_RATE_LIMIT", "Limit usługi punktowej został wykorzystany. Spróbuj później.", { "Retry-After": String(bucket.retry) });
}

export async function voucherify<T>(path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
  const c = loyaltyConfig();
  await budget(c.appId);
  const transport = (globalThis as typeof globalThis & { kadrServiceFetch?: typeof fetch }).kadrServiceFetch ?? fetch;
  let response: Response;
  try {
    response = await transport(new URL(`/v1/${path}`, c.origin), {
      method: body === undefined ? "GET" : "POST", redirect: "error", cache: "no-store",
      headers: { "Content-Type": "application/json", "X-App-Id": c.appId, "X-App-Token": c.secret },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000)
    });
  } catch { throw new VoucherifyError(0, "transport"); }
  let data: unknown;
  try { data = await response.json(); } catch { throw new VoucherifyError(0, "invalid_response"); }
  if (!response.ok) {
    if (response.status === 429) {
      const retryAfter = Math.max(60, Math.min(3600, Number(response.headers.get("retry-after")) || 3600));
      const key = `voucherify:${createHash("sha256").update(c.appId).digest("hex")}`;
      await db().rateLimit.update({ where: { key }, data: { attempts: 95, expiresAt: new Date(Date.now() + retryAfter * 1000) } });
      throw new VoucherifyError(429, "rate_limit_exceeded", retryAfter);
    }
    const key = z.object({ key: z.string() }).safeParse(data);
    throw new VoucherifyError(response.status, key.success ? key.data.key : "upstream_error");
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new VoucherifyError(0, "invalid_response");
  return parsed.data;
}

export const memberSchema = z.object({ code: z.string().min(1), campaign_id: z.string(), active: z.boolean(), loyalty_card: z.object({ balance: z.number().int().nonnegative() }) });
export const balanceSchema = z.object({ balance: z.number().int().nonnegative(), points: z.number().int() });
export const transactionSchema = z.object({ data: z.array(z.object({ source_id: z.string().nullable().optional(), details: z.object({ balance: z.object({ points: z.number().int() }).passthrough() }).passthrough() })), has_more: z.boolean(), more_starting_after: z.string().nullable().optional() });
