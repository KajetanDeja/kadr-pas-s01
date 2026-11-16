ALTER TABLE "Event" ADD COLUMN "price" INTEGER NOT NULL DEFAULT 3200;
ALTER TABLE "Event" ALTER COLUMN "price" DROP DEFAULT;
ALTER TABLE "Event" ADD CONSTRAINT "Event_positive_price" CHECK ("price" > 0);
ALTER TABLE "Reservation" ADD COLUMN "amount" INTEGER;
UPDATE "Reservation" r SET "amount" = e."price" FROM "Event" e WHERE r."eventId" = e.id;
ALTER TABLE "Reservation" ALTER COLUMN "amount" SET NOT NULL;
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_positive_amount" CHECK ("amount" > 0);

-- Kwota rezerwacji jest historyczną ceną i nie może zostać zmieniona.
CREATE FUNCTION protect_reservation_amount() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."amount" IS DISTINCT FROM OLD."amount" THEN
    RAISE EXCEPTION 'Reservation amount is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Reservation_immutable_amount" BEFORE UPDATE ON "Reservation"
FOR EACH ROW EXECUTE FUNCTION protect_reservation_amount();

CREATE TABLE "PaymentAttempt" (
  "id" UUID PRIMARY KEY,
  "reservationId" UUID NOT NULL REFERENCES "Reservation"("id") ON DELETE RESTRICT,
  "generation" INTEGER NOT NULL CHECK ("generation" > 0),
  "request" JSONB NOT NULL,
  "sessionId" TEXT UNIQUE,
  "paymentIntentId" TEXT UNIQUE,
  "url" TEXT,
  "state" TEXT NOT NULL DEFAULT 'creating' CHECK ("state" IN ('creating', 'open', 'expired', 'paid', 'refund_pending', 'refunded')),
  "refundId" TEXT UNIQUE,
  "refundStatus" TEXT CHECK ("refundStatus" IN ('pending', 'refunded', 'failed')),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("reservationId", "generation")
);
CREATE TABLE "StripeEvent" (
  "id" TEXT PRIMARY KEY,
  "processedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
