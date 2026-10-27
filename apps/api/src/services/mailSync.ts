import type { PrismaClient } from "@prisma/client";
import type { Config } from "../config.js";
import {
  createMailTokenCipher,
  createMailboxProviders,
} from "../mail/index.js";
import { getValidAccessToken, markConnectionNeedsReauth } from "../mail/tokenStore.js";
import { fetchMailSyncPage, initialSyncOptions } from "../mail/sync.js";
import { MailboxProviderError } from "../mail/providers/types.js";
import { sendMailWithProvider, retryDelayMs, isRetryableSendError } from "../mail/send.js";
import { normalizeEmailBody } from "../mail/parser.js";

export interface MailSyncDeps {
  db: PrismaClient;
  config: Config;
}

/**
 * Background worker that polls mail connections and runs incremental sync.
 * Uses advisory locks to prevent concurrent syncs across processes.
 */
export async function runMailSyncWorker(deps: MailSyncDeps): Promise<void> {
  const cipher = createMailTokenCipher(deps.config);
  const providers = createMailboxProviders(deps.config);

  // Find connections that need syncing (not synced in last 5 minutes).
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000);
  const connections = await deps.db.mailConnection.findMany({
    where: {
      status: "CONNECTED",
      OR: [
        { lastSyncedAt: null },
        { lastSyncedAt: { lt: fiveMinutesAgo } },
      ],
    },
    take: 10, // Process up to 10 connections per sweep.
  });

  for (const connection of connections) {
    try {
      // Try to acquire an advisory lock for this connection.
      const lockKey = connectionLockKey(connection.id);
      const locked = await tryAdvisoryLock(deps.db, lockKey);
      if (!locked) continue; // Another process is syncing this connection.

      try {
        await syncConnection(deps, connection, cipher, providers);
      } finally {
        await releaseAdvisoryLock(deps.db, lockKey);
      }
    } catch (error) {
      deps.db.$executeRawUnsafe(
        `UPDATE "MailConnection" SET "lastSyncError" = $1 WHERE "id" = $2`,
        error instanceof Error ? error.message.slice(0, 1000) : "Unknown error",
        connection.id,
      ).catch(() => {});
    }
  }
}

async function syncConnection(
  deps: MailSyncDeps,
  connection: { id: string; provider: "GOOGLE" | "MICROSOFT"; syncCursor: string | null },
  cipher: ReturnType<typeof createMailTokenCipher>,
  providers: ReturnType<typeof createMailboxProviders>,
): Promise<void> {
  const { accessToken } = await getValidAccessToken(
    { db: deps.db, cipher, providers },
    connection.id,
  );

  const provider = providers[connection.provider];
  if (!provider) {
    throw new Error(`Provider ${connection.provider} not configured`);
  }

  const syncOptions = initialSyncOptions({
    sinceDays: deps.config.MAIL_SYNC_INITIAL_DAYS,
    pageSize: deps.config.MAIL_SYNC_PAGE_SIZE,
    concurrency: deps.config.MAIL_SYNC_CONCURRENCY,
  });

  const result = await fetchMailSyncPage({
    provider,
    accessToken,
    cursor: connection.syncCursor,
    options: syncOptions,
  });

  // Update connection with new cursor and sync timestamp.
  await deps.db.mailConnection.update({
    where: { id: connection.id },
    data: {
      syncCursor: result.cursor,
      syncCursorAt: new Date(),
      lastSyncedAt: new Date(),
      initialSyncDone: true,
      lastSyncError: null,
    },
  });

  // TODO: Process synced messages — create EmailThread/EmailMessage rows,
  // normalize bodies, notify users via realtime hub. This is Phase 3.2.
  // For now, we just update the cursor.

  if (result.page.messages.length > 0) {
    console.log(
      `[mailSync] Synced ${result.page.messages.length} messages for connection ${connection.id}`,
    );
  }
}

/**
 * Background worker that drains the MailSendJob outbox.
 * Processes pending jobs with exponential backoff on failure.
 */
