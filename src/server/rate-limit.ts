import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { config } from "./config";
import { db } from "./db";
import { ApiError } from "./errors";

export function isVercelDeployment(env: Record<string, string | undefined> = process.env) {
  return env.VERCEL === "1" && (env.VERCEL_ENV === "production" || env.VERCEL_ENV === "preview");
}

// Tryb Vercel pochodzi wyłącznie z konfiguracji procesu, nigdy z nagłówka żądania.
export function clientKey(headers: Headers, secret?: string, vercelDeployment = false) {
  let client = "local-shared";
  if (vercelDeployment) {
    // Vercel nadpisuje ten nagłówek na swoim wejściu. Nie używamy fallbacku
    // do X-Forwarded-For ani nagłówków własnego proxy dostarczonych przez klienta.
    const ip = headers.get("x-vercel-forwarded-for")?.trim() ?? "";
    if (!isIP(ip)) throw new ApiError(400, "INVALID_CLIENT_IP", "Nie udało się odczytać poprawnego adresu klienta z Vercel.");
    client = ip;
  } else if (secret) {
    const provided = headers.get("x-kadr-proxy-secret") ?? "";
    const a = Buffer.from(provided), b = Buffer.from(secret);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new ApiError(403, "PROXY_REQUIRED", "Żądanie musi przejść przez zaufane proxy.");
    const ip = headers.get("x-kadr-client-ip") ?? "";
    if (!isIP(ip)) throw new ApiError(400, "INVALID_CLIENT_IP", "Proxy nie przekazało poprawnego adresu klienta.");
    client = ip;
  }
  return createHash("sha256").update(client).digest("hex");
}

export async function limitReservation(headers: Headers) {
  const key = clientKey(headers, config().TRUSTED_PROXY_SECRET, isVercelDeployment());
  // Usuwanie oportunistyczne, również po 429. W spoczynku tabela nie rośnie.
  await db().$executeRaw`DELETE FROM "RateLimit" WHERE "expiresAt" < clock_timestamp() - interval '1 minute'`;
  const [bucket] = await db().$queryRaw<{ attempts: number; retry: number }[]>`
    INSERT INTO "RateLimit" ("key", "attempts", "expiresAt")
    VALUES (${key}, 1, clock_timestamp() + interval '10 seconds')
    ON CONFLICT ("key") DO UPDATE SET
      "attempts" = CASE WHEN "RateLimit"."expiresAt" <= clock_timestamp() THEN 1 ELSE LEAST("RateLimit"."attempts" + 1, 1000000) END,
      "expiresAt" = CASE WHEN "RateLimit"."expiresAt" <= clock_timestamp() THEN clock_timestamp() + interval '10 seconds' ELSE "RateLimit"."expiresAt" END
    RETURNING "attempts", GREATEST(1, CEIL(EXTRACT(EPOCH FROM ("expiresAt" - clock_timestamp()))))::int AS retry
  `;
  if (bucket.attempts > 20) throw new ApiError(429, "RATE_LIMITED", "Za dużo prób. Odczekaj chwilę i spróbuj ponownie.", { "Retry-After": String(bucket.retry) });
}
