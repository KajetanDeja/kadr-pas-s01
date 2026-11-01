-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "tagline" TEXT NOT NULL,
    "genre" TEXT NOT NULL,
    "duration" INTEGER NOT NULL,
    "ageRating" TEXT NOT NULL,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "hall" TEXT NOT NULL,
    "artwork" TEXT NOT NULL,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventSeat" (
    "eventId" TEXT NOT NULL,
    "seatId" TEXT NOT NULL,
    "currentReservationId" UUID,

    CONSTRAINT "EventSeat_pkey" PRIMARY KEY ("eventId","seatId")
);

-- CreateTable
CREATE TABLE "Reservation" (
    "id" UUID NOT NULL,
    "eventId" TEXT NOT NULL,
    "seatId" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Reservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ticket" (
    "id" UUID NOT NULL,
    "reservationId" UUID NOT NULL,
    "eventId" TEXT NOT NULL,
    "seatId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "purchasedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateLimit" (
    "key" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "RateLimit_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "EventSeat_currentReservationId_key" ON "EventSeat"("currentReservationId");

-- CreateIndex
CREATE INDEX "Reservation_eventId_seatId_expiresAt_idx" ON "Reservation"("eventId", "seatId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Reservation_id_eventId_seatId_key" ON "Reservation"("id", "eventId", "seatId");

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_reservationId_key" ON "Ticket"("reservationId");

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_code_key" ON "Ticket"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_reservationId_eventId_seatId_key" ON "Ticket"("reservationId", "eventId", "seatId");

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_eventId_seatId_key" ON "Ticket"("eventId", "seatId");

-- CreateIndex
CREATE INDEX "RateLimit_expiresAt_idx" ON "RateLimit"("expiresAt");

-- AddForeignKey
ALTER TABLE "EventSeat" ADD CONSTRAINT "EventSeat_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventSeat" ADD CONSTRAINT "EventSeat_currentReservationId_fkey" FOREIGN KEY ("currentReservationId") REFERENCES "Reservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_eventId_seatId_fkey" FOREIGN KEY ("eventId", "seatId") REFERENCES "EventSeat"("eventId", "seatId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_reservationId_eventId_seatId_fkey" FOREIGN KEY ("reservationId", "eventId", "seatId") REFERENCES "Reservation"("id", "eventId", "seatId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Właściciel musi należeć do TEGO SAMEGO fotela i seansu.
ALTER TABLE "EventSeat" ADD CONSTRAINT "EventSeat_owner_matches_seat"
  FOREIGN KEY ("currentReservationId", "eventId", "seatId")
  REFERENCES "Reservation"("id", "eventId", "seatId") ON DELETE RESTRICT;
ALTER TABLE "EventSeat" ADD CONSTRAINT "EventSeat_valid_seat" CHECK ("seatId" ~ '^[A-H]([1-9]|10)$');
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_positive_lifetime" CHECK ("expiresAt" > "createdAt");
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_nonempty_customer" CHECK (length(btrim("customerName")) > 0 AND length(btrim("email")) > 0);
ALTER TABLE "RateLimit" ADD CONSTRAINT "RateLimit_positive_attempts" CHECK ("attempts" > 0);
