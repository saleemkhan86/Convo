import type { PrismaClient, Prisma, Message as PrismaMessage } from "@prisma/client";
import type { ConversationSummary, Message, ConversationPeer } from "@convo/shared";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import type { RealtimeHub } from "./realtime.js";

/**
 * Chats domain (spec §9, §22, §23): one-to-one conversations, idempotent
 * sends, unread counts, and realtime fan-out. Group chats, reactions,
 * editing, deletion, and attachments are scaffolded in the schema but
 * deferred (docs/TODO Phase 2+).
 */

export interface ConversationDeps {
  db: PrismaClient;
  hub: RealtimeHub;
}

interface SendMessageInput {
  clientMessageId: string;
  body: string;
  replyToId?: string;
}

// ────────────────────────────── serialization ──────────────────────────────

function serializeMessage(m: PrismaMessage): Message {
  return {
    id: m.id,
    conversationId: m.conversationId,
    senderId: m.senderId,
    clientMessageId: m.clientMessageId,
    type: m.type as Message["type"],
    body: m.body,
    replyToId: m.replyToId,
    editedAt: m.editedAt?.toISOString() ?? null,
    deletedAt: m.deletedAt?.toISOString() ?? null,
    createdAt: m.createdAt.toISOString(),
  };
}

type MemberWithUser = Prisma.ConversationMemberGetPayload<{
  include: { user: { include: { phoneIdentity: true } } };
}>;

function peerOf(members: MemberWithUser[], selfId: string): ConversationPeer | null {
  const other = members.find((m) => m.userId !== selfId);
  if (!other) return null;
  return {
    userId: other.userId,
    displayName: other.user.displayName,
    avatarUrl: other.user.avatarUrl,
    phone: other.user.phoneIdentity?.phone ?? null,
  };
}

// ────────────────────────────── membership ──────────────────────────────

async function requireMembership(
  db: PrismaClient,
  userId: string,
  conversationId: string,
): Promise<MemberWithUser> {
  const member = await db.conversationMember.findFirst({
    where: { userId, conversationId, leftAt: null },
    include: { user: { include: { phoneIdentity: true } } },
  });
  if (!member) throw notFound("Conversation not found");
  return member;
}

async function requireChats(db: PrismaClient, userId: string): Promise<void> {
  const user = await db.user.findUnique({
    where: { id: userId },
    include: { phoneIdentity: true },
  });
  if (!user?.phoneIdentity) {
    throw forbidden("Connect a phone number to start using Chats");
  }
}

// ────────────────────────────── start conversation ──────────────────────────────

export async function startDirectConversation(
  { db }: ConversationDeps,
  userId: string,
  phone: string,
): Promise<ConversationSummary> {
  await requireChats(db, userId);

  const target = await db.phoneIdentity.findUnique({
    where: { phone },
    include: { user: true },
  });
  // Same generic error whether the phone is unknown, deactivated, or blocked
  // us — starting a chat must not become a phone-enumeration oracle.
  if (!target || target.user.status !== "ACTIVE" || target.userId === userId) {
    throw notFound("No Convo account found for that phone number");
  }
  const blocked = await db.blockedUser.findUnique({
    where: { userId_blockedUserId: { userId: target.userId, blockedUserId: userId } },
  });
  if (blocked) throw notFound("No Convo account found for that phone number");

  const existing = await db.conversation.findFirst({
    where: {
      type: "DIRECT",
      members: { some: { userId, leftAt: null } },
      AND: { members: { some: { userId: target.userId, leftAt: null } } },
    },
    orderBy: { createdAt: "asc" },
  });

  let conversationId: string;
  if (existing) {
    conversationId = existing.id;
  } else {
    const created = await db.conversation.create({
      data: {
        type: "DIRECT",
        createdBy: userId,
        members: { create: [{ userId }, { userId: target.userId }] },
      },
    });
    conversationId = created.id;
  }

  return summarize(db, userId, conversationId);
}

// ────────────────────────────── listing ──────────────────────────────

export async function listConversations(
  { db }: ConversationDeps,
  userId: string,
  opts: { cursor?: string; limit: number },
): Promise<{ conversations: ConversationSummary[]; nextCursor: string | null }> {
  const memberships = await db.conversationMember.findMany({
    where: { userId, leftAt: null, archived: false },
    include: {
      conversation: {
        include: {
          members: { include: { user: { include: { phoneIdentity: true } } } },
          messages: { orderBy: { createdAt: "desc" }, take: 1 },
        },
      },
    },
    orderBy: [{ pinned: "desc" }, { conversation: { lastMessageAt: "desc" } }, { id: "asc" }],
    take: opts.limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
  });

  const hasMore = memberships.length > opts.limit;
  const page = hasMore ? memberships.slice(0, opts.limit) : memberships;

  const conversations = await Promise.all(
    page.map(async (m) => {
      const conv = m.conversation;
      const lastMessage = conv.messages[0] ? serializeMessage(conv.messages[0]) : null;
      const unreadCount = await countUnread(db, userId, conv.id, m.lastReadAt);
      return {
        id: conv.id,
        type: conv.type as ConversationSummary["type"],
        title: conv.title,
        peer: conv.type === "DIRECT" ? peerOf(conv.members, userId) : null,
        lastMessage,
        unreadCount,
        pinned: m.pinned,
        archived: m.archived,
        mutedUntil: m.mutedUntil?.toISOString() ?? null,
        lastReadAt: m.lastReadAt?.toISOString() ?? null,
        lastMessageAt: conv.lastMessageAt?.toISOString() ?? null,
      } satisfies ConversationSummary;
    }),
  );

  return { conversations, nextCursor: hasMore ? page[page.length - 1]!.id : null };
}

