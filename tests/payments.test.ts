import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { base, second, db, input, reset, request, reserve, webhook, completed, waitUntil, success } from "./helpers";

beforeEach(reset);
after(() => db.$disconnect());
const checkout = (id: string, server = base) => request(`/api/reservations/${id}/checkout`, {}, undefined, server);
const fakeState = async () => (await fetch("http://127.0.0.1:3103/__state")).json() as Promise<{ sessions: Record<string, unknown>[]; refunds: Record<string, unknown>[] }>;
const control = (value: unknown) => fetch("http://127.0.0.1:3103/__control", { method: "POST", body: JSON.stringify(value) });
async function prepared() {
  const r = await reserve(); success(r);
  const c = await checkout(r.data.reservationId); success(c);
  const state = await fakeState();
  return { r, c, session: state.sessions[0] };
}

test("Migracja: istniejąca rezerwacja i bilet etapu I zachowują kod i właściciela", async () => {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    const schema = `upgrade_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    await client.query(await readFile(new URL("../prisma/migrations/202611010001_init/migration.sql", import.meta.url), "utf8"));
    const id = randomUUID();
    await client.query(`INSERT INTO "Event" VALUES ('legacy','Film','Tagline','Dramat',100,'12+',clock_timestamp(),'Sala 01','orbit')`);
    await client.query(`INSERT INTO "EventSeat" ("eventId","seatId") VALUES ('legacy','F7')`);
    await client.query(`INSERT INTO "Reservation" (id,"eventId","seatId","customerName",email,fingerprint,"createdAt","expiresAt") VALUES ($1,'legacy','F7','Anna','anna@example.com','legacy',clock_timestamp()-interval '1 hour',clock_timestamp()-interval '30 minutes')`, [id]);
    await client.query(`UPDATE "EventSeat" SET "currentReservationId"=$1 WHERE "eventId"='legacy'`, [id]);
    await client.query(`INSERT INTO "Ticket" (id,"reservationId","eventId","seatId",code,"purchasedAt") VALUES ($1,$2,'legacy','F7','KADR-LEGACY',clock_timestamp()-interval '45 minutes')`, [randomUUID(), id]);
    await client.query(await readFile(new URL("../prisma/migrations/202611160001_stripe_checkout/migration.sql", import.meta.url), "utf8"));
    const { rows } = await client.query(`SELECT r.amount,e.price,t.code,s."currentReservationId" FROM "Reservation" r JOIN "Event" e ON e.id=r."eventId" JOIN "Ticket" t ON t."reservationId"=r.id JOIN "EventSeat" s ON s."eventId"=r."eventId" AND s."seatId"=r."seatId"`);
    assert.deepEqual(rows, [{ amount: 3200, price: 3200, code: "KADR-LEGACY", currentReservationId: id }]);
  } finally { await client.query("ROLLBACK"); await client.end(); }
});

test("A: price w repertuarze, snapshot amount i niezmienność także w bazie", async () => {
  const list = await request("/api/events");
  for (const event of list.data) assert.equal(event.price, 3200);
  assert.equal((await request("/api/events/orbita")).data.event.price, 3200);
  const r = await reserve(); success(r); assert.equal(r.data.amount, 3200);
  try {
    await db.event.update({ where: { id: "orbita" }, data: { price: 4500 } });
    assert.equal((await reserve()).data.amount, 3200);
    assert.equal((await request(`/api/reservations/${r.data.reservationId}`)).data.amount, 3200);
    success(await checkout(r.data.reservationId));
    assert.equal((await fakeState()).sessions[0].amount_total, 3200);
    const other = await reserve(input("F8")); success(other); assert.equal(other.data.amount, 4500);
    await assert.rejects(() => db.reservation.update({ where: { id: r.data.reservationId }, data: { amount: 1 } }));
    await assert.rejects(() => db.event.update({ where: { id: "orbita" }, data: { price: 0 } }));
  } finally { await db.event.update({ where: { id: "orbita" }, data: { price: 3200 } }); }
});

test("A: Checkout jest idempotentny w dwóch instancjach i ma właściwe powroty", async () => {
  const r = await reserve(); success(r);
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => checkout(r.data.reservationId, i % 2 ? base : second)));
  for (const result of results) { success(result); assert.deepEqual(result.data, results[0].data); }
  const { sessions } = await fakeState(); assert.equal(sessions.length, 1);
  assert.equal(sessions[0].client_reference_id, r.data.reservationId);
  assert.equal(sessions[0].currency, "pln"); assert.equal(sessions[0].amount_total, 3200);
  assert.deepEqual(sessions[0].payment_method_types, ["card"]);
  assert.deepEqual(sessions[0].adaptive_pricing, { enabled: false });
  assert.equal(sessions[0].success_url, `${base}/platnosc/${r.data.reservationId}/sukces`);
  assert.equal(sessions[0].cancel_url, `${base}/platnosc/${r.data.reservationId}/anulowano`);
  assert.equal(await db.paymentAttempt.count(), 1); assert.equal(await db.ticket.count(), 0);
});

test("A: utrata odpowiedzi Stripe nie tworzy drugiej sesji", async () => {
  const r = await reserve(); success(r); await control({ dropCheckout: true });
  success(await checkout(r.data.reservationId));
  success(await checkout(r.data.reservationId, second));
  assert.equal((await fakeState()).sessions.length, 1);
});

test("A: odmowy 400/404/410, wygasły Checkout można zastąpić przed TTL", async () => {
  assert.equal((await checkout("abc")).status, 400);
  assert.equal((await checkout(randomUUID())).status, 404);
  const { r, session } = await prepared();
  await control({ expire: session.id });
  success(await checkout(r.data.reservationId));
  assert.equal((await fakeState()).sessions.length, 2);
  await waitUntil(r.data.expiresAt);
  assert.equal((await checkout(r.data.reservationId)).status, 410);
});

test("B: brak, błędny i stary podpis, zmienione surowe body i rozmiar są odrzucane", async () => {
  const { session } = await prepared();
  const event = completed(session);
  assert.equal((await webhook(event, base, "whsec_wrong")).status, 400);
  const noSignature = await fetch(base + "/api/webhooks/stripe", { method: "POST", body: JSON.stringify(event) });
  assert.equal(noSignature.status, 400);
  const Stripe = (await import("stripe")).default;
  const payload = JSON.stringify(event);
  for (const [raw, timestamp] of [[payload + " ", Math.floor(Date.now() / 1000)], [payload, 1]] as const) {
    const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET!, timestamp });
    const response = await fetch(base + "/api/webhooks/stripe", { method: "POST", headers: { "stripe-signature": signature }, body: raw });
    assert.equal(response.status, 400);
  }
  const tooLarge = await fetch(base + "/api/webhooks/stripe", { method: "POST", headers: { "stripe-signature": "invalid" }, body: "x".repeat(256 * 1024 + 1) });
  assert.equal(tooLarge.status, 413); assert.equal(await db.ticket.count(), 0);
});

test("B: kwota, waluta, rezerwacja i tryb live nie mogą zostać podmienione", async () => {
  const { session } = await prepared();
  for (const patch of [{ amount_total: 1 }, { currency: "eur" }, { client_reference_id: randomUUID() }, { livemode: true }, { mode: "subscription" }]) {
    assert.equal((await webhook(completed({ ...session, ...patch }))).status, 400);
  }
  const live = { ...completed(session), livemode: true };
  assert.equal((await webhook(live)).status, 400);
  assert.equal(await db.ticket.count(), 0);
});

test("B: nieopłacone, obce i nieobsługiwane zdarzenia nie wystawiają biletu", async () => {
  const { session } = await prepared();
  const unpaid = completed(session); unpaid.data.object.payment_status = "unpaid";
  success(await webhook(unpaid));
  success(await webhook(completed({ ...session, id: "cs_test_foreign" })));
  success(await webhook({ ...completed(session), type: "payment_intent.created" }));
  assert.equal(await db.ticket.count(), 0);
});

test("B: duplikaty webhooka i różne event.id tej samej sesji dają jeden trwały kod", async () => {
  const { r, session } = await prepared();
  const event = completed(session);
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => webhook(i < 4 ? event : completed(session), i % 2 ? base : second)));
  for (const result of results) success(result);
  const view = await request(`/api/reservations/${r.data.reservationId}`);
  assert.equal(view.data.status, "paid"); assert.match(view.data.code, /^KADR-/);
  assert.equal(await db.ticket.count(), 1);
  assert.equal((await checkout(r.data.reservationId)).status, 409);
  await waitUntil(r.data.expiresAt);
  assert.equal((await request(`/api/reservations/${r.data.reservationId}`)).data.code, view.data.code);
  assert.equal((await request(`/api/reservations/${r.data.reservationId}/purchase`, {})).data.code, view.data.code);
});

test("B: późna płatność jest zwracana bez odebrania fotela nowemu klientowi", async () => {
  const { r, session } = await prepared();
  await waitUntil(r.data.expiresAt);
  const other = await reserve(input("F7", "other@example.com")); success(other);
  const event = completed(session);
  const results = await Promise.all([webhook(event), webhook(event, second), webhook(completed(session))]);
  for (const result of results) success(result);
  assert.equal(await db.ticket.count(), 0); assert.equal((await fakeState()).refunds.length, 1);
  const view = await request(`/api/reservations/${r.data.reservationId}`);
  assert.equal(view.data.status, "expired"); assert.equal(view.data.refundStatus, "refunded");
  assert.equal(view.data.code, undefined);
  const owner = await db.eventSeat.findUniqueOrThrow({ where: { eventId_seatId: { eventId: "orbita", seatId: "F7" } } });
  assert.equal(owner.currentReservationId, other.data.reservationId);
});

test("B: awaria zwrotu daje 503, ponowienie webhooka kończy pojedynczy zwrot", async () => {
  const { r, session } = await prepared(); await waitUntil(r.data.expiresAt);
  const event = completed(session); await control({ failRefund: true });
  assert.equal((await webhook(event)).status, 503);
  assert.equal(await db.stripeEvent.count({ where: { id: event.id } }), 0);
  assert.equal((await request(`/api/reservations/${r.data.reservationId}`)).data.refundStatus, "pending");
  await control({ failRefund: false }); success(await webhook(event, second));
  assert.equal((await fakeState()).refunds.length, 1);
  assert.equal((await request(`/api/reservations/${r.data.reservationId}`)).data.refundStatus, "refunded");
});

test("B: druga opłacona sesja daje zwrot, zachowując pierwszy bilet", async () => {
  const { r, session } = await prepared(); success(await webhook(completed(session)));
  const code = (await request(`/api/reservations/${r.data.reservationId}`)).data.code;
  const id = `cs_test_${randomUUID()}`;
  await db.paymentAttempt.create({ data: { id: randomUUID(), reservationId: r.data.reservationId, generation: 2, request: {}, state: "open", sessionId: id } });
  success(await webhook(completed({ ...session, id })));
  assert.equal(await db.ticket.count(), 1); assert.equal((await fakeState()).refunds.length, 1);
  assert.equal((await request(`/api/reservations/${r.data.reservationId}`)).data.code, code);
});

test("B: zwrot utworzony przed awarią zapisu jest odnajdywany bez ponownego obciążania", async () => {
  const { r, session } = await prepared(); await waitUntil(r.data.expiresAt);
  const attempt = await db.paymentAttempt.findFirstOrThrow({ where: { reservationId: r.data.reservationId } });
  const intent = `pi_${session.id}`;
  await db.paymentAttempt.update({ where: { id: attempt.id }, data: { paymentIntentId: intent, state: "refund_pending", refundStatus: "pending" } });
  const form = new URLSearchParams({ payment_intent: intent, "metadata[attemptId]": attempt.id });
  assert.equal((await fetch("http://127.0.0.1:3103/v1/refunds", { method: "POST", body: form })).status, 200);
  success(await webhook(completed(session)));
  assert.equal((await fakeState()).refunds.length, 1);
  assert.equal((await request(`/api/reservations/${r.data.reservationId}`)).data.refundStatus, "refunded");
});

test("B: webhook zwrotu przed zapisem refundId i zdarzenia poza kolejnością", async () => {
  const { r, session } = await prepared();
  const attempt = await db.paymentAttempt.findFirstOrThrow({ where: { reservationId: r.data.reservationId } });
  const intent = `pi_${session.id}`;
  await db.paymentAttempt.update({ where: { id: attempt.id }, data: { paymentIntentId: intent, state: "refund_pending", refundStatus: "pending" } });
  const response = await fetch("http://127.0.0.1:3103/v1/refunds", { method: "POST", body: new URLSearchParams({ payment_intent: intent, "metadata[attemptId]": attempt.id }) });
  const refund = await response.json();
  await control({ refundId: refund.id, refundStatus: "pending" });
  success(await webhook({ id: `evt_${randomUUID()}`, livemode: false, type: "refund.created", data: { object: { ...refund, status: "pending" } } }));
  const pending = await db.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
  assert.equal(pending.refundId, refund.id); assert.equal(pending.refundStatus, "pending");
  await control({ refundId: refund.id, refundStatus: "succeeded" });
  for (const type of ["refund.updated", "refund.created"]) {
    success(await webhook({ id: `evt_${randomUUID()}`, livemode: false, type, data: { object: { ...refund, status: "pending" } } }));
  }
  assert.equal((await db.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).refundStatus, "refunded");
});

test("B: spóźniony session.expired nie cofa opłacenia", async () => {
  const { r, session } = await prepared(); success(await webhook(completed(session)));
  const code = (await request(`/api/reservations/${r.data.reservationId}`)).data.code;
  success(await webhook({ id: `evt_${randomUUID()}`, livemode: false, type: "checkout.session.expired", data: { object: { ...session, status: "expired" } } }));
  assert.equal((await request(`/api/reservations/${r.data.reservationId}`)).data.code, code);
  assert.equal((await db.paymentAttempt.findFirstOrThrow()).state, "paid");
});

test("C: status held bez kodu, strony powrotu nie potwierdzają płatności", async () => {
  const r = await reserve(); success(r);
  const view = await request(`/api/reservations/${r.data.reservationId}`);
  assert.equal(view.data.status, "held"); assert.equal(view.data.amount, 3200); assert.equal(view.data.code, undefined);
  assert.equal((await request(`/api/reservations/${r.data.reservationId}/purchase`, {})).status, 402);
  for (const result of ["sukces", "anulowano"]) {
    const page = await fetch(`${base}/platnosc/${r.data.reservationId}/${result}`);
    assert.equal(page.status, 200);
  }
  assert.equal((await fetch(base + "/platnosc/abc/sukces")).status, 404);
  assert.equal(await db.ticket.count(), 0);
  const { expiresAt } = await db.reservation.findUniqueOrThrow({ where: { id: r.data.reservationId } });
  assert.equal(expiresAt.toISOString(), r.data.expiresAt);
});

test("A: Checkout ma osobny współdzielony limit, nie blokuje webhooków", async () => {
  const r = await reserve(); success(r);
  for (let i = 0; i < 20; i++) assert.equal((await checkout("abc", i % 2 ? base : second)).status, 400);
  const denied = await checkout(r.data.reservationId);
  assert.equal(denied.status, 429); assert.ok(Number(denied.response.headers.get("retry-after")) >= 1);
  success(await reserve(input("F8")));
  success(await webhook({ id: `evt_${randomUUID()}`, livemode: false, type: "payment_intent.created", data: { object: {} } }));
});
