ALTER TABLE "Reservation"
  ADD COLUMN "pointsUsed" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "pointsEarned" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "loyaltyStatus" TEXT NOT NULL DEFAULT 'none',
  ADD CONSTRAINT "Reservation_points" CHECK ("pointsUsed" >= 0 AND "pointsUsed" <= "amount" / 2 AND "pointsEarned" >= 0),
  ADD CONSTRAINT "Reservation_loyalty_status" CHECK ("loyaltyStatus" IN ('none','pending','complete'));
ALTER TABLE "PaymentAttempt"
  ADD COLUMN "pointsUsed" INTEGER NOT NULL DEFAULT 0 CHECK ("pointsUsed" >= 0),
  ADD COLUMN "pointsState" TEXT NOT NULL DEFAULT 'none' CHECK ("pointsState" IN ('none','pending','debited','released')),
  ADD COLUMN "loyaltyEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "LoyaltyAccount" (
  "email" TEXT PRIMARY KEY, "memberId" TEXT UNIQUE,
  "state" TEXT NOT NULL DEFAULT 'new' CHECK ("state" IN ('new','creating','ready')),
  "welcomeRequired" BOOLEAN NOT NULL DEFAULT false
);
CREATE TABLE "LoyaltyOperation" (
  "id" TEXT PRIMARY KEY, "email" TEXT NOT NULL, "points" INTEGER NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'pending' CHECK ("state" IN ('pending','sending','uncertain','applied')),
  "sentAt" TIMESTAMPTZ(3), "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "LoyaltyOperation_email_state_idx" ON "LoyaltyOperation"("email","state");
CREATE TABLE "Delivery" (
  "reservationId" UUID PRIMARY KEY, "providerId" TEXT UNIQUE,
  "state" TEXT NOT NULL DEFAULT 'pending' CHECK ("state" IN ('pending','sending','accepted','delivered','bounced','failed','review')),
  "request" JSONB, "firstSentAt" TIMESTAMPTZ(3), "lastEventAt" TIMESTAMPTZ(3)
);
CREATE TABLE "DeliveryEvent" (
  "id" TEXT PRIMARY KEY, "providerId" TEXT NOT NULL, "state" TEXT NOT NULL, "occurredAt" TIMESTAMPTZ(3) NOT NULL
);
CREATE INDEX "DeliveryEvent_providerId_idx" ON "DeliveryEvent"("providerId");
CREATE TABLE "WorkItem" (
  "id" TEXT PRIMARY KEY, "kind" TEXT NOT NULL CHECK ("kind" IN ('fulfill','expire')),
  "targetId" UUID NOT NULL, "state" TEXT NOT NULL DEFAULT 'pending' CHECK ("state" IN ('pending','running','done','review')),
  "attempts" INTEGER NOT NULL DEFAULT 0, "availableAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseUntil" TIMESTAMPTZ(3), "token" TEXT, "lastError" TEXT
);
CREATE INDEX "WorkItem_state_availableAt_idx" ON "WorkItem"("state","availableAt");
