import "dotenv/config";
import { defineConfig } from "prisma/config";
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations", seed: "tsx prisma/seed.ts" },
  // CLI i migracje korzystają z bezpośredniego URL-a; aplikacja preferuje pooler.
  datasource: { url: process.env.DATABASE_URL ?? "postgresql://unused:unused@localhost:5432/unused" }
});
