import { randomUUID } from "node:crypto";
import type {
  PrismaClient,
  Prisma,
  EmailMessage as PrismaEmailMessage,
  EmailThread as PrismaEmailThread,
} from "@prisma/client";
import type {
  ComposeMailRequest,
  MailDirection,
  MailMessage,
  MailMessagePage,
  MailParticipant,
  MailStatus,
  MailThreadList,
  MailThreadSummary,
  ReplyMailRequest,
  SendMailResult,
} from "@convo/shared";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { resolveMailRoute } from "./mailRouting.js";
import type { RealtimeHub } from "./realtime.js";
import type { NotificationItem } from "@convo/shared";

/**
 * Mail domain (spec §10, §11, §15, §17, §18): chat-style mail with real email
 * semantics. Each account owns its own copy of a thread and its messages; the
 * copies are tied together across mailboxes by a shared `threadKey` and RFC
 * 5322 threading headers.
 *
 * Phase 3 delivers Convo-internal mail. When a recipient has a Convo email
 * identity, the message is mirrored into their mailbox and pushed over the
 * realtime socket. External addresses are accepted and stored as QUEUED for the
 * Phase 4 SMTP gateway; the composer never learns which route an address took.
 */

export interface MailDeps {
  db: PrismaClient;
  hub: RealtimeHub;
  /** Phase 5G: notify each internal recipient about a new mail message. */
  notifyRecipient?: (
    userId: string,
    title: string,
    body: string | null,
    actorId: string | null,
    conversationId: string,
    messageId: string,
  ) => Promise<NotificationItem | null>;
}

const MAIL_DOMAIN = "convo.local";

// A send fans out one thread-upsert + message-create per internal recipient, so
// on a high-latency (e.g. pooled cloud) database the interactive transaction can
// exceed Prisma's 5s default. Give it headroom and a longer pool-acquire wait.
const MAIL_TX_TIMEOUT_MS = 30_000;
const MAIL_TX_MAX_WAIT_MS = 10_000;

type Recipient = Prisma.EmailRecipientGetPayload<Record<string, never>>;
type EmailMessageRow = PrismaEmailMessage & { recipients: Recipient[] };
type ThreadRow = PrismaEmailThread & {
  participants: Prisma.EmailThreadParticipantGetPayload<Record<string, never>>[];
  messages: EmailMessageRow[];
};

interface ResolvedRecipient {
  address: string;
  internal: boolean;
  convoUserId: string | null;
  displayName: string | null;
}

// ────────────────────────────── serialization ──────────────────────────────

function serializeMessage(m: EmailMessageRow): MailMessage {
  return {
    id: m.id,
    threadId: m.threadId,
    direction: m.direction as MailDirection,
    status: m.status as MailStatus,
    fromAddress: m.fromAddress,
    toAddresses: m.recipients.filter((r) => r.recipientType === "TO").map((r) => r.address),
    subject: m.subject,
    bodyText: m.bodyText,
    internetMessageId: m.internetMessageId,
    inReplyTo: m.inReplyTo,
    references: m.references,
    convoMessageId: m.convoMessageId,
    createdAt: m.createdAt.toISOString(),
    sentAt: m.sentAt?.toISOString() ?? null,
    receivedAt: m.receivedAt?.toISOString() ?? null,
  };
}

function serializeThread(thread: ThreadRow, unreadCount: number): MailThreadSummary {
  const participants: MailParticipant[] = thread.participants.map((p) => ({
    address: p.address,
    displayName: p.displayName,
    convoUserId: p.convoUserId,
    isExternal: p.isExternal,
  }));
  const last = thread.messages[0];
  return {
    id: thread.id,
    subject: thread.subject,
    participants,
    lastMessage: last ? serializeMessage(last) : null,
    unreadCount,
    lastActivityAt: thread.lastActivityAt.toISOString(),
    lastReadAt: thread.lastReadAt?.toISOString() ?? null,
  };
}

function countUnread(db: PrismaClient, threadId: string, lastReadAt: Date | null): Promise<number> {
  return db.emailMessage.count({
    where: {
      threadId,
      direction: "INBOUND",
      ...(lastReadAt ? { receivedAt: { gt: lastReadAt } } : {}),
    },
  });
}

async function loadThreadSummary(
  db: PrismaClient,
  ownerId: string,
  threadId: string,
): Promise<MailThreadSummary> {
  const thread = await db.emailThread.findFirst({
    where: { id: threadId, ownerId },
    include: {
      participants: true,
      messages: { include: { recipients: true }, orderBy: { createdAt: "desc" }, take: 1 },
    },
  });
  if (!thread) throw notFound("Thread not found");
  const unread = await countUnread(db, threadId, thread.lastReadAt);
  return serializeThread(thread as unknown as ThreadRow, unread);
}

// ────────────────────────────── capability ──────────────────────────────

