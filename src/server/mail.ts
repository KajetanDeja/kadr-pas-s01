import { Resend } from "resend";
import { z } from "zod";
import { config } from "./config";
import { db } from "./db";
import { ApiError } from "./errors";

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
const money = (amount: number) => new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN" }).format(amount / 100);
const unavailable = () => new ApiError(503, "MAIL_UNAVAILABLE", "Wysyłka wiadomości jest chwilowo niedostępna.");

async function applyDeliveryEvents(providerId: string) {
  // Bounced/failed are terminal: a delayed 'delivered' event cannot hide them.
  const events = await db().deliveryEvent.findMany({ where: { providerId }, orderBy: { occurredAt: "asc" } });
  for (const event of events) {
    await db().delivery.updateMany({
      where: { providerId, state: { notIn: ["bounced", "failed"] }, OR: [{ lastEventAt: null }, { lastEventAt: { lte: event.occurredAt } }, ...(event.state === "bounced" || event.state === "failed" ? [{}] : [])] },
      data: { state: event.state, lastEventAt: event.occurredAt }
    });
  }
}

export async function sendTicket(reservationId: string) {
  const settings = config();
  if (!settings.RESEND_API_KEY || !settings.APP_URL) throw unavailable();
  const r = await db().reservation.findUniqueOrThrow({ where: { id: reservationId }, include: { ticket: true, event: true } });
  if (!r.ticket || r.loyaltyStatus === "pending") throw unavailable();
  let delivery = await db().delivery.upsert({ where: { reservationId }, create: { reservationId }, update: {} });
  if (["accepted", "delivered", "bounced", "failed"].includes(delivery.state)) return;
  if (delivery.state === "review") throw new ApiError(503, "MAIL_REVIEW", "Wysyłka wymaga sprawdzenia przez obsługę kina.");
  if (!delivery.request) {
    const when = new Intl.DateTimeFormat("pl-PL", { dateStyle: "long", timeStyle: "short", timeZone: "Europe/Warsaw" }).format(r.event.startsAt);
    const link = `${new URL(settings.APP_URL).origin}/platnosc/${r.id}/sukces`;
    const lines = ["Twój bilet — Kino KADR", r.event.title, when, `${r.event.hall}, fotel ${r.seatId}`, `Kod biletu: ${r.ticket.code}`, `Cena biletu: ${money(r.amount)}`, `Zapłacono kartą: ${money(r.amount - r.pointsUsed)}`, `Zapłacono punktami: ${r.pointsUsed} pkt (${money(r.pointsUsed)})`, `Zebrane punkty: ${r.pointsEarned} pkt`, `Bilet i wydruk: ${link}`];
    const body = { from: settings.RESEND_FROM, to: [r.email], subject: "Twój bilet do kina KADR", text: lines.join("\n"), html: `<div lang="pl" style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:24px;color:#17241f"><h1>Twój bilet</h1>${lines.slice(1, -1).map(line => `<p>${escapeHtml(line)}</p>`).join("")}<p><a href="${escapeHtml(link)}">Otwórz i wydrukuj bilet</a></p></div>` };
    delivery = await db().delivery.update({ where: { reservationId }, data: { request: body } });
  }
  // Resend retains idempotency keys for 24 h. Never retry an ambiguous send after
  // that window: it could deliver the same confirmation twice.
  if (delivery.firstSentAt && Date.now() - delivery.firstSentAt.getTime() > 23 * 60 * 60 * 1000) {
    await db().delivery.update({ where: { reservationId }, data: { state: "review" } });
    throw new ApiError(503, "MAIL_REVIEW", "Wysyłka wymaga sprawdzenia przez obsługę kina.");
  }
  await db().delivery.update({ where: { reservationId }, data: { state: "sending", firstSentAt: delivery.firstSentAt ?? new Date() } });
  const transport = (globalThis as typeof globalThis & { kadrServiceFetch?: typeof fetch }).kadrServiceFetch ?? fetch;
  let response: Response;
  try {
    response = await transport("https://api.resend.com/emails", {
      method: "POST", redirect: "error", headers: { Authorization: `Bearer ${settings.RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": `ticket:${reservationId}` },
      body: JSON.stringify(delivery.request), signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw unavailable();
    const { id } = z.object({ id: z.string().min(1) }).parse(await response.json());
    await db().delivery.update({ where: { reservationId }, data: { providerId: id, state: "accepted" } });
    await applyDeliveryEvents(id);
  } catch { throw unavailable(); }
}

export async function processResendWebhook(raw: string, headers: Headers) {
  const secret = config().RESEND_WEBHOOK_SECRET;
  if (!secret) throw unavailable();
  let event;
  try {
    event = new Resend("re_signature_verification").webhooks.verify({ payload: raw, headers: { id: headers.get("svix-id") ?? "", timestamp: headers.get("svix-timestamp") ?? "", signature: headers.get("svix-signature") ?? "" }, webhookSecret: secret });
  } catch { throw new ApiError(400, "INVALID_SIGNATURE", "Niepoprawny podpis Resend."); }
  const states: Record<string, string> = { "email.delivered": "delivered", "email.bounced": "bounced", "email.failed": "failed", "email.suppressed": "failed" };
  const state = states[event.type];
  if (!state) return;
  const parsed = z.object({ created_at: z.iso.datetime(), data: z.object({ email_id: z.string().min(1) }) }).safeParse(event);
  if (!parsed.success) throw new ApiError(400, "INVALID_MAIL_EVENT", "Niepoprawne zdarzenie Resend.");
  const providerId = parsed.data.data.email_id;
  await db().deliveryEvent.upsert({ where: { id: headers.get("svix-id")! }, create: { id: headers.get("svix-id")!, providerId, state, occurredAt: new Date(parsed.data.created_at) }, update: {} });
  await applyDeliveryEvents(providerId);
}
