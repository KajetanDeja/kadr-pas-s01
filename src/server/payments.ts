import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import type { Prisma } from "../generated/prisma/client";
import { databaseNow, lockSeat, transactionOptions } from "./booking";
import { db } from "./db";
import { ApiError } from "./errors";
import { paymentConfig, stripe, stripeCall } from "./stripe";
import { reservationId } from "./validation";
import { debitPoints, getLoyalty } from "./loyalty";
import { enqueue, wakeExpiry } from "./queue";

const expired = () => new ApiError(410, "RESERVATION_EXPIRED", "Rezerwacja wygasła, fotel wrócił do puli.");
const processing = () => new ApiError(409, "PAYMENT_PROCESSING", "Płatność jest przetwarzana. Sprawdź stan rezerwacji.");

export async function checkout(id: string, points?: number): Promise<{ url: string }> {
  const { origin } = paymentConfig();
  if (points) {
    const r = await db().reservation.findUnique({ where: { id }, include: { ticket: true } });
    if (!r) throw new ApiError(404, "RESERVATION_NOT_FOUND", "Nie znaleziono rezerwacji.");
    if (r.ticket) throw new ApiError(409, "ALREADY_PAID", "Rezerwacja jest już opłacona.");
    if (points > Math.floor(r.amount / 2)) throw new ApiError(400, "POINTS_LIMIT", "Punktami możesz zapłacić najwyżej połowę ceny biletu.");
    const previous = await db().paymentAttempt.findFirst({ where: { reservationId: id, state: { in: ["creating", "open"] } } });
    if (!previous) {
      const balance = await getLoyalty(r.email);
      if (points > balance.points) throw new ApiError(409, "INSUFFICIENT_POINTS", "Masz za mało punktów. Zmniejsz liczbę punktów lub zapłać kartą.");
    }
  }
  for (let retry = 0; retry < 2; retry++) {
    const attempt = await db().$transaction(async (tx) => {
      const r = await tx.reservation.findUnique({ where: { id }, include: { event: true } });
      if (!r) throw new ApiError(404, "RESERVATION_NOT_FOUND", "Nie znaleziono rezerwacji.");
      const seat = await lockSeat(tx, r.eventId, r.seatId);
      const now = await databaseNow(tx);
      if (await tx.ticket.findUnique({ where: { reservationId: id } })) throw new ApiError(409, "ALREADY_PAID", "Rezerwacja jest już opłacona.");
      if (seat.currentReservationId !== id || r.expiresAt <= now) throw expired();
      const latest = await tx.paymentAttempt.findFirst({ where: { reservationId: id }, orderBy: { generation: "desc" } });
      const pointsUsed = points ?? (latest && ["creating", "open"].includes(latest.state) ? latest.pointsUsed : 0);
      if (pointsUsed > Math.floor(r.amount / 2)) throw new ApiError(400, "POINTS_LIMIT", "Punktami możesz zapłacić najwyżej połowę ceny biletu.");
      if (latest && latest.state !== "expired") {
        if (!["creating", "open"].includes(latest.state)) throw processing();
        if (latest.pointsUsed !== pointsUsed) throw new ApiError(409, "CHECKOUT_LOCKED", "Sesja płatności ma już ustaloną liczbę punktów. Dokończ tę płatność lub poczekaj na wygaśnięcie rezerwacji.");
        return latest;
      }
      // A previous discounted session must release its points before replacement.
      if (latest?.pointsUsed && latest.pointsState !== "released") throw processing();
      const attemptId = randomUUID();
      const params: Stripe.Checkout.SessionCreateParams = {
        mode: "payment", allowed_payment_method_types: ["card"], locale: "pl",
        adaptive_pricing: { enabled: false },
        client_reference_id: id, customer_email: r.email,
        metadata: { attemptId }, payment_intent_data: { metadata: { attemptId, reservationId: id } },
        line_items: [{ quantity: 1, price_data: { currency: "pln", unit_amount: r.amount - pointsUsed, product_data: { name: `${r.event.title} — fotel ${r.seatId}` } } }],
        success_url: `${origin}/platnosc/${id}/sukces`, cancel_url: `${origin}/platnosc/${id}/anulowano`
      };
      const created = await tx.paymentAttempt.create({ data: { id: attemptId, reservationId: id, generation: (latest?.generation ?? 0) + 1, request: params as Prisma.InputJsonValue, pointsUsed, pointsState: pointsUsed ? "pending" : "none", loyaltyEnabled: true } });
      await tx.reservation.update({ where: { id }, data: { pointsUsed } });
      await enqueue("expire", attemptId, r.expiresAt, tx);
      return created;
    }, transactionOptions);

    if (attempt.pointsUsed) await debitPoints(attempt.id);
    const client = stripe();
    const session = await stripeCall(() => attempt.sessionId
      ? client.checkout.sessions.retrieve(attempt.sessionId)
      : client.checkout.sessions.create(attempt.request as unknown as Stripe.Checkout.SessionCreateParams, { idempotencyKey: `checkout:${attempt.id}` }));
    if (session.livemode || session.client_reference_id !== id || session.amount_total !== (attempt.request as unknown as Stripe.Checkout.SessionCreateParams).line_items?.[0]?.price_data?.unit_amount || session.currency !== "pln") {
      throw new ApiError(502, "INVALID_CHECKOUT", "Nie udało się potwierdzić danych sesji płatności.");
    }
    // Zapis warunkowy: spóźniona odpowiedź API nie może cofnąć webhooka.
    await db().paymentAttempt.updateMany({ where: { id: attempt.id, state: { in: ["creating", "open"] } }, data: { sessionId: session.id, url: session.url, state: session.status === "expired" ? "expired" : "open" } });
    if (session.status === "expired") { await wakeExpiry(attempt.id); continue; }
    if (session.status !== "open" || !session.url) throw processing();
    await db().$transaction(async (tx) => {
      const r = await tx.reservation.findUniqueOrThrow({ where: { id } });
      const seat = await lockSeat(tx, r.eventId, r.seatId);
      const now = await databaseNow(tx);
      if (await tx.ticket.findUnique({ where: { reservationId: id } })) throw new ApiError(409, "ALREADY_PAID", "Rezerwacja jest już opłacona.");
      if (seat.currentReservationId !== id || r.expiresAt <= now) throw expired();
    }, transactionOptions);
    const url = new URL(session.url);
    if (url.protocol !== "https:" || url.hostname !== "checkout.stripe.com") throw new ApiError(502, "INVALID_CHECKOUT_URL", "Niepoprawny adres płatności.");
    return { url: session.url };
  }
  throw processing();
}

