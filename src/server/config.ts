import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.url().refine((v) => ["postgresql:", "postgres:"].includes(new URL(v).protocol)),
  RESERVATION_TTL_SECONDS: z.coerce.number().int().min(1).max(86400).default(900),
  TRUSTED_PROXY_SECRET: z.string().min(32).optional()
});
export function parseConfig(env: Record<string, string | undefined>) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) throw new Error(`Niepoprawna konfiguracja: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
  return parsed.data;
}
export function config() { return parseConfig(process.env); }
