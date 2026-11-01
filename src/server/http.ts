import { NextResponse } from "next/server";
import { ApiError } from "./errors";
import { reservationInput } from "./validation";

export function json(data: unknown, status = 200, headers?: Record<string, string>) {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "no-store, max-age=0", ...headers } });
}
export async function handle(action: () => Promise<Response>) {
  try { return await action(); }
  catch (error) {
    if (error instanceof ApiError) return json({ error: { code: error.code, message: error.message } }, error.status, error.headers);
    // Logujemy tylko kategorię, bez ciała żądania, PII, SQL i sekretów.
    console.error("KADR: nieoczekiwany błąd serwera", error instanceof Error ? error.name : "UnknownError");
    return json({ error: { code: "INTERNAL_ERROR", message: "Nie udało się obsłużyć żądania. Spróbuj ponownie za chwilę." } }, 500);
  }
}
export async function readReservationInput(request: Request) {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) throw new ApiError(415, "JSON_REQUIRED", "Wyślij dane jako application/json.");
  // Ograniczenie także dla żądań chunked, bez wiary w Content-Length.
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "INVALID_JSON", "Brak danych JSON.");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4096) { await reader.cancel(); throw new ApiError(413, "BODY_TOO_LARGE", "Żądanie jest za duże."); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ApiError(400, "INVALID_JSON", "Niepoprawny JSON."); }
  const parsed = reservationInput.safeParse(body);
  if (!parsed.success) throw new ApiError(400, "INVALID_INPUT", "Podaj poprawny seans, fotel, imię i adres e-mail.");
  return parsed.data;
}