async function markProcessed(id: string) {
  await db().stripeEvent.upsert({ where: { id }, create: { id }, update: { id } });
}

async function refund(attemptId: string) {
  const attempt = await db().paymentAttempt.findUniqueOrThrow({ where: { id: attemptId } });
  if (attempt.state === "refunded" || attempt.refundId) return;
  if (!attempt.paymentIntentId) throw new Error("MissingPaymentIntent");
  const client = stripe();
  // Uzgodnienie chroni także po upływie 24 h retencji klucza idempotencji
  // i po awarii pomiędzy utworzeniem zwrotu w Stripe a zapisem w bazie.
  const existing = await stripeCall(() => client.refunds.list({ payment_intent: attempt.paymentIntentId!, limit: 100 }));
  const previous = existing.data.find((r) => r.metadata?.attemptId === attemptId);
  const result = previous ?? await stripeCall(() => client.refunds.create({ payment_intent: attempt.paymentIntentId!, metadata: { attemptId } }, { idempotencyKey: `refund:${attemptId}` }));
  const status = result.status === "succeeded" ? "refunded" : result.status === "failed" || result.status === "canceled" ? "failed" : "pending";
  await db().paymentAttempt.updateMany({ where: { id: attemptId, state: { not: "refunded" } }, data: { refundId: result.id, refundStatus: status, state: status === "refunded" ? "refunded" : "refund_pending" } });
  if (status === "failed") console.error("KADR: zwrot wymaga interwencji operatora", attemptId);
}

