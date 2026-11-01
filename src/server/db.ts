import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import { config } from "./config";

const globalDb = globalThis as unknown as { kadrDb?: PrismaClient };
export function createDb(url: string) {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 12, connectionTimeoutMillis: 10000 }) });
}
export function db() {
  if (!globalDb.kadrDb) {
    const settings = config();
    globalDb.kadrDb = createDb(settings.DATABASE_URL_POOLED ?? settings.DATABASE_URL);
  }
  return globalDb.kadrDb;
}
