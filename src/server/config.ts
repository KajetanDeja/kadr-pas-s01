import { z } from "zod";

const postgresUrl = z.url().refine((v) => ["postgresql:", "postgres:"].includes(new URL(v).protocol));

const schema = z.object({
  DATABASE_URL: postgresUrl,
  DATABASE_URL_POOLED: postgresUrl.optional(),
  RESERVATION_TTL_SECONDS: z.coerce.number().int().min(1).max(86400).default(900),
  TRUSTED_PROXY_SECRET: z.string().min(32).optional(),
  STRIPE_SECRET_KEY: z.string().regex(/^sk_test_[A-Za-z0-9]+$/).optional(),
  STRIPE_WEBHOOK_SECRET: z.string().regex(/^whsec_[A-Za-z0-9]+$/).optional(),
  APP_URL: z.url().refine((value) => {
    const url = new URL(value);
    return !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash &&
      (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)));
  }).optional()
});
export function parseConfig(env: Record<string, string | undefined>) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) throw new Error(`Niepoprawna konfiguracja: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
  return parsed.data;
}
export function config() { return parseConfig(process.env); }
