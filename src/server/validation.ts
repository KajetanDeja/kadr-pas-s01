import { createHash } from "node:crypto";
import { z } from "zod";
export const reservationInput = z.object({
  eventId: z.string().trim().min(1).max(100),
  seatId: z.string().trim().max(10).regex(/^[A-H](?:[1-9]|10)$/),
  customerName: z.string().max(160).transform((s) => s.normalize("NFC").trim().replace(/\s+/g, " ")).pipe(z.string().min(1).max(100)),
  email: z.string().trim().max(254).toLowerCase().pipe(z.email())
}).strict();
export type ReservationInput = z.infer<typeof reservationInput>;
export const reservationId = z.uuid();
export function fingerprint(input: ReservationInput) {
  return createHash("sha256").update(JSON.stringify([input.eventId, input.seatId, input.customerName, input.email])).digest("hex");
}
