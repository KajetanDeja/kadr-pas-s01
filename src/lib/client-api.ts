export class RequestError extends Error {
  constructor(message: string, public status: number, public retryAfter?: number) { super(message); }
}
export async function api<T>(url: string, init?: RequestInit): Promise<{ data: T; serverNow: string | null }> {
  let response: Response;
  try { response = await fetch(url, { ...init, cache: "no-store", signal: init?.signal ?? AbortSignal.timeout(12000) }); }
  catch { throw new RequestError("Brak połączenia z kinem. Sprawdź sieć i spróbuj ponownie.", 0); }
  let data;
  try { data = await response.json(); }
  catch { throw new RequestError("Kino chwilowo nie odpowiada. Spróbuj ponownie.", response.status); }
  if (!response.ok) {
    const retry = Number(response.headers.get("retry-after")) || undefined;
    const message = data.error?.message ?? "Nie udało się wykonać operacji.";
    throw new RequestError(retry ? `${message} Spróbuj za ${retry} s.` : message, response.status, retry);
  }
  return { data: data as T, serverNow: response.headers.get("x-server-time") };
}
