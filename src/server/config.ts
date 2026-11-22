import { z } from "zod";

const postgresUrl = z.url().refine((v) => ["postgresql:", "postgres:"].includes(new URL(v).protocol));

const schema = z.object({
  DATABASE_URL: postgresUrl,
  DATABASE_URL_POOLED: postgresUrl.optional(),
  RESERVATION_TTL_SECONDS: z.coerce.number().int().min(1).max(86400).default(900),
  TRUSTED_PROXY_SECRET: z.string().min(32).optional(),
  STRIPE_SECRET_KEY: z.string().regex(/^sk_test_[A-Za-z0-9]+$/).optional(),
  STRIPE_WEBHOOK_SECRET: z.string().regex(/^whsec_[A-Za-z0-9]+$/).optional(),
  VOUCHERIFY_APPLICATION_ID: z.string().min(1).optional(),
  VOUCHERIFY_SECRET_KEY: z.string().min(1).optional(),
  VOUCHERIFY_CAMPAIGN_ID: z.string().regex(/^camp_[A-Za-z0-9_-]+$/).optional(),
  VOUCHERIFY_API_URL: z.url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && /^(?:[a-z0-9-]+\.)?api\.voucherify\.io$/.test(url.hostname) &&
      !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash && !url.port;
  }).default("https://api.voucherify.io"),
  RESEND_API_KEY: z.string().regex(/^re_[A-Za-z0-9_-]+$/).optional(),
  RESEND_FROM: z.email().default("onboarding@resend.dev"),
  RESEND_WEBHOOK_SECRET: z.string().regex(/^whsec_[A-Za-z0-9+/=]+$/).optional(),
  CRON_SECRET: z.string().min(32).optional(),
  APP_URL: z.url().refine((value) => {
    const url = new URL(value);
    return !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash &&
      (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)));
  }).optional()
});
export function parseConfig(env: Record<string, string | undefined>) {
  const values = { ...env };
  // Compose supplies unset optional integration variables as empty strings.
  for (const key of ["VOUCHERIFY_APPLICATION_ID", "VOUCHERIFY_SECRET_KEY", "VOUCHERIFY_CAMPAIGN_ID", "VOUCHERIFY_API_URL", "RESEND_API_KEY", "RESEND_FROM", "RESEND_WEBHOOK_SECRET", "CRON_SECRET"]) {
    if (values[key] === "") values[key] = undefined;
  }
  const parsed = schema.safeParse(values);
  if (!parsed.success) throw new Error(`Niepoprawna konfiguracja: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
  return parsed.data;
}
export function config() { return parseConfig(process.env); }
