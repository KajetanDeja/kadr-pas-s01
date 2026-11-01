import { createDb } from "../src/server/db";
import { setTimeout as sleep } from "node:timers/promises";
import assert from "node:assert/strict";

if (!process.env.DATABASE_URL || !new URL(process.env.DATABASE_URL).pathname.endsWith("_test")) throw new Error("Odmowa: to nie jest baza testowa.");
export const db = createDb(process.env.DATABASE_URL);
export const base = process.env.TEST_BASE_URL!;
export const second = process.env.TEST_SECOND_URL ?? base;
export const headers = (ip = "192.0.2.1") => ({
  "Content-Type": "application/json", "x-kadr-proxy-secret": process.env.TRUSTED_PROXY_SECRET!, "x-kadr-client-ip": ip
});
export const input = (seatId = "F7", email = "ola@example.com", eventId = "orbita") => ({ eventId, seatId, customerName: "Aleksandra", email });
export async function request(path: string, body?: unknown, ip?: string, server = base) {
  const response = await fetch(server + path, body === undefined ? { cache: "no-store" } : { method: "POST", headers: headers(ip), body: JSON.stringify(body) });
  const data = await response.json();
  return { response, data, status: response.status };
}
export const reserve = (data = input(), ip?: string, server = base) => request("/api/reservations", data, ip, server);
export const buy = (id: string, server = base) => request(`/api/reservations/${id}/purchase`, {}, undefined, server);
export async function reset() {
  await db.ticket.deleteMany();
  await db.eventSeat.updateMany({ data: { currentReservationId: null } });
  await db.reservation.deleteMany();
  await db.rateLimit.deleteMany();
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