async function countUnread(
  db: PrismaClient,
  userId: string,
  conversationId: string,
  lastReadAt: Date | null,
): Promise<number> {
  return db.message.count({
    where: {
      conversationId,
      senderId: { not: userId },
      deletedAt: null,
      ...(lastReadAt ? { createdAt: { gt: lastReadAt } } : {}),
    },
  });
}

async function summarize(
  db: PrismaClient,
  userId: string,
  conversationId: string,
): Promise<ConversationSummary> {
  const member = await db.conversationMember.findFirstOrThrow({
    where: { userId, conversationId },
    include: {
      conversation: {
        include: {
          members: { include: { user: { include: { phoneIdentity: true } } } },
          messages: { orderBy: { createdAt: "desc" }, take: 1 },
        },
      },
    },
  });
  const conv = member.conversation;
  return {
    id: conv.id,
    type: conv.type as ConversationSummary["type"],
    title: conv.title,
    peer: conv.type === "DIRECT" ? peerOf(conv.members, userId) : null,
    lastMessage: conv.messages[0] ? serializeMessage(conv.messages[0]) : null,
    unreadCount: await countUnread(db, userId, conv.id, member.lastReadAt),
    pinned: member.pinned,
    archived: member.archived,
    mutedUntil: member.mutedUntil?.toISOString() ?? null,
    lastReadAt: member.lastReadAt?.toISOString() ?? null,
    lastMessageAt: conv.lastMessageAt?.toISOString() ?? null,
  };
}

// ────────────────────────────── messages ──────────────────────────────

export async function listMessages(
  { db }: ConversationDeps,
  userId: string,
  conversationId: string,
  opts: { cursor?: string; limit: number },
): Promise<{ messages: Message[]; nextCursor: string | null }> {
  await requireMembership(db, userId, conversationId);

  // Fetch newest-first, then reverse to oldest-first for the timeline.
  const rows = await db.message.findMany({
    where: { conversationId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: opts.limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > opts.limit;
  const page = hasMore ? rows.slice(0, opts.limit) : rows;
  page.reverse();
  // nextCursor points at the oldest message returned, so the next page goes further back.
  const oldest = rows[rows.length - 1];
  return {
    messages: page.map(serializeMessage),
    nextCursor: hasMore && oldest ? oldest.id : null,
  };
}

export async function sendMessage(
  { db, hub }: ConversationDeps,
  userId: string,
  conversationId: string,
  input: SendMessageInput,
): Promise<Message> {
  await requireMembership(db, userId, conversationId);

  // Idempotency (spec §22): a retried clientMessageId returns the original.
  const existing = await db.message.findUnique({
    where: { senderId_clientMessageId: { senderId: userId, clientMessageId: input.clientMessageId } },
  });
  if (existing) {
    if (existing.conversationId !== conversationId) {
      throw badRequest("clientMessageId already used in another conversation");
    }
    return serializeMessage(existing);
  }

  if (input.replyToId) {
    const replyTo = await db.message.findFirst({ where: { id: input.replyToId, conversationId } });
    if (!replyTo) throw badRequest("replyToId is not a message in this conversation");
  }

  const created = await db.$transaction(async (tx) => {
    const message = await tx.message.create({
      data: {
        conversationId,
        senderId: userId,
        clientMessageId: input.clientMessageId,
        type: "TEXT",
        body: input.body,
        replyToId: input.replyToId ?? null,
      },
    });
    await tx.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: message.createdAt },
    });
    return message;
  });

  const serialized = serializeMessage(created);
  await fanOut(db, hub, userId, conversationId, { type: "message.new", message: serialized });
  return serialized;
}

export async function markRead(
  { db, hub }: ConversationDeps,
  userId: string,
  conversationId: string,
  messageId?: string,
): Promise<void> {
  await requireMembership(db, userId, conversationId);

  let readAt = new Date();
  if (messageId) {
    const message = await db.message.findFirst({ where: { id: messageId, conversationId } });
    if (!message) throw badRequest("messageId is not a message in this conversation");
    readAt = message.createdAt;
  }

  await db.conversationMember.updateMany({
    where: { userId, conversationId, leftAt: null },
    data: { lastReadAt: readAt },
  });

  await fanOut(db, hub, userId, conversationId, {
    type: "message.read",
    conversationId,
    userId,
    readAt: readAt.toISOString(),
  });
}

// ────────────────────────────── realtime fan-out ──────────────────────────────

async function fanOut(
  db: PrismaClient,
  hub: RealtimeHub,
  actorId: string,
  conversationId: string,
  event: Parameters<RealtimeHub["publishToUsers"]>[1],
): Promise<void> {
  const others = await db.conversationMember.findMany({
    where: { conversationId, leftAt: null, userId: { not: actorId } },
    select: { userId: true },
  });
  hub.publishToUsers(
    others.map((m) => m.userId),
    event,
  );
}