export async function runMailOutboxWorker(deps: MailSyncDeps): Promise<void> {
  const cipher = createMailTokenCipher(deps.config);
  const providers = createMailboxProviders(deps.config);

  // Find pending jobs that are ready to retry.
  const now = new Date();
  const jobs = await deps.db.mailSendJob.findMany({
    where: {
      status: "PENDING",
      nextAttemptAt: { lte: now },
    },
    include: {
      emailMessage: {
        include: {
          thread: true,
          recipients: true,
        },
      },
    },
    take: 5, // Process up to 5 jobs per sweep.
    orderBy: { nextAttemptAt: "asc" },
  });

  for (const job of jobs) {
    try {
      // Try to acquire an advisory lock for this job.
      const lockKey = jobLockKey(job.id);
      const locked = await tryAdvisoryLock(deps.db, lockKey);
      if (!locked) continue;

      try {
        await processSendJob(deps, job, cipher, providers);
      } finally {
        await releaseAdvisoryLock(deps.db, lockKey);
      }
    } catch (error) {
      // Job failed; schedule retry or mark as failed.
      const attempts = job.attempts + 1;
      const maxAttempts = 5;

      if (attempts >= maxAttempts || !isRetryableSendError(error)) {
        await deps.db.mailSendJob.update({
          where: { id: job.id },
          data: {
            status: "FAILED",
            attempts,
            lastError: error instanceof Error ? error.message.slice(0, 1000) : "Unknown error",
          },
        });
      } else {
        const delayMs = retryDelayMs(attempts);
        await deps.db.mailSendJob.update({
          where: { id: job.id },
          data: {
            attempts,
            nextAttemptAt: new Date(Date.now() + delayMs),
            lastError: error instanceof Error ? error.message.slice(0, 1000) : "Unknown error",
          },
        });
      }
    }
  }
}

async function processSendJob(
  deps: MailSyncDeps,
  job: {
    id: string;
    emailMessageId: string;
    emailMessage: {
      id: string;
      threadId: string;
      ownerId: string;
      fromAddress: string;
      subject: string | null;
      bodyText: string | null;
      bodyHtml: string | null;
      provider: "GOOGLE" | "MICROSOFT" | null;
      providerThreadId: string | null;
      recipients: { address: string; recipientType: "TO" | "CC" | "BCC" }[];
    };
  },
  cipher: ReturnType<typeof createMailTokenCipher>,
  providers: ReturnType<typeof createMailboxProviders>,
): Promise<void> {
  const message = job.emailMessage;
  if (!message.provider) {
    throw new Error("Message has no provider");
  }

  // Find the connection for this message's owner.
  const connection = await deps.db.mailConnection.findFirst({
    where: {
      emailIdentity: { userId: message.ownerId },
      provider: message.provider,
    },
  });

  if (!connection) {
    throw new Error(`No connection found for user ${message.ownerId}`);
  }

  const { accessToken } = await getValidAccessToken(
    { db: deps.db, cipher, providers },
    connection.id,
  );

  const provider = providers[connection.provider];
  if (!provider) {
    throw new Error(`Provider ${connection.provider} not configured`);
  }

  // Build outgoing mail.
  const to = message.recipients.filter((r) => r.recipientType === "TO").map((r) => ({ address: r.address }));
  const cc = message.recipients.filter((r) => r.recipientType === "CC").map((r) => ({ address: r.address }));
  const bcc = message.recipients.filter((r) => r.recipientType === "BCC").map((r) => ({ address: r.address }));

  const receipt = await sendMailWithProvider({
    provider,
    accessToken,
    message: {
      from: { address: connection.emailAddress, name: connection.displayName ?? undefined },
      to,
      cc: cc.length > 0 ? cc : undefined,
      bcc: bcc.length > 0 ? bcc : undefined,
      subject: message.subject ?? "",
      text: message.bodyText ?? "",
      html: message.bodyHtml ?? undefined,
      threadId: message.providerThreadId ?? undefined,
    },
  });

  // Mark job as sent.
  await deps.db.mailSendJob.update({
    where: { id: job.id },
    data: {
      status: "SENT",
      lastError: null,
    },
  });

  // Update message with provider IDs.
  await deps.db.emailMessage.update({
    where: { id: message.id },
    data: {
      providerMessageId: receipt.providerMessageId,
      providerThreadId: receipt.providerThreadId,
      status: "SENT",
      sentAt: new Date(),
    },
  });

  console.log(`[mailOutbox] Sent message ${message.id} via ${connection.provider}`);
}

/**
 * Generates a stable advisory lock key for a connection ID.
 * Postgres advisory locks use bigint keys; we hash the connection ID.
 */
function connectionLockKey(connectionId: string): bigint {
  // Simple hash: take first 8 chars of connection ID as hex.
  const hex = connectionId.slice(0, 8).padEnd(8, "0");
  return BigInt("0x" + hex);
}

function jobLockKey(jobId: string): bigint {
  const hex = jobId.slice(0, 8).padEnd(8, "0");
  return BigInt("0x" + hex);
}

/**
 * Attempts to acquire a session-level advisory lock. Returns true if acquired.
 * Advisory locks are released when the session ends or explicitly released.
 */
async function tryAdvisoryLock(db: PrismaClient, key: bigint): Promise<boolean> {
  const result = await db.$queryRawUnsafe<{ pg_try_advisory_lock: boolean }[]>(
    `SELECT pg_try_advisory_lock($1)`,
    key,
  );
  return result[0]?.pg_try_advisory_lock ?? false;
}

async function releaseAdvisoryLock(db: PrismaClient, key: bigint): Promise<void> {
  await db.$queryRawUnsafe(`SELECT pg_advisory_unlock($1)`, key);
}