export async function processStripeEvent(event: Stripe.Event) {
  if (event.livemode) throw new ApiError(400, "LIVE_EVENT_REJECTED", "Obsługujemy wyłącznie tryb testowy.");
  if (await db().stripeEvent.findUnique({ where: { id: event.id } })) return;
  if (["refund.created", "refund.updated", "refund.failed"].includes(event.type)) {
    const value = event.data.object as Stripe.Refund;
    const metadataId = reservationId.safeParse(value.metadata?.attemptId);
    const attempt = await db().paymentAttempt.findFirst({ where: { OR: [
      { refundId: value.id },
      ...(metadataId.success ? [{ id: metadataId.data, state: { in: ["refund_pending", "refunded"] } }] : [])
    ] } });
    if (attempt) {
      // Odczyt aktualnego stanu ze Stripe obsługuje zdarzenia poza kolejnością.
      const current = await stripeCall(() => stripe().refunds.retrieve(value.id));
      const intent = typeof current.payment_intent === "string" ? current.payment_intent : current.payment_intent?.id;
      if (intent !== attempt.paymentIntentId) throw new ApiError(400, "REFUND_MISMATCH", "Zwrot nie odpowiada płatności.");
      const status = current.status === "succeeded" ? "refunded" : ["failed", "canceled"].includes(current.status ?? "") ? "failed" : "pending";
      await db().paymentAttempt.updateMany({ where: { id: attempt.id, state: { not: "refunded" } }, data: { refundId: current.id, refundStatus: status, state: status === "refunded" ? "refunded" : "refund_pending" } });
      if (status === "failed") console.error("KADR: zwrot wymaga interwencji operatora", attempt.id);
    }
    await markProcessed(event.id); return;
  }
  if (!["checkout.session.completed", "checkout.session.expired"].includes(event.type)) {
    await markProcessed(event.id); return;
  }
  const session = event.data.object as Stripe.Checkout.Session;
  const attempt = await db().paymentAttempt.findUnique({ where: { sessionId: session.id } });
  // Zdarzenia CLI i innych aplikacji na tym samym koncie nie tworzą biletów.
  if (!attempt) { await markProcessed(event.id); return; }
  const r = await db().reservation.findUniqueOrThrow({ where: { id: attempt.reservationId } });
  if (session.livemode || session.client_reference_id !== r.id || session.mode !== "payment" || session.amount_total !== r.amount - attempt.pointsUsed || session.currency !== "pln") {
    throw new ApiError(400, "PAYMENT_MISMATCH", "Dane płatności nie zgadzają się z rezerwacją.");
  }
  if (session.payment_status === "paid" && session.status === "complete" && attempt.pointsUsed && attempt.pointsState !== "released") await debitPoints(attempt.id);
  const refundId = await db().$transaction(async (tx) => {
    const seat = await lockSeat(tx, r.eventId, r.seatId);
    const now = await databaseNow(tx);
    if (await tx.stripeEvent.findUnique({ where: { id: event.id } })) return null;
    const payment = await tx.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    if (event.type === "checkout.session.expired") {
      await tx.paymentAttempt.updateMany({ where: { id: payment.id, state: { in: ["creating", "open"] } }, data: { state: "expired" } });
    } else if (session.payment_status === "paid" && session.status === "complete") {
      const intent = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
      if (!intent) throw new ApiError(400, "MISSING_PAYMENT_INTENT", "Brak identyfikatora płatności.");
      if (payment.state === "refund_pending") return payment.id;
      if (!["paid", "refunded"].includes(payment.state)) {
        const ticket = await tx.ticket.findUnique({ where: { reservationId: r.id } });
        if (!ticket && seat.currentReservationId === r.id && r.expiresAt > now && (!payment.pointsUsed || payment.pointsState === "debited")) {
          await tx.ticket.create({ data: { id: randomUUID(), reservationId: r.id, eventId: r.eventId, seatId: r.seatId, code: `KADR-${randomUUID().replaceAll("-", "").toUpperCase()}`, purchasedAt: now } });
          await tx.paymentAttempt.update({ where: { id: payment.id }, data: { paymentIntentId: intent, state: "paid" } });
          await tx.reservation.update({ where: { id: r.id }, data: { pointsUsed: payment.pointsUsed, loyaltyStatus: payment.loyaltyEnabled ? "pending" : "none" } });
          if (payment.loyaltyEnabled) {
            await tx.delivery.create({ data: { reservationId: r.id } });
            await enqueue("fulfill", r.id, now, tx);
          }
        } else {
          await tx.paymentAttempt.update({ where: { id: payment.id }, data: { paymentIntentId: intent, state: "refund_pending", refundStatus: "pending" } });
          return payment.id;
        }
      }
    }
    await tx.stripeEvent.create({ data: { id: event.id } });
    return null;
  }, transactionOptions);
  if (refundId) { await refund(refundId); await wakeExpiry(attempt.id); await markProcessed(event.id); }
  if (event.type === "checkout.session.expired") await wakeExpiry(attempt.id);
}
