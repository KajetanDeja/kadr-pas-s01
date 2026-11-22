import { createHash } from "node:crypto";
import { z } from "zod";
export const customerEmail = z.string().trim().max(254).toLowerCase().pipe(z.email());
// Other fields (e.g. an amount from an old client) remain ignored, as in stage II.
export const checkoutInput = z.object({ points: z.number().int().nonnegative().max(2147483647).optional() });
export const reservationInput = z.object({
  eventId: z.string().trim().min(1).max(100),
  seatId: z.string().trim().max(10).regex(/^[A-H](?:[1-9]|10)$/),
  customerName: z.string().max(160).transform((s) => s.normalize("NFC").trim().replace(/\s+/g, " ")).pipe(z.string().min(1).max(100)),
  email: customerEmail
}).strict();
export type ReservationInput = z.infer<typeof reservationInput>;
export const reservationId = z.uuid();
export function fingerprint(input: ReservationInput) {
  return createHash("sha256").update(JSON.stringify([input.eventId, input.seatId, input.customerName, input.email])).digest("hex");
}
