import "dotenv/config";
import { pathToFileURL } from "node:url";
import { createDb } from "../src/server/db";
import type { PrismaClient } from "../src/generated/prisma/client";

export async function seed(db: PrismaClient) {
  const events = [
    { id: "orbita", title: "Orbita", tagline: "Najdalej od Ziemi. Najbliżej siebie.", genre: "Science fiction", duration: 118, ageRating: "12+", startsAt: new Date("2026-11-06T17:30:00Z"), hall: "Sala 01", artwork: "orbit" },
    { id: "po-drugiej-stronie", title: "Po drugiej stronie", tagline: "Każda podróż zaczyna się od spotkania.", genre: "Dramat", duration: 104, ageRating: "15+", startsAt: new Date("2026-11-06T18:00:00Z"), hall: "Sala 02", artwork: "city" },
    { id: "ostatnie-swiatlo", title: "Ostatnie światło", tagline: "Są chwile, które zostają na dłużej.", genre: "Thriller", duration: 109, ageRating: "15+", startsAt: new Date("2026-11-06T20:00:00Z"), hall: "Sala 01", artwork: "light" }
  ];
  for (const event of events) {
    // Nie zmieniamy istniejących seansów ani żadnych rezerwacji/biletów.
    await db.event.upsert({ where: { id: event.id }, create: event, update: {} });
    await db.eventSeat.createMany({ data: Array.from("ABCDEFGH").flatMap((row) => Array.from({ length: 10 }, (_, i) => ({ eventId: event.id, seatId: `${row}${i + 1}` }))), skipDuplicates: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = createDb(process.env.DATABASE_URL!);
  try { await seed(db); console.log("Seed: 3 seanse, 2 sale, 240 foteli. Istniejące dane zachowane."); }
  finally { await db.$disconnect(); }
}
