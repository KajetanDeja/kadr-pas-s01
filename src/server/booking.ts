import { randomUUID } from "node:crypto";
import type { Prisma } from "../generated/prisma/client";
import { config } from "./config";
import { db } from "./db";
import { ApiError } from "./errors";
import { fingerprint, type ReservationInput } from "./validation";

type Tx = Prisma.TransactionClient;
export async function databaseNow(tx: Tx = db()) {
  const [row] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  return row.now;
}
export async function lockSeat(tx: Tx, eventId: string, seatId: string) {
  const seats = await tx.$queryRaw<{ currentReservationId: string | null }[]>`
    SELECT "currentReservationId" FROM "EventSeat"
    WHERE "eventId" = ${eventId} AND "seatId" = ${seatId} FOR UPDATE
  `;
  if (!seats[0]) throw new ApiError(404, "SEAT_NOT_FOUND", "Nie znaleziono seansu lub fotela.");
  return seats[0];
}
export const transactionOptions = { maxWait: 10000, timeout: 15000 };

export async function reserve(input: ReservationInput) {
  const ttl = config().RESERVATION_TTL_SECONDS;
  const identity = fingerprint(input);
  return db().$transaction(async (tx) => {
    const seat = await lockSeat(tx, input.eventId, input.seatId);
    // clock_timestamp(), nie transaction_timestamp(): czas liczony PO oczekiwaniu na blokadę.
    const now = await databaseNow(tx);
    if (seat.currentReservationId) {
      const current = await tx.reservation.findUniqueOrThrow({ where: { id: seat.currentReservationId }, include: { ticket: true } });
      if (current.ticket || current.expiresAt > now) {
        if (current.fingerprint === identity) return { reservationId: current.id, expiresAt: current.expiresAt.toISOString(), amount: current.amount, serverNow: now };
        throw new ApiError(409, "SEAT_TAKEN", "Ktoś właśnie zajął ten fotel. Wybierz inne miejsce.");
      }
    }
    const event = await tx.event.findUniqueOrThrow({ where: { id: input.eventId } });
    const reservation = await tx.reservation.create({ data: {
      ...input, id: randomUUID(), fingerprint: identity, amount: event.price, createdAt: now, expiresAt: new Date(now.getTime() + ttl * 1000)
    } });
    await tx.eventSeat.update({ where: { eventId_seatId: { eventId: input.eventId, seatId: input.seatId } }, data: { currentReservationId: reservation.id } });
    return { reservationId: reservation.id, expiresAt: reservation.expiresAt.toISOString(), amount: reservation.amount, serverNow: now };
  }, transactionOptions);
}

export async function purchase(id: string) {
  return db().$transaction(async (tx) => {
    const original = await tx.reservation.findUnique({ where: { id } });
    if (!original) throw new ApiError(404, "RESERVATION_NOT_FOUND", "Nie znaleziono rezerwacji.");
    const seat = await lockSeat(tx, original.eventId, original.seatId);
    const now = await databaseNow(tx);
    const existing = await tx.ticket.findUnique({ where: { reservationId: id } });
    // Zakupione bilety pozostają idempotentne bez względu na pierwotny expiresAt.
    if (existing) return { code: existing.code, serverNow: now };
    if (seat.currentReservationId !== id || original.expiresAt <= now) throw new ApiError(410, "RESERVATION_EXPIRED", "Rezerwacja wygasła, fotel wrócił do puli");
    throw new ApiError(402, "PAYMENT_REQUIRED", "Opłać rezerwację kartą przez Stripe.");
  }, transactionOptions);
}

export async function getEvent(id: string) {
  const event = await db().event.findUnique({ where: { id } });
  if (!event) throw new ApiError(404, "EVENT_NOT_FOUND", "Nie znaleziono seansu.");
  const seats = await db().$queryRaw<{ seatId: string }[]>`
    SELECT s."seatId" FROM "EventSeat" s
    JOIN "Reservation" r ON r.id = s."currentReservationId"
    LEFT JOIN "Ticket" t ON t."reservationId" = r.id
    WHERE s."eventId" = ${id} AND (t.id IS NOT NULL OR r."expiresAt" > clock_timestamp())
    ORDER BY s."seatId"
  `;
  return { event, takenSeats: seats.map((s) => s.seatId) };
}

export async function getReservation(id: string) {
  const r = await db().reservation.findUnique({ where: { id }, include: { event: true, ticket: true, ownedSeat: true, payments: { orderBy: { generation: "desc" } } } });
  if (!r) throw new ApiError(404, "RESERVATION_NOT_FOUND", "Nie znaleziono rezerwacji.");
  const now = await databaseNow();
  const delivery = r.ticket ? await db().delivery.findUnique({ where: { reservationId: id } }) : null;
  const refund = r.payments.find(p => p.refundStatus);
  return {
    reservationId: r.id, event: r.event, seatId: r.seatId, expiresAt: r.expiresAt.toISOString(),
    amount: r.amount,
    pointsUsed: r.pointsUsed, ...(r.ticket ? { pointsEarned: r.pointsEarned } : {}),
    cardAmount: r.amount - r.pointsUsed, loyaltyStatus: r.loyaltyStatus,
    checkoutLocked: r.payments.some(p => ["creating", "open"].includes(p.state)),
    emailStatus: delivery?.state ?? "none",
    status: r.ticket ? "paid" : r.ownedSeat && r.expiresAt > now ? "held" : "expired",
    ...(r.ticket ? { code: r.ticket.code } : {}),
    ...(refund ? { refundStatus: refund.refundStatus } : {}), serverNow: now.toISOString()
  };
}
