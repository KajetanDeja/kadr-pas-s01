import { createHash } from "node:crypto";
import { z } from "zod";
import { db } from "./db";
import { ApiError } from "./errors";
import { customerEmail } from "./validation";
import { balanceSchema, loyaltyConfig, loyaltyUnavailable, memberSchema, transactionSchema, voucherify, VoucherifyError } from "./voucherify";

const encoded = encodeURIComponent;
const inProgress = () => new ApiError(409, "LOYALTY_PROCESSING", "Trwa rozliczanie punktów tego klienta. Spróbuj ponownie za chwilę.");

// Only this dedicated advisory transaction spans the network. Seat transactions
// never do. Journal writes use separate, committed transactions so a crash cannot
// roll back the knowledge that a request may already have reached the provider.
async function withCustomer<T>(email: string, action: () => Promise<T>) {
  try {
    return await db().$transaction(async tx => {
      const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtextextended(${email}, 731)) AS locked`;
      if (!lock.locked) throw inProgress();
      return action();
    }, { maxWait: 10000, timeout: 55000 });
  } catch (e) {
    if (e instanceof VoucherifyError) {
      if (e.retryAfter) throw new ApiError(503, "LOYALTY_RATE_LIMIT", "Usługa punktowa osiągnęła limit wywołań. Spróbuj później.", { "Retry-After": String(e.retryAfter) });
      throw loyaltyUnavailable();
    }
    throw e;
  }
}

async function member(email: string) {
  const { campaign } = loyaltyConfig();
  let account = await db().loyaltyAccount.upsert({ where: { email }, create: { email }, update: {} });
  if (!account.memberId) {
    const list = await voucherify(`loyalties/${encoded(campaign)}/members?${new URLSearchParams({ customer: email, limit: "2" })}`, z.object({ vouchers: z.array(memberSchema) }));
    if (list.vouchers.length > 1) throw new ApiError(503, "LOYALTY_AMBIGUOUS", "Konto punktowe wymaga sprawdzenia przez obsługę kina.");
    let card = list.vouchers[0];
    if (!card) {
      // A previous creation with a lost response must be reconciled, never blindly
      // repeated: publication source_id is a tracking field, not idempotency.
      if (account.state === "creating") throw loyaltyUnavailable();
      account = await db().loyaltyAccount.update({ where: { email }, data: { state: "creating", welcomeRequired: true } });
      try {
        card = await voucherify(`loyalties/${encoded(campaign)}/members`, memberSchema, {
          customer: { source_id: email, email }, source_id: `kadr:member:${createHash("sha256").update(email).digest("hex")}`
        });
      } catch (e) {
        if (e instanceof ApiError || (e instanceof VoucherifyError && e.status >= 400 && e.status < 500)) await db().loyaltyAccount.update({ where: { email }, data: { state: "new" } });
        throw e;
      }
    }
    if (card.campaign_id !== campaign || !card.active) throw loyaltyUnavailable();
    account = await db().loyaltyAccount.update({ where: { email }, data: { memberId: card.code, state: "ready" } });
  }
  if (!account.memberId) throw loyaltyUnavailable();
  if (account.welcomeRequired) {
    const key = `welcome:${campaign}:${createHash("sha256").update(email).digest("hex")}`;
    await adjust(email, account.memberId, key, 1000);
    await db().loyaltyAccount.update({ where: { email }, data: { welcomeRequired: false } });
  }
  return account.memberId;
}

async function reconcile(id: string, memberId: string, points: number) {
  let cursor = "";
  // Bounded scans protect the hourly Sandbox quota; an old ambiguous operation
  // remains pending for operator reconciliation instead of changing points twice.
  for (let page = 0; page < 5; page++) {
    const query = new URLSearchParams({ limit: "100", order: "-id", ...(cursor ? { starting_after_id: cursor } : {}) });
    const list = await voucherify(`loyalties/members/${encoded(memberId)}/transactions?${query}`, transactionSchema);
    const matches = list.data.filter(t => t.source_id === id);
    if (matches.length === 1 && matches[0].details.balance.points === points) {
      await db().loyaltyOperation.update({ where: { id }, data: { state: "applied" } });
      return;
    }
    if (matches.length) throw new ApiError(503, "LOYALTY_REVIEW", "Operacja punktowa wymaga sprawdzenia przez obsługę kina.");
    if (!list.has_more || !list.more_starting_after) break;
    cursor = list.more_starting_after;
  }
  throw new ApiError(503, "LOYALTY_RECONCILING", "Czekamy na potwierdzenie operacji punktowej. Spróbuj ponownie później.");
}

async function adjust(email: string, memberId: string, id: string, points: number) {
  const operation = await db().loyaltyOperation.upsert({ where: { id }, create: { id, email, points }, update: {} });
  if (operation.email !== email || operation.points !== points) throw new Error("LoyaltyOperationMismatch");
  if (operation.state === "applied") return;
  if (["sending", "uncertain"].includes(operation.state)) return reconcile(id, memberId, points);
  const other = await db().loyaltyOperation.findFirst({ where: { email, state: { in: ["sending", "uncertain"] }, id: { not: id } } });
  if (other) await reconcile(other.id, memberId, other.points);
  if (points < 0) {
    const card = await voucherify(`loyalties/members/${encoded(memberId)}`, memberSchema);
    if (!card.active || card.campaign_id !== loyaltyConfig().campaign) throw loyaltyUnavailable();
    if (card.loyalty_card.balance < -points) throw new ApiError(409, "INSUFFICIENT_POINTS", "Masz za mało punktów. Zmniejsz liczbę punktów lub zapłać kartą.");
  }
  await db().loyaltyOperation.update({ where: { id }, data: { state: "sending", sentAt: new Date() } });
  try {
    const result = await voucherify(`loyalties/members/${encoded(memberId)}/balance`, balanceSchema, { points, source_id: id, reason: "KADR purchase" });
    if (result.points !== points) throw new VoucherifyError(0, "points_mismatch");
    await db().loyaltyOperation.update({ where: { id }, data: { state: "applied" } });
  } catch (e) {
    // A definite 4xx means no mutation; timeouts, malformed responses and 5xx
    // are ambiguous and can only be resolved through transaction history.
    const refused = e instanceof VoucherifyError && e.status >= 400 && e.status < 500;
    await db().loyaltyOperation.update({ where: { id }, data: { state: refused || e instanceof ApiError ? "pending" : "uncertain" } });
    if (e instanceof VoucherifyError && points < 0 && /insufficient|not_enough|balance/.test(e.key) && e.status === 400) throw new ApiError(409, "INSUFFICIENT_POINTS", "Saldo punktów zmieniło się. Sprawdź je ponownie.");
    throw e;
  }
}

export async function getLoyalty(rawEmail: string) {
  const parsed = customerEmail.safeParse(rawEmail);
  if (!parsed.success) throw new ApiError(400, "INVALID_EMAIL", "Podaj poprawny adres e-mail.");
  const email = parsed.data;
  return withCustomer(email, async () => {
    const id = await member(email);
    const card = await voucherify(`loyalties/members/${encoded(id)}`, memberSchema);
    if (!card.active || card.campaign_id !== loyaltyConfig().campaign) throw loyaltyUnavailable();
    return { email, points: card.loyalty_card.balance };
  });
}

export async function changePoints(email: string, id: string, points: number) {
  return withCustomer(email, async () => adjust(email, await member(email), id, points));
}

export async function debitPoints(attemptId: string) {
  const a = await db().paymentAttempt.findUniqueOrThrow({ where: { id: attemptId }, include: { reservation: true } });
  if (!a.pointsUsed) return;
  await withCustomer(a.reservation.email, async () => {
    const fresh = await db().paymentAttempt.findUniqueOrThrow({ where: { id: a.id } });
    if (fresh.pointsState === "debited") return;
    if (fresh.pointsState === "released") throw new ApiError(409, "POINTS_RELEASED", "Ta próba płatności została zakończona.");
    await adjust(a.reservation.email, await member(a.reservation.email), `debit:${a.id}`, -a.pointsUsed);
    await db().paymentAttempt.update({ where: { id: a.id }, data: { pointsState: "debited" } });
  });
}

export async function releasePoints(attemptId: string) {
  const a = await db().paymentAttempt.findUniqueOrThrow({ where: { id: attemptId }, include: { reservation: true } });
  if (!a.pointsUsed) return;
  await withCustomer(a.reservation.email, async () => {
    const fresh = await db().paymentAttempt.findUniqueOrThrow({ where: { id: a.id } });
    if (fresh.pointsState === "released") return;
    const debit = await db().loyaltyOperation.findUnique({ where: { id: `debit:${a.id}` } });
    const memberId = debit ? await member(a.reservation.email) : null;
    if (debit && memberId && ["sending", "uncertain"].includes(debit.state)) await reconcile(debit.id, memberId, debit.points);
    const applied = await db().loyaltyOperation.findUnique({ where: { id: `debit:${a.id}` } });
    if (applied?.state === "applied" && memberId) await adjust(a.reservation.email, memberId, `release:${a.id}`, a.pointsUsed);
    await db().paymentAttempt.update({ where: { id: a.id }, data: { pointsState: "released" } });
  });
}
