import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";

const globalDb = globalThis as unknown as { kadrDb?: PrismaClient };
export function createDb(url: string) {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 12, connectionTimeoutMillis: 10000 }) });
}
export function db() {
  if (!globalDb.kadrDb) {
    if (!process.env.DATABASE_URL) throw new Error("Brak DATABASE_URL");
    globalDb.kadrDb = createDb(process.env.DATABASE_URL);
  }
  return globalDb.kadrDb;
}
