import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import { db } from "./db";
import { ApiError } from "./errors";
import { earnedPoints } from "../lib/loyalty";
import { changePoints, releasePoints } from "./loyalty";
import { sendTicket } from "./mail";
import { processStripeEvent } from "./payments";
import { stripe, stripeCall } from "./stripe";

async function fulfill(id: string) {
  const r = await db().reservation.findUniqueOrThrow({ where: { id }, include: { ticket: true } });
  if (!r.ticket) return;
  if (r.loyaltyStatus === "pending") {
    const points = earnedPoints(r.amount - r.pointsUsed);
    if (points) await changePoints(r.email, `earn:${id}`, points);
    await db().reservation.update({ where: { id }, data: { pointsEarned: points, loyaltyStatus: "complete" } });
  }
  await sendTicket(id);
}

async function expire(id: string) {
  let a = await db().paymentAttempt.findUniqueOrThrow({ where: { id }, include: { reservation: { include: { ticket: true } } } });
  if (a.state === "paid") return;
  if (a.state !== "refunded" && a.state !== "refund_pending") {
    const client = stripe();
    // Close the idempotent session even when a debit is still racing cleanup.
    // Any late Checkout creation will then receive this same expired session.
    {
      let session = await stripeCall(() => a.sessionId ? client.checkout.sessions.retrieve(a.sessionId) : client.checkout.sessions.create(a.request as unknown as Stripe.Checkout.SessionCreateParams, { idempotencyKey: `checkout:${id}` }));
      await db().paymentAttempt.update({ where: { id }, data: { sessionId: session.id } });
      if (session.status === "open") {
        try { session = await stripeCall(() => client.checkout.sessions.expire(session.id)); }
        catch { session = await stripeCall(() => client.checkout.sessions.retrieve(session.id)); if (session.status === "open") throw new ApiError(503, "CHECKOUT_STILL_OPEN", "Trwa zamykanie płatności."); }
      }
      if (session.status === "complete" && session.payment_status === "paid") {
        await processStripeEvent({ id: `reconcile:${session.id}`, object: "event", api_version: null, created: Math.floor(Date.now() / 1000), pending_webhooks: 0, request: null, livemode: false, type: "checkout.session.completed", data: { object: session } } as Stripe.Event);
        a = await db().paymentAttempt.findUniqueOrThrow({ where: { id }, include: { reservation: { include: { ticket: true } } } });
        if (a.state === "paid") return;
      } else if (session.status !== "expired") throw new ApiError(503, "PAYMENT_PROCESSING", "Trwa sprawdzanie płatności.");
    }
  }
  await releasePoints(id);
  await db().paymentAttempt.updateMany({ where: { id, state: { in: ["creating", "open"] } }, data: { state: "expired" } });
}

export async function runJobs(limit = 5, reservationId?: string) {
  let completed = 0, retried = 0;
  for (let i = 0; i < limit; i++) {
    const token = randomUUID();
    const claimed = await db().$queryRaw<{ id: string; kind: string; targetId: string; attempts: number }[]>`
      UPDATE "WorkItem" SET state = 'running', token = ${token}, "leaseUntil" = clock_timestamp() + interval '2 minutes', attempts = attempts + 1
      WHERE id = (SELECT id FROM "WorkItem" WHERE
        ((state = 'pending' AND "availableAt" <= clock_timestamp()) OR (state = 'running' AND "leaseUntil" < clock_timestamp()))
        AND (${reservationId ?? null}::uuid IS NULL OR "targetId" = ${reservationId ?? null}::uuid)
        ORDER BY "availableAt", id FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING id, kind, "targetId", attempts`;
    const job = claimed[0];
    if (!job) break;
    try {
      if (job.kind === "fulfill") await fulfill(job.targetId); else await expire(job.targetId);
      await db().workItem.updateMany({ where: { id: job.id, token }, data: { state: "done", token: null, leaseUntil: null, lastError: null } });
      completed++;
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "SERVICE_UNAVAILABLE";
      const delay = Math.max(Math.min(3600, 10 * 2 ** Math.min(job.attempts, 9)), e instanceof ApiError ? Number(e.headers?.["Retry-After"] ?? 0) : 0);
      await db().workItem.updateMany({ where: { id: job.id, token }, data: { state: code === "MAIL_REVIEW" ? "review" : "pending", token: null, leaseUntil: null, lastError: code, availableAt: new Date(Date.now() + delay * 1000) } });
      console.error("KADR: zadanie odłożone", job.id, code);
      retried++;
    }
  }
  return { completed, retried };
}
