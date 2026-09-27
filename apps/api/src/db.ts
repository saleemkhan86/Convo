import { PrismaClient } from "@prisma/client";

let prisma: PrismaClient | undefined;

/**
 * Interactive transactions default to a 5s timeout, which a remote/cloud
 * database can exceed on a cold round-trip (observed on Supabase). Raise the
 * limits so multi-query transactions don't abort under latency.
 */
const transactionOptions = { maxWait: 10_000, timeout: 30_000 };

export function getDb(): PrismaClient {
  if (!prisma) {
    prisma = new PrismaClient({ transactionOptions });
  }
  return prisma;
}

export async function disconnectDb(): Promise<void> {
  await prisma?.$disconnect();
  prisma = undefined;
}
