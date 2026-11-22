import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { base, second, db, headers, request, reserve, input, reset, success, webhook, completed, waitUntil } from "./helpers";

beforeEach(reset);
after(() => db.$disconnect());
const state = async () => (await fetch("http://127.0.0.1:3104/__state")).json();
const control = (value: unknown) => fetch("http://127.0.0.1:3104/__control", { method: "POST", body: JSON.stringify(value) });
const loyalty = async (email: string, server = base) => {
  const response = await fetch(`${server}/api/loyalty?email=${encodeURIComponent(email)}`, { headers: headers() });
  return { status: response.status, data: await response.json(), response };
};
async function jobs() {
  await db.workItem.updateMany({ where: { state: "pending" }, data: { availableAt: new Date(0) } });
  const response = await fetch(`${base}/api/internal/jobs`, { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
  assert.equal(response.status, 200); return response.json();
}
async function prepare(points = 1000, email = "delivered+loyalty@resend.dev") {
  const r = await reserve(input("F7", email)); success(r);
  success(await request(`/api/reservations/${r.data.reservationId}/checkout`, { points }));
  const stripe = await (await fetch("http://127.0.0.1:3103/__state")).json();
  return { id: r.data.reservationId, r, session: stripe.sessions[0], email };
}
async function mailEvent(providerId: string, type: string, options: { bad?: boolean; when?: string; id?: string } = {}) {
  const raw = JSON.stringify({ type, created_at: options.when ?? new Date().toISOString(), data: { email_id: providerId } });
  const id = options.id ?? `msg_${randomUUID()}`, timestamp = String(Math.floor(Date.now() / 1000));
  const key = Buffer.from(process.env.RESEND_WEBHOOK_SECRET!.slice(6), "base64");
  const signature = createHmac("sha256", key).update(`${id}.${timestamp}.${raw}`).digest("base64");
  const response = await fetch(`${base}/api/webhooks/resend`, { method: "POST", headers: { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${options.bad ? "invalid" : signature}` }, body: raw });
  return { status: response.status, data: await response.json() };
}

test("A: powitanie raz, normalizacja e-maila, saldo z Voucherify i zmiana poza aplikacją", async () => {
  const first = await loyalty("  DELIVERED+Anna@resend.dev "); success(first);
  assert.deepEqual(first.data, { email: "delivered+anna@resend.dev", points: 1000 });
  assert.match(first.response.headers.get("cache-control")!, /no-store/);
  assert.equal((await loyalty("delivered+anna@resend.dev", second)).data.points, 1000);
  assert.equal((await state()).transactions.length, 1); assert.equal((await state()).cards.length, 1);
  await control({ email: "delivered+anna@resend.dev", balance: 3456 });
  assert.equal((await loyalty("delivered+anna@resend.dev")).data.points, 3456);
  assert.equal((await loyalty("bad")).status, 400);
});
test("A: utrata odpowiedzi dodania karty i punktów nie powiela powitania", async () => {
  await control({ dropMember: true });
  assert.equal((await loyalty("delivered+lost@resend.dev")).status, 503);
  await control({ dropBalance: true });
  assert.equal((await loyalty("delivered+lost@resend.dev")).status, 503);
  const recovered = await loyalty("delivered+lost@resend.dev", second); success(recovered);
  assert.equal(recovered.data.points, 1000); assert.equal((await state()).cards.length, 1); assert.equal((await state()).transactions.length, 1);
});
test("B/C: 32 zł = 1000 pkt + 22 zł, nagroda 220 pkt, jedna wiadomość i trwały bilet", async () => {
  const p = await prepare(); assert.equal(p.session.amount_total, 2200);
  assert.equal((await loyalty(p.email)).data.points, 0);
  const event = completed(p.session);
  success(await webhook(event)); success(await webhook(event, second));
  success(await webhook(completed(p.session), second));
  const view = await request(`/api/reservations/${p.id}`); success(view);
  assert.equal(view.data.status, "paid"); assert.equal(view.data.pointsUsed, 1000); assert.equal(view.data.pointsEarned, 220); assert.equal(view.data.cardAmount, 2200);
  assert.equal((await loyalty(p.email)).data.points, 220);
  const s = await state(); assert.equal(s.transactions.length, 3); assert.equal(s.emails.length, 1);
  const text = s.emails[0].body.text;
  for (const value of [view.data.code, "22,00", "1000 pkt", "220 pkt"]) assert.ok(text.includes(value), value);
  assert.equal(view.data.emailStatus, "accepted"); assert.equal(view.data.email, undefined);
});
test("B: brak points i zero zachowują pełną cenę i naliczają 320 punktów", async () => {
  const p = await prepare(0);
  assert.equal(p.session.amount_total, 3200); success(await webhook(completed(p.session)));
  assert.equal((await request(`/api/reservations/${p.id}`)).data.pointsEarned, 320);
  assert.equal((await loyalty(p.email)).data.points, 1320);
});
test("B: odmowy złego typu, limitu połowy, braku salda i zmiany aktywnej sesji", async () => {
  const r = await reserve(); success(r);
  const path = `/api/reservations/${r.data.reservationId}/checkout`;
  for (const points of [-1, 0.5, "1000", null, 1601]) assert.equal((await request(path, { points })).status, 400);
  assert.equal((await request(path, { points: 1001 })).status, 409);
  assert.equal(await db.paymentAttempt.count(), 0);
  success(await request(path, { points: 1000 }));
  assert.equal((await request(path, { points: 0 })).status, 409);
  success(await request(path, { points: 1000 }, undefined, second));
  assert.equal((await state()).transactions.length, 2);
});
test("B: utrata odpowiedzi obciążenia jest uzgadniana, nie odejmowana ponownie", async () => {
  success(await loyalty("ola@example.com"));
  const r = await reserve(); success(r);
  await control({ dropBalance: true });
  const path = `/api/reservations/${r.data.reservationId}/checkout`;
  assert.equal((await request(path, { points: 1000 })).status, 503);
  success(await request(path, { points: 1000 }, undefined, second));
  assert.equal((await state()).cards[0].loyalty_card.balance, 0); assert.equal((await state()).transactions.length, 2);
});
test("B: dwa zakupy tego samego klienta nie mogą wydać wspólnego salda dwa razy", async () => {
  success(await loyalty("ola@example.com"));
  const a = await reserve(), b = await reserve(input("F8")); success(a); success(b);
  const results = await Promise.all([request(`/api/reservations/${a.data.reservationId}/checkout`, { points: 1000 }), request(`/api/reservations/${b.data.reservationId}/checkout`, { points: 1000 }, undefined, second)]);
  assert.equal(results.filter(r => r.status === 200).length, 1);
  assert.equal(results.filter(r => r.status === 409).length, 1);
  assert.equal((await state()).cards[0].loyalty_card.balance, 0);
});
test("B: opuszczony Checkout oddaje punkty po TTL bez przeglądarki", async () => {
  const p = await prepare(); await waitUntil(p.r.data.expiresAt);
  await jobs();
  assert.equal((await loyalty(p.email)).data.points, 1000);
  assert.equal((await request(`/api/reservations/${p.id}`)).data.status, "expired");
  await jobs(); assert.equal((await state()).transactions.length, 3);
});
test("B: opłacenie po TTL zwraca kartę i punkty, bez nagrody i maila", async () => {
  const p = await prepare(); await waitUntil(p.r.data.expiresAt);
  success(await webhook(completed(p.session))); await jobs();
  const view = (await request(`/api/reservations/${p.id}`)).data;
  assert.equal(view.status, "expired"); assert.equal(view.refundStatus, "refunded");
  assert.equal((await loyalty(p.email)).data.points, 1000); assert.equal((await state()).emails.length, 0);
});
test("C: awaria Resend nie cofa biletu, ponowienie wysyła jedną wiadomość", async () => {
  const p = await prepare(); await control({ dropMail: true });
  success(await webhook(completed(p.session)));
  assert.equal((await request(`/api/reservations/${p.id}`)).data.status, "paid");
  await jobs(); // an expiry job can be selected before fulfillment
  await jobs();
  assert.equal((await state()).emails.length, 1);
  assert.equal((await db.delivery.findUniqueOrThrow({ where: { reservationId: p.id } })).state, "accepted");
});
test("C: podpisy Resend, doręczenie, odbicie, duplikaty i zła kolejność zdarzeń", async () => {
  const p = await prepare(); success(await webhook(completed(p.session)));
  const providerId = (await state()).emails[0].id;
  assert.equal((await mailEvent(providerId, "email.delivered", { bad: true })).status, 400);
  success(await mailEvent(providerId, "email.delivered"));
  assert.equal((await request(`/api/reservations/${p.id}`)).data.emailStatus, "delivered");
  const options = { id: `msg_${randomUUID()}` };
  success(await mailEvent(providerId, "email.bounced", options)); success(await mailEvent(providerId, "email.bounced", options));
  success(await mailEvent(providerId, "email.delivered", { when: new Date(Date.now() + 1000).toISOString() }));
  const view = (await request(`/api/reservations/${p.id}`)).data;
  assert.equal(view.emailStatus, "bounced"); assert.equal(view.status, "paid"); assert.equal(await db.ticket.count(), 1);
});
test("A/C: awaria Voucherify po zapłacie jest odrabiana przez trwałe zadanie", async () => {
  const p = await prepare(0); await control({ unavailable: true });
  success(await webhook(completed(p.session)));
  const before = (await request(`/api/reservations/${p.id}`)).data;
  assert.equal(before.status, "paid"); assert.equal(before.loyaltyStatus, "pending");
  await control({ unavailable: false }); await jobs(); await jobs();
  assert.equal((await request(`/api/reservations/${p.id}`)).data.pointsEarned, 320);
  assert.equal((await state()).emails.length, 1);
});
test("Proces zadań wymaga sekretu; nie ma publicznego resetowania", async () => {
  assert.equal((await fetch(`${base}/api/internal/jobs`)).status, 401);
  assert.equal((await fetch(`${base}/api/internal/jobs`, { headers: { authorization: "Bearer wrong" } })).status, 401);
});
test("A: limit Sandbox blokuje kolejne wywołania, 503 ma Retry-After", async () => {
  const key = `voucherify:${createHash("sha256").update("test_app").digest("hex")}`;
  await db.rateLimit.create({ data: { key, attempts: 95, expiresAt: new Date(Date.now() + 3600000) } });
  const limited = await loyalty("delivered+quota@resend.dev");
  assert.equal(limited.status, 503); assert.ok(Number(limited.response.headers.get("retry-after")) > 0);
  assert.equal((await state()).calls, 0);
});
test("A: 429 od Voucherify wstrzymuje dalsze wywołania we wszystkich instancjach", async () => {
  await control({ rateLimited: true });
  const first = await loyalty("delivered+quota@resend.dev");
  assert.equal(first.status, 503); assert.ok(Number(first.response.headers.get("retry-after")) >= 60);
  const calls = (await state()).calls;
  assert.equal((await loyalty("delivered+other@resend.dev", second)).status, 503);
  assert.equal((await state()).calls, calls);
});
test("A: limit przed utworzeniem karty pozwala bezpiecznie ponowić po odnowieniu budżetu", async () => {
  const key = `voucherify:${createHash("sha256").update("test_app").digest("hex")}`;
  await db.rateLimit.create({ data: { key, attempts: 94, expiresAt: new Date(Date.now() + 3600000) } });
  assert.equal((await loyalty("delivered+boundary@resend.dev")).status, 503);
  assert.equal((await state()).cards.length, 0);
  await db.rateLimit.delete({ where: { key } });
  const recovered = await loyalty("delivered+boundary@resend.dev"); success(recovered);
  assert.equal(recovered.data.points, 1000); assert.equal((await state()).cards.length, 1);
});
test("B: wolne odjęcie punktów ścigające się z TTL nie gubi punktów ani nie otwiera sesji", async () => {
  success(await loyalty("ola@example.com"));
  const r = await reserve(); success(r);
  await control({ delayDebitMs: 3300 });
  const pending = request(`/api/reservations/${r.data.reservationId}/checkout`, { points: 1000 });
  await waitUntil(r.data.expiresAt);
  await jobs();
  const result = await pending;
  assert.ok([409, 410].includes(result.status));
  await jobs();
  assert.equal((await loyalty("ola@example.com")).data.points, 1000);
  assert.equal(await db.ticket.count(), 0);
  const stripe = await (await fetch("http://127.0.0.1:3103/__state")).json();
  assert.ok(stripe.sessions.every((s: { status: string }) => s.status === "expired"));
});
