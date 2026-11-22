import type { Prisma } from "../generated/prisma/client";
import { db } from "./db";

export async function enqueue(kind: "fulfill" | "expire", targetId: string, availableAt = new Date(), tx: Prisma.TransactionClient = db()) {
  const id = `${kind}:${targetId}`;
  await tx.workItem.upsert({ where: { id }, create: { id, kind, targetId, availableAt }, update: {} });
}
export async function wakeExpiry(targetId: string) {
  await enqueue("expire", targetId);
  await db().workItem.updateMany({ where: { id: `expire:${targetId}`, state: { not: "done" } }, data: { availableAt: new Date() } });
}
