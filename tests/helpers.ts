import { createDb } from "../src/server/db";
import { setTimeout as sleep } from "node:timers/promises";
import assert from "node:assert/strict";
import Stripe from "stripe";
import { randomUUID } from "node:crypto";

if (!process.env.DATABASE_URL || !new URL(process.env.DATABASE_URL).pathname.endsWith("_test")) throw new Error("Odmowa: to nie jest baza testowa.");
export const db = createDb(process.env.DATABASE_URL);
export const base = process.env.TEST_BASE_URL!;
export const second = process.env.TEST_SECOND_URL ?? base;
export const headers = (ip = "192.0.2.1"): Record<string,string> => process.env.TEST_PROXY_MODE === "vercel" ? {
  "Content-Type": "application/json", "x-vercel-forwarded-for": ip,
  // Sprzeczne, niezaufane nagłówki muszą być ignorowane w trybie Vercel.
  "x-forwarded-for": "198.51.100.250", "x-kadr-client-ip": "198.51.100.251"
} : {
  "Content-Type": "application/json", "x-kadr-proxy-secret": process.env.TRUSTED_PROXY_SECRET!, "x-kadr-client-ip": ip
};
export const input = (seatId = "F7", email = "ola@example.com", eventId = "orbita") => ({ eventId, seatId, customerName: "Aleksandra", email });
export async function request(path: string, body?: unknown, ip?: string, server = base) {
  const response = await fetch(server + path, body === undefined ? { cache: "no-store" } : { method: "POST", headers: headers(ip), body: JSON.stringify(body) });
  const data = await response.json();
  return { response, data, status: response.status };
}
export const reserve = (data = input(), ip?: string, server = base) => request("/api/reservations", data, ip, server);
export async function webhook(event: unknown, server = base, secret = process.env.STRIPE_WEBHOOK_SECRET!) {
  const payload = JSON.stringify(event);
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret });
  const response = await fetch(server + "/api/webhooks/stripe", { method: "POST", headers: { "Content-Type": "application/json", "stripe-signature": signature }, body: payload });
  return { response, status: response.status, data: await response.json() };
}
export function completed(session: Record<string, unknown>, eventId = `evt_${randomUUID()}`) {
  return { id: eventId, object: "event", livemode: false, type: "checkout.session.completed", data: { object: { ...session, status: "complete", payment_status: "paid", payment_intent: `pi_${session.id}` } } };
}
// Regresje etapu I kupują przez podpisany webhook, nie przez furtkę /purchase.
export async function buy(id: string, server = base) {
  if (/^[0-9a-f-]{36}$/i.test(id)) {
    const r = await db.reservation.findUnique({ where: { id }, include: { ticket: true } });
    if (r && !r.ticket) {
      const attempt = await db.paymentAttempt.upsert({ where: { reservationId_generation: { reservationId: id, generation: 1 } }, create: { id: randomUUID(), reservationId: id, generation: 1, request: {}, state: "open", sessionId: `cs_test_${id}` }, update: { request: {} } });
      success(await webhook(completed({ id: attempt.sessionId, object: "checkout.session", livemode: false, mode: "payment", client_reference_id: id, amount_total: r.amount, currency: "pln" }, `evt_paid_${id}`), server));
    }
  }
  return request(`/api/reservations/${id}/purchase`, {}, undefined, server);
}
export async function reset() {
  await db.workItem.deleteMany();
  await db.deliveryEvent.deleteMany();
  await db.delivery.deleteMany();
  await db.loyaltyOperation.deleteMany();
  await db.loyaltyAccount.deleteMany();
  await db.ticket.deleteMany();
  await db.stripeEvent.deleteMany();
  await db.paymentAttempt.deleteMany();
  await db.eventSeat.updateMany({ data: { currentReservationId: null } });
  await db.reservation.deleteMany();
  await db.rateLimit.deleteMany();
  await fetch("http://127.0.0.1:3103/__reset", { method: "POST" });
  await fetch("http://127.0.0.1:3104/__reset", { method: "POST" });
}
export async function waitUntil(iso: string, offsetMs = 50) {
  const [row] = await db.$queryRaw<{now: Date}[]>`SELECT clock_timestamp() AS now`;
  await sleep(Math.max(0, new Date(iso).getTime() - row.now.getTime() + offsetMs));
}
export async function ownerCount(eventId = "orbita", seatId = "F7") {
  const [row] = await db.$queryRaw<{count: number}[]>`
    SELECT count(*)::int AS count FROM "Reservation" r
    LEFT JOIN "Ticket" t ON t."reservationId" = r.id
    WHERE r."eventId" = ${eventId} AND r."seatId" = ${seatId}
      AND (t.id IS NOT NULL OR r."expiresAt" > clock_timestamp())
  `;
  return row.count;
}
export function success(result: {status: number; data: unknown}) { assert.ok(result.status >= 200 && result.status < 300, JSON.stringify(result)); }
export function refused(result: {status: number; data: unknown}) { assert.ok(result.status >= 400 && result.status < 500, JSON.stringify(result)); }