async function requireMail(db: PrismaClient, userId: string): Promise<{ email: string; displayName: string | null }> {
  const user = await db.user.findUnique({
    where: { id: userId },
    include: { emailIdentity: true },
  });
  if (!user?.emailIdentity) {
    throw forbidden("Connect an email address to start using Mail");
  }
  return { email: user.emailIdentity.email, displayName: user.displayName };
}

// ────────────────────────────── listing ──────────────────────────────

export async function listThreads(
  { db }: MailDeps,
  userId: string,
  opts: { cursor?: string; limit: number },
): Promise<MailThreadList> {
  await requireMail(db, userId);

  const rows = await db.emailThread.findMany({
    where: { ownerId: userId },
    include: {
      participants: true,
      messages: { include: { recipients: true }, orderBy: { createdAt: "desc" }, take: 1 },
    },
    orderBy: [{ lastActivityAt: "desc" }, { id: "desc" }],
    take: opts.limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > opts.limit;
  const page = hasMore ? rows.slice(0, opts.limit) : rows;

  const threads = await Promise.all(
    page.map(async (t) => {
      const unread = await countUnread(db, t.id, t.lastReadAt);
      return serializeThread(t as unknown as ThreadRow, unread);
    }),
  );

  return { threads, nextCursor: hasMore ? page[page.length - 1]!.id : null };
}

export async function listThreadMessages(
  { db }: MailDeps,
  userId: string,
  threadId: string,
  opts: { cursor?: string; limit: number },
): Promise<MailMessagePage> {
  const thread = await db.emailThread.findFirst({ where: { id: threadId, ownerId: userId } });
  if (!thread) throw notFound("Thread not found");

  const rows = await db.emailMessage.findMany({
    where: { threadId },
    include: { recipients: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: opts.limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > opts.limit;
  const page = hasMore ? rows.slice(0, opts.limit) : rows;
  page.reverse();
  const oldest = rows[rows.length - 1];
  return {
    messages: page.map(serializeMessage),
    nextCursor: hasMore && oldest ? oldest.id : null,
  };
}

export async function markThreadRead(
  { db }: MailDeps,
  userId: string,
  threadId: string,
): Promise<void> {
  const thread = await db.emailThread.findFirst({ where: { id: threadId, ownerId: userId } });
  if (!thread) throw notFound("Thread not found");
  await db.emailThread.update({ where: { id: threadId }, data: { lastReadAt: new Date() } });
}

// ────────────────────────────── recipient resolution ──────────────────────────────

async function resolveRecipients(
  db: PrismaClient,
  selfAddress: string,
  addresses: string[],
): Promise<ResolvedRecipient[]> {
  const unique = [...new Set(addresses.map((a) => a.trim().toLowerCase()))].filter(
    (a) => a && a !== selfAddress,
  );
  const resolved: ResolvedRecipient[] = [];
  const internalIds: string[] = [];
  for (const address of unique) {
    const decision = await resolveMailRoute(db, address);
    const internal = decision.route === "CONVO_INTERNAL" && Boolean(decision.convoUserId);
    resolved.push({
      address,
      internal,
      convoUserId: internal ? decision.convoUserId! : null,
      displayName: null,
    });
    if (internal) internalIds.push(decision.convoUserId!);
  }
  if (internalIds.length > 0) {
    const users = await db.user.findMany({
      where: { id: { in: internalIds } },
      select: { id: true, displayName: true },
    });
    const byId = new Map(users.map((u) => [u.id, u.displayName]));
    for (const r of resolved) {
      if (r.convoUserId) r.displayName = byId.get(r.convoUserId) ?? null;
    }
  }
  return resolved;
}

function participantsFor(
  sender: { address: string; displayName: string | null; userId: string },
  recipients: ResolvedRecipient[],
): Prisma.EmailThreadParticipantCreateManyThreadInput[] {
  const list: Prisma.EmailThreadParticipantCreateManyThreadInput[] = [
    { address: sender.address, displayName: sender.displayName, convoUserId: sender.userId, isExternal: false },
  ];
  for (const r of recipients) {
    list.push({
      address: r.address,
      displayName: r.displayName,
      convoUserId: r.convoUserId,
      isExternal: !r.internal,
    });
  }
  return list;
}

// ────────────────────────────── compose ──────────────────────────────

export async function composeMail(
  deps: MailDeps,
  userId: string,
  input: ComposeMailRequest,
): Promise<SendMailResult> {
  const { db, hub } = deps;
  const sender = await requireMail(db, userId);

  // Idempotency (spec §22): a retried clientSendId returns the original.
  const existing = await db.emailMessage.findFirst({
    where: { ownerId: userId, clientSendId: input.clientSendId },
    include: { recipients: true },
  });
  if (existing) {
    const thread = await loadThreadSummary(db, userId, existing.threadId);
    return { thread, message: serializeMessage(existing) };
  }

  const recipients = await resolveRecipients(db, sender.email, input.to);
  if (recipients.length === 0) {
    throw badRequest("Choose at least one recipient other than yourself");
  }

  const threadKey = randomUUID();
  const internetMessageId = `<${randomUUID()}@${MAIL_DOMAIN}>`;
  const subject = input.subject?.trim() ? input.subject.trim() : null;
  const participants = participantsFor(
    { address: sender.email, displayName: sender.displayName, userId },
    recipients,
  );
  const now = new Date();

  const senderMsgId = await db.$transaction(async (tx) => {
    const senderThread = await ensureThread(tx, userId, threadKey, subject, participants, now);

    const senderMsg = await tx.emailMessage.create({
      data: {
        threadId: senderThread.id,
        ownerId: userId,
        direction: "OUTBOUND",
        status: "SENT",
        internetMessageId,
        references: [],
        fromAddress: sender.email,
        subject,
        bodyText: input.body,
        clientSendId: input.clientSendId,
        sentAt: now,
        recipients: {
          create: recipients.map((r) => ({
            address: r.address,
            recipientType: "TO" as const,
            route: r.internal ? ("CONVO_INTERNAL" as const) : ("EXTERNAL_SMTP" as const),
            status: r.internal ? ("DELIVERED" as const) : ("QUEUED" as const),
          })),
        },
      },
    });

    for (const r of recipients) {
      if (!r.internal || !r.convoUserId) continue;
      await mirrorInbound(tx, {
        ownerId: r.convoUserId,
        threadKey,
        subject,
        participants,
        fromAddress: sender.email,
        bodyText: input.body,
        internetMessageId,
        inReplyTo: null,
        references: [],
        convoMessageId: senderMsg.id,
        now,
      });
    }

    return senderMsg.id;
  }, { timeout: MAIL_TX_TIMEOUT_MS, maxWait: MAIL_TX_MAX_WAIT_MS });

  const message = await db.emailMessage.findUniqueOrThrow({
    where: { id: senderMsgId },
    include: { recipients: true },
  });
  const thread = await loadThreadSummary(db, userId, message.threadId);

  await fanOutNewMail(db, hub, threadKey, recipients, deps.notifyRecipient);

  return { thread, message: serializeMessage(message) };
}

// ────────────────────────────── reply ──────────────────────────────

export async function replyToThread(
  deps: MailDeps,
  userId: string,
  threadId: string,
  input: ReplyMailRequest,
): Promise<SendMailResult> {
  const { db, hub } = deps;
  const sender = await requireMail(db, userId);

  const own = await db.emailThread.findFirst({
    where: { id: threadId, ownerId: userId },
    include: { participants: true },
  });
  if (!own) throw notFound("Thread not found");

  const existing = await db.emailMessage.findFirst({
    where: { ownerId: userId, clientSendId: input.clientSendId },
    include: { recipients: true },
  });
  if (existing) {
    const thread = await loadThreadSummary(db, userId, existing.threadId);
    return { thread, message: serializeMessage(existing) };
  }

  // Thread the reply off the most recent message that carries a Message-ID.
  const parent = await db.emailMessage.findFirst({
    where: { threadId, internetMessageId: { not: null } },
    orderBy: { createdAt: "desc" },
  });
  const internetMessageId = `<${randomUUID()}@${MAIL_DOMAIN}>`;
  const inReplyTo = parent?.internetMessageId ?? null;
  const references = parent
    ? [...parent.references, ...(parent.internetMessageId ? [parent.internetMessageId] : [])]
    : [];
  const subject = own.subject ? reifySubject(own.subject) : null;
  const now = new Date();

  // Recipients are the other participants of the thread.
  const recipients: ResolvedRecipient[] = own.participants
    .filter((p) => p.address !== sender.email)
    .map((p) => ({
      address: p.address,
      internal: Boolean(p.convoUserId) && !p.isExternal,
      convoUserId: p.convoUserId,
      displayName: p.displayName,
    }));
  const participants = own.participants.map((p) => ({
    address: p.address,
    displayName: p.displayName,
    convoUserId: p.convoUserId,
    isExternal: p.isExternal,
  }));

  const senderMsgId = await db.$transaction(async (tx) => {
    await tx.emailThread.update({ where: { id: own.id }, data: { lastActivityAt: now } });

    const senderMsg = await tx.emailMessage.create({
      data: {
        threadId: own.id,
        ownerId: userId,
        direction: "OUTBOUND",
        status: "SENT",
        internetMessageId,
        inReplyTo,
        references,
        fromAddress: sender.email,
        subject,
        bodyText: input.body,
        clientSendId: input.clientSendId,
        sentAt: now,
        recipients: {
          create: recipients.map((r) => ({
            address: r.address,
            recipientType: "TO" as const,
            route: r.internal ? ("CONVO_INTERNAL" as const) : ("EXTERNAL_SMTP" as const),
            status: r.internal ? ("DELIVERED" as const) : ("QUEUED" as const),
          })),
        },
      },
    });

    for (const r of recipients) {
      if (!r.internal || !r.convoUserId) continue;
      await mirrorInbound(tx, {
        ownerId: r.convoUserId,
        threadKey: own.threadKey,
        subject,
        participants,
        fromAddress: sender.email,
        bodyText: input.body,
        internetMessageId,
        inReplyTo,
        references,
        convoMessageId: senderMsg.id,
        now,
      });
    }

    return senderMsg.id;
  }, { timeout: MAIL_TX_TIMEOUT_MS, maxWait: MAIL_TX_MAX_WAIT_MS });

  const message = await db.emailMessage.findUniqueOrThrow({
    where: { id: senderMsgId },
    include: { recipients: true },
  });
  const thread = await loadThreadSummary(db, userId, own.id);

  await fanOutNewMail(db, hub, own.threadKey, recipients, deps.notifyRecipient);

  return { thread, message: serializeMessage(message) };
}

function reifySubject(subject: string): string {
  return /^re:/i.test(subject.trim()) ? subject : `Re: ${subject}`;
}

// ────────────────────────────── internal mirroring ──────────────────────────────

interface MirrorInput {
  ownerId: string;
  threadKey: string;
  subject: string | null;
  participants: Prisma.EmailThreadParticipantCreateManyThreadInput[];
  fromAddress: string;
  bodyText: string;
  internetMessageId: string;
  inReplyTo: string | null;
  references: string[];
  convoMessageId: string;
  now: Date;
}

async function ensureThread(
  tx: Prisma.TransactionClient,
  ownerId: string,
  threadKey: string,
  subject: string | null,
  participants: Prisma.EmailThreadParticipantCreateManyThreadInput[],
  now: Date,
): Promise<{ id: string }> {
  const existing = await tx.emailThread.findUnique({
    where: { ownerId_threadKey: { ownerId, threadKey } },
  });
  if (existing) {
    return tx.emailThread.update({
      where: { id: existing.id },
      data: { lastActivityAt: now, subject: subject ?? existing.subject },
    });
  }
  return tx.emailThread.create({
    data: {
      ownerId,
      threadKey,
      subject,
      lastActivityAt: now,
      participants: { createMany: { data: participants } },
    },
  });
}

async function mirrorInbound(tx: Prisma.TransactionClient, input: MirrorInput): Promise<void> {
  const thread = await ensureThread(
    tx,
    input.ownerId,
    input.threadKey,
    input.subject,
    input.participants,
    input.now,
  );
  await tx.emailMessage.create({
    data: {
      threadId: thread.id,
      ownerId: input.ownerId,
      direction: "INBOUND",
      status: "DELIVERED",
      internetMessageId: input.internetMessageId,
      inReplyTo: input.inReplyTo,
      references: input.references,
      fromAddress: input.fromAddress,
      subject: input.subject,
      bodyText: input.bodyText,
      convoMessageId: input.convoMessageId,
      receivedAt: input.now,
      recipients: {
        create: [
          {
            address: input.fromAddress,
            recipientType: "TO",
            route: "CONVO_INTERNAL",
            status: "DELIVERED",
          },
        ],
      },
    },
  });
}

// ────────────────────────────── realtime fan-out ──────────────────────────────

async function fanOutNewMail(
  db: PrismaClient,
  hub: RealtimeHub,
  threadKey: string,
  recipients: ResolvedRecipient[],
  notifyRecipient?: MailDeps["notifyRecipient"],
): Promise<void> {
  for (const r of recipients) {
    if (!r.internal || !r.convoUserId) continue;
    const their = await db.emailThread.findUnique({
      where: { ownerId_threadKey: { ownerId: r.convoUserId, threadKey } },
    });
    if (!their) continue;
    try {
      const thread = await loadThreadSummary(db, r.convoUserId, their.id);
      const lastInbound = await db.emailMessage.findFirst({
        where: { threadId: their.id, direction: "INBOUND" },
        include: { recipients: true },
        orderBy: { createdAt: "desc" },
      });
      if (!lastInbound) continue;
      hub.publishToUsers([r.convoUserId], {
        type: "mail.new",
        thread,
        message: serializeMessage(lastInbound),
      });
      // Phase 5G: bell + push for new mail.
      if (notifyRecipient) {
        const title = thread.subject || "New email";
        void notifyRecipient(r.convoUserId!, title, lastInbound.bodyText?.slice(0, 200) ?? null, null, their.id, lastInbound.id).catch(() => {});
      }
    } catch {
      // A recipient's mailbox failing to serialize must not break the send.
    }
  }
}
