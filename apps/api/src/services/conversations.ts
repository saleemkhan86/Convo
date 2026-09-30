import { Prisma } from "@prisma/client";
import type {
  PrismaClient,
  AttachmentKind as PrismaAttachmentKind,
  MessageType as PrismaMessageType,
  MessageReaction as PrismaReaction,
} from "@prisma/client";
import type {
  Attachment,
  AttachmentInput,
  ChatExportAttachment,
  ChatExportDocument,
  ChatExportMessage,
  ChatLinkItem,
  ChatPin,
  ConversationSummary,
  ForwardedFrom,
  ForwardMessagesRequest,
  ForwardMessagesResult,
  LinkPreview,
  Message,
  ConversationPeer,
  MessageLocation,
  MessageReactionSummary,
  ReactionTally,
  DeleteMessageScope,
  ReplyPreview,
  SendMessageRequest,
  SharedContact,
  SharedMediaKind,
  StarredMessage,
  UpdateConversationRequest,
  ViewOnceOpenResult,
} from "@convo/shared";
import { ApiErrorCode } from "@convo/shared";
import { parseMentions } from "./mentions.js";
import { badRequest, forbidden, notFound, conflict } from "../lib/errors.js";
import { firstUrl, unfurlLink } from "./unfurl.js";
import { fieldVisibleToUser, mayAddToGroup, PROFILE_QUERY } from "./privacy.js";
import type { RealtimeHub } from "./realtime.js";
import type { NotificationItem } from "@convo/shared";

/**
 * Chats domain (spec §9, §22, §23, §34): one-to-one conversations, idempotent
 * sends, unread counts, realtime fan-out, Phase 4A chat options (editing,
 * delete, reactions, receipts, privacy-gated last-seen), Phase 5A chat controls
 * (pin/archive/mute, clear, delete-for-me, star, in-chat search) and Phase 5B
 * media messages (attachments, view-once, forwarding, shared-media gallery).
 *
 * Every 5A control is per-viewer state living on ConversationMember, so one
 * user's "clear chat" can never erase history for the other side.
 */

export interface ConversationDeps {
  db: PrismaClient;
  hub: RealtimeHub;
  /** Expiring signed download URL for one stored media key (never stored). */
  mediaUrl: MediaUrlFor;
  /** Budget for the after-send link scrape; only the chat send path reads it. */
  linkUnfurl?: { timeoutMs: number; maxBytes: number };
  /**
   * Post-send notification hook (Phase 5G). When present, called once per
   * recipient after the message is persisted and broadcast. Absent during unit
   * tests that only care about the chat layer.
   */
  notifyRecipient?: (
    userId: string,
    type: "CHAT_MESSAGE" | "MENTION",
    title: string,
    body: string | null,
    actorId: string,
    conversationId: string,
    messageId: string,
  ) => Promise<NotificationItem | null>;
}

/** Mints the short-lived URL a client needs to fetch one attachment. */
export type MediaUrlFor = (key: string) => string;

/** Read-side deps: enough to load a chat and sign its media, nothing more. */
export type ChatReader = Pick<ConversationDeps, "db" | "mediaUrl">;

export interface SendMessageInput {
  clientMessageId: string;
  body?: string;
  replyToId?: string;
  attachments?: AttachmentInput[];
  viewOnce?: boolean;
  /** 5B extras: exactly one of location/contactCard may accompany a send. */
  location?: MessageLocation;
  contactCard?: SharedContact;
  sticker?: boolean;
  /**
   * 5D: this message answers someone's status update. Only the status-reply
   * route sets it — the chat send body has no such field — and it carries the
   * quoted status snapshot in `replyPreview`.
   */
  statusReplyToId?: string;
}

/** Relation includes every message read returns so serialization is uniform. */
export const messageInclude = {
  reactions: true,
  receipts: true,
  starredBy: true,
  attachments: true,
  forwardedFrom: { select: { id: true, displayName: true } },
  /** Just the ids: serialization asks "did *this* viewer already open it?". */
  viewOnceViews: { select: { userId: true } },
  /** @mention targets (5E); ids only, names come from the roster. */
  mentions: { select: { userId: true } },
  /** The chat-wide pin (5E); one row at most, with its author's name. */
  pin: { select: { pinnedById: true, pinnedAt: true, user: { select: { displayName: true } } } },
} as const;
type MessageFull = Prisma.MessageGetPayload<{ include: typeof messageInclude }>;
type AttachmentRow = MessageFull["attachments"][number];

/** Shape of the `Message.replyPreview` JSON column. */
interface StoredReplyPreview {
  messageId: string | null;
  senderId: string | null;
  senderName: string | null;
  type: Message["type"];
  body: string | null;
  kind: Attachment["kind"] | null;
  storageKey: string | null;
  fileName: string | null;
}

/** The two per-viewer watermarks every read/count query needs. */
interface ChatWatermarks {
  lastReadAt: Date | null;
  clearedAt: Date | null;
  // Phase 5G per-viewer notification & appearance state.
  notifyMode: "ALL" | "MENTIONS_ONLY" | "NOTHING";
  notifySound: string | null;
  wallpaperKey: string | null;
}

const iso = (d: Date): string => d.toISOString();

// ────────────────────────────── serialization ──────────────────────────────

function aggregateReactions(reactions: PrismaReaction[], viewerId: string): MessageReactionSummary[] {
  const counts = new Map<string, { count: number; reactedByMe: boolean }>();
  for (const r of reactions) {
    const entry = counts.get(r.emoji) ?? { count: 0, reactedByMe: false };
    entry.count += 1;
    if (r.userId === viewerId) entry.reactedByMe = true;
    counts.set(r.emoji, entry);
  }
  return [...counts.entries()].map(([emoji, { count, reactedByMe }]) => ({ emoji, count, reactedByMe }));
}

function toTallies(reactions: MessageReactionSummary[]): ReactionTally[] {
  return reactions.map(({ emoji, count }) => ({ emoji, count }));
}

/**
 * How far one of the caller's own messages progressed for its recipients.
 * Null for other people's messages (the tick only ever shows on your own).
 */
function receiptStatus(m: MessageFull, viewerId: string): Message["deliveryStatus"] {
  if (m.senderId !== viewerId) return null;
  if (m.receipts.some((r) => r.readAt !== null)) return "READ";
  if (m.receipts.some((r) => r.deliveredAt !== null)) return "DELIVERED";
  return "SENT";
}

/**
 * View-once media is deliberately URL-less in every list payload: the only way
 * to get bytes is `POST /messages/:id/view-once`, which answers once per viewer.
 */
function serializeAttachments(
  attachments: AttachmentRow[],
  viewOnce: boolean,
  mediaUrl: MediaUrlFor,
): Attachment[] {
  return attachments.map((a) => ({
    id: a.id,
    kind: a.kind as Attachment["kind"],
    mimeType: a.mimeType,
    fileName: a.fileName,
    sizeBytes: Number(a.sizeBytes),
    width: a.width,
    height: a.height,
    durationMs: a.durationMs,
    mediaUrl: viewOnce ? null : mediaUrl(a.storageKey),
  }));
}

/** Rebuild a reply quote from the snapshot taken when the reply was sent. */
function serializeReplyPreview(
  stored: Prisma.JsonValue,
  mediaUrl: MediaUrlFor,
): ReplyPreview | null {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return null;
  const p = stored as unknown as Partial<StoredReplyPreview>;
  return {
    messageId: p.messageId ?? null,
    senderId: p.senderId ?? null,
    senderName: p.senderName ?? null,
    type: p.type ?? "TEXT",
    body: p.body ?? null,
    kind: p.kind ?? null,
    fileName: p.fileName ?? null,
    mediaUrl: p.storageKey ? mediaUrl(p.storageKey) : null,
  };
}

function serializeForwardedFrom(m: MessageFull): ForwardedFrom | null {
  if (!m.forwardedFrom) return null;
  return { userId: m.forwardedFrom.id, displayName: m.forwardedFrom.displayName };
}

export function serializeMessage(m: MessageFull, viewerId: string, mediaUrl: MediaUrlFor): Message {
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
    reactions: aggregateReactions(m.reactions, viewerId),
    deliveryStatus: receiptStatus(m, viewerId),
    starredByMe: m.starredBy.some((s) => s.userId === viewerId),
    attachments: serializeAttachments(m.attachments, m.viewOnce, mediaUrl),
    viewOnce: m.viewOnce,
    viewOnceOpened: m.viewOnceViews.some((v) => v.userId === viewerId),
    forwardedFrom: serializeForwardedFrom(m),
    replyPreview: m.replyPreview
      ? serializeReplyPreview(m.replyPreview, mediaUrl)
      : null,
    statusReply: m.statusReplyId ? { statusId: m.statusReplyId } : null,
    mentions: (m.mentions ?? []).map((mention) => mention.userId),
    mentionedMe: (m.mentions ?? []).some((mention) => mention.userId === viewerId),
    pinned: m.pin
      ? {
          userId: m.pin.pinnedById,
          displayName: m.pin.user?.displayName ?? null,
          pinnedAt: m.pin.pinnedAt.toISOString(),
        }
      : null,
    linkPreview: serializeJsonValue<LinkPreview>(m.linkPreview),
    location: serializeJsonValue<Message["location"]>(m.location),
    contactCard: serializeJsonValue<Message["contactCard"]>(m.contactCard),
    expiresAt: m.expiresAt?.toISOString() ?? null,
    createdAt: m.createdAt.toISOString(),
  };
}

/** Read one of the JSON payload columns (link previews, pins, contact cards). */
function serializeJsonValue<T>(stored: Prisma.JsonValue | null): T | null {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return null;
  return stored as unknown as T;
}

/**
 * Messages this viewer may see: not hidden "for me", not from before the
 * viewer's "clear chat" watermark, and not past a disappearing-message timer.
 */
function visibleToViewer(userId: string, clearedAt: Date | null = null): Prisma.MessageWhereInput {
  return {
    hiddenBy: { none: { userId } },
    OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    ...(clearedAt ? { createdAt: { gt: clearedAt } } : {}),
  };
}

/** Newest message a viewer may still see in a chat, honouring clearedAt. */
async function latestVisible(
  db: PrismaClient,
  userId: string,
  conversationId: string,
  w: ChatWatermarks,
) {
  return db.message.findFirst({
    where: { conversationId, ...visibleToViewer(userId, w.clearedAt) },
    orderBy: { createdAt: "desc" },
    include: messageInclude,
  });
}

/**
 * The user rows a chat payload renders, with the 5C visibility columns so
 * `peerOf` can gate each field from stored settings.
 */
const memberUserInclude = { user: PROFILE_QUERY } as const;

type MemberWithUser = Prisma.ConversationMemberGetPayload<{
  include: { user: typeof PROFILE_QUERY };
}>;

type ConversationLoaded = Prisma.ConversationGetPayload<{
  include: { group: true; members: true };
}>;

/** Conversation as loaded for summary building: members carry their user rows. */
type ConversationForSummary = Prisma.ConversationGetPayload<{
  include: { group: true; members: { include: typeof memberUserInclude } };
}>;

/**
 * Last-seen visibility (spec §34), now with 5C's separate "online" switch:
 * `presenceVisibility` keeps the classic audience rule and
 * `onlineVisibility === "NONE"` hides the whole "last seen & online" facet —
 * exactly what WhatsApp's combined "Last seen & online → Nobody" does.
 */
export async function lastSeenVisibleTo(
  db: PrismaClient,
  viewerId: string,
  peerUser: {
    id: string;
    presenceVisibility: "EVERYONE" | "CONTACTS" | "NONE";
    onlineVisibility?: "EVERYONE" | "CONTACTS" | "CONTACTS_EXCEPT" | "NONE";
    visibilityExcluded?: unknown;
  },
): Promise<boolean> {
  if (peerUser.onlineVisibility === "NONE") return false;
  switch (peerUser.presenceVisibility) {
    case "EVERYONE":
      return true;
    case "NONE":
      return false;
    case "CONTACTS": {
      const contact = await db.contact.findFirst({
        where: { ownerId: peerUser.id, convoUserId: viewerId },
        select: { id: true },
      });
      return contact !== null;
    }
  }
}

/** The peer of a DIRECT chat as a viewer sees it — privacy-gated field by field. */
async function peerOf(
  db: PrismaClient,
  members: MemberWithUser[],
  viewerId: string,
): Promise<ConversationPeer | null> {
  const other = members.find((m) => m.userId !== viewerId);
  if (!other) return null;
  const [visible, avatarVisible, aboutVisible] = await Promise.all([
    lastSeenVisibleTo(db, viewerId, other.user),
    fieldVisibleToUser(db, viewerId, other.user, "avatar"),
    fieldVisibleToUser(db, viewerId, other.user, "about"),
  ]);
  return {
    userId: other.userId,
    displayName: other.user.displayName,
    avatarUrl: avatarVisible ? other.user.avatarUrl : null,
    bio: aboutVisible ? (other.user.bio ?? null) : null,
    phone: other.user.phoneIdentity?.phone ?? null,
    lastSeenAt: visible ? (other.user.lastSeenAt?.toISOString() ?? null) : null,
  };
}

// ────────────────────────────── membership ──────────────────────────────

async function requireMembership(
  db: PrismaClient,
  userId: string,
  conversationId: string,
): Promise<MemberWithUser> {
  const member = await db.conversationMember.findFirst({
    where: { userId, conversationId, leftAt: null, joinState: "ACTIVE" },
    include: memberUserInclude,
  });
  if (!member) throw notFound("Conversation not found");
  return member;
}

/**
 * Group send rules (Phase 4B): announce-only and who-canSend=ADMINS restrict
 * posting to admins. DIRECT conversations are always unrestricted.
 */
async function assertCanPost(db: PrismaClient, userId: string, conversationId: string): Promise<void> {
  const profile = await db.groupProfile.findUnique({
    where: { conversationId },
    select: { announceOnly: true, whoCanSend: true },
  });
  if (!profile) return;
  const member = await db.conversationMember.findFirst({
    where: { conversationId, userId, leftAt: null, joinState: "ACTIVE" },
    select: { role: true },
  });
  if (member?.role === "ADMIN") return;
  if (profile.announceOnly || profile.whoCanSend === "ADMINS") {
    throw forbidden("Only admins can send messages in this group");
  }
}

/** Group badge data derived from an already-loaded conversation. */
function groupInfoFrom(
  conv: ConversationLoaded,
  viewerId: string,
): ConversationSummary["group"] {
  const profile = conv.group;
  if (!profile) return null;
  const active = conv.members.filter((m) => m.leftAt === null && m.joinState === "ACTIVE");
  return {
    memberCount: active.length,
    myRole: active.find((m) => m.userId === viewerId)?.role ?? null,
    announceOnly: profile.announceOnly,
    whoCanSend: profile.whoCanSend,
  };
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

/**
 * One message for every way a 1-1 chat can be unreachable: unknown number,
 * deactivated account, blocked us, already self. Distinct messages here would
 * turn "start a chat" into an enumeration oracle (spec §28).
 */
const UNREACHABLE_ACCOUNT = "No Convo account found for that phone number";

export async function startDirectConversation(
  deps: ConversationDeps,
  userId: string,
  phone: string,
): Promise<ConversationSummary> {
  const { db } = deps;
  await requireChats(db, userId);

  const target = await db.phoneIdentity.findUnique({
    where: { phone },
    select: { userId: true },
  });
  if (!target) throw notFound(UNREACHABLE_ACCOUNT);
  const conversationId = await openDirectChat(deps, userId, target.userId);
  return summarize(deps, userId, conversationId);
}

/**
 * The 1-1 chat between two accounts, created on first use. `POST /conversations`
 * and a status reply (5D) share this path, so answering someone's update never
 * needs their phone number.
 */
export async function openDirectChat(
  deps: ConversationDeps,
  userId: string,
  peerId: string,
): Promise<string> {
  const { db } = deps;
  await requireChats(db, userId);
  const me = await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: { defaultEphemeralSeconds: true },
  });

  const target = await db.user.findUnique({
    where: { id: peerId },
    select: { id: true, status: true, defaultEphemeralSeconds: true },
  });
  if (!target || target.status !== "ACTIVE" || target.id === userId) {
    throw notFound(UNREACHABLE_ACCOUNT);
  }
  const blocked = await db.blockedUser.findUnique({
    where: { userId_blockedUserId: { userId: target.id, blockedUserId: userId } },
  });
  if (blocked) throw notFound(UNREACHABLE_ACCOUNT);

  const existing = await db.conversation.findFirst({
    where: {
      type: "DIRECT",
      members: { some: { userId, leftAt: null } },
      AND: { members: { some: { userId: target.id, leftAt: null } } },
    },
    orderBy: { createdAt: "asc" },
  });
  if (existing) return existing.id;

  const created = await db.conversation.create({
    data: {
      type: "DIRECT",
      createdBy: userId,
      // WhatsApp's default-timer rule: a brand-new chat gets the shorter of
      // the two participants' defaults — and only if *both* opted in.
      ephemeralSeconds: sharedEphemeralDefault(
        me.defaultEphemeralSeconds,
        target.defaultEphemeralSeconds,
      ),
      members: { create: [{ userId }, { userId: target.id }] },
    },
  });
  return created.id;
}

/**
 * Default disappearing timer for a newly opened 1-1 chat: 0 unless both
 * accounts opted in, then the more private (shorter) choice wins.
 */
export function sharedEphemeralDefault(mine: number, theirs: number): number {
  if (mine <= 0 || theirs <= 0) return 0;
  return Math.min(mine, theirs);
}

// ────────────────────────────── listing ──────────────────────────────

export async function listConversations(
  deps: ConversationDeps,
  userId: string,
  opts: { cursor?: string; limit: number; archived?: boolean; folderId?: string; unfiled?: boolean },
): Promise<{ conversations: ConversationSummary[]; nextCursor: string | null }> {
  // Phase 5G: resolve folder filter before querying memberships.
  let conversationIds: string[] | undefined;
  if (opts.folderId) {
    const items = await deps.db.chatFolderItem.findMany({
      where: { folderId: opts.folderId },
      select: { conversationId: true },
    });
    conversationIds = items.map((i) => i.conversationId);
  } else if (opts.unfiled) {
    // Chats in no folder at all for this user.
    const filed = await deps.db.chatFolderItem.findMany({
      where: { folder: { userId } },
      select: { conversationId: true },
    });
    const filedSet = new Set(filed.map((i) => i.conversationId));
    // We'll filter in-memory after fetching memberships.
    conversationIds = []; // sentinel: filter later
  }

  const where: Prisma.ConversationMemberWhereInput = {
    userId,
    leftAt: null,
    archived: opts.archived ?? false,
    hidden: false,
    ...(opts.folderId && conversationIds ? { conversationId: { in: conversationIds } } : {}),
  };

  const memberships = await deps.db.conversationMember.findMany({
    where,
    include: {
      conversation: {
        include: {
          group: true,
          members: { include: memberUserInclude },
        },
      },
    },
    orderBy: [{ pinned: "desc" }, { conversation: { lastMessageAt: "desc" } }, { id: "asc" }],
    take: opts.limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
  });

  // Phase 5G: unfiled = chats in no folder. Filter after fetch since Prisma
  // can't express "NOT EXISTS (subquery)" cleanly through the client.
  let filtered = memberships;
  if (opts.unfiled && conversationIds === undefined) {
    const filedSet = new Set(
      await deps.db.chatFolderItem.findMany({
        where: { folder: { userId } },
        select: { conversationId: true },
      }).then((rows) => rows.map((r) => r.conversationId)),
    );
    filtered = memberships.filter((m) => !filedSet.has(m.conversationId));
  }

  const hasMore = filtered.length > opts.limit;
  const page = hasMore ? filtered.slice(0, opts.limit) : filtered;

  const conversations = await Promise.all(
    page.map((m) => buildSummary(deps, userId, m, m.conversation)),
  );

  return { conversations, nextCursor: hasMore ? page[page.length - 1]!.id : null };
}

/** Assemble one ConversationSummary from an already-loaded member + conversation. */
async function buildSummary(
  deps: ChatReader,
  userId: string,
  member: ChatWatermarks & {
    pinned: boolean;
    archived: boolean;
    mutedUntil: Date | null;
    hidden: boolean;
  },
  conv: ConversationForSummary,
): Promise<ConversationSummary> {
  const latest = await latestVisible(deps.db, userId, conv.id, member);
  // Phase 5G: folders this chat sits in for the viewer.
  const folderRows = await deps.db.chatFolder.findMany({
    where: { userId, items: { some: { conversationId: conv.id } } },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    select: { id: true, name: true, emoji: true },
  });
  return {
    id: conv.id,
    type: conv.type as ConversationSummary["type"],
    title: conv.title,
    avatarUrl: conv.avatarUrl,
    peer: conv.type === "DIRECT" ? await peerOf(deps.db, conv.members, userId) : null,
    group: conv.type === "GROUP" ? groupInfoFrom(conv, userId) : null,
    lastMessage: latest ? serializeMessage(latest, userId, deps.mediaUrl) : null,
    unreadCount: await countUnread(deps.db, userId, conv.id, member),
    unreadMentions: await countUnreadMentions(deps.db, userId, conv.id, member),
    pinned: member.pinned,
    archived: member.archived,
    mutedUntil: member.mutedUntil?.toISOString() ?? null,
    ephemeralSeconds: conv.ephemeralSeconds,
    lastReadAt: member.lastReadAt?.toISOString() ?? null,
    // A cleared chat reports the newest message the viewer can still see.
    lastMessageAt:
      latest?.createdAt.toISOString() ??
      (member.clearedAt ? null : conv.lastMessageAt?.toISOString() ?? null),
    // Phase 5G per-viewer notification & appearance state.
    notifyMode: member.notifyMode,
    notifySound: member.notifySound,
    wallpaperKey: member.wallpaperKey,
    folders: folderRows.map((f) => ({ id: f.id, name: f.name, emoji: f.emoji })),
  };
}

async function countUnread(
  db: PrismaClient,
  userId: string,
  conversationId: string,
  w: ChatWatermarks,
): Promise<number> {
  const since = unreadWatermark(w);
  return db.message.count({
    where: {
      conversationId,
      senderId: { not: userId },
      deletedAt: null,
      ...visibleToViewer(userId, w.clearedAt),
      ...(since ? { createdAt: { gt: since } } : {}),
    },
  });
}

/**
 * Unread @mentions for the chat-list badge (5E). There is deliberately no
 * per-mention read flag: the badge is "mentions newer than my last read", so
 * marking the chat read clears it and it can never be counted twice.
 */
async function countUnreadMentions(
  db: PrismaClient,
  userId: string,
  conversationId: string,
  w: ChatWatermarks,
): Promise<number> {
  const since = unreadWatermark(w);
  return db.messageMention.count({
    where: {
      userId,
      message: {
        conversationId,
        senderId: { not: userId },
        deletedAt: null,
        ...visibleToViewer(userId, w.clearedAt),
        ...(since ? { createdAt: { gt: since } } : {}),
      },
    },
  });
}

/** Newest timestamp the viewer has already seen, honouring a cleared chat. */
function unreadWatermark(w: ChatWatermarks): Date | null {
  if (w.lastReadAt && w.clearedAt) return w.lastReadAt > w.clearedAt ? w.lastReadAt : w.clearedAt;
  return w.lastReadAt ?? w.clearedAt;
}

export async function summarize(
  deps: ChatReader,
  userId: string,
  conversationId: string,
): Promise<ConversationSummary> {
  const member = await deps.db.conversationMember.findFirstOrThrow({
    where: { userId, conversationId },
    include: {
      conversation: {
        include: {
          group: true,
          members: { include: memberUserInclude },
        },
      },
    },
  });
  return buildSummary(deps, userId, member, member.conversation);
}

// ────────────────────────────── messages ──────────────────────────────

export async function listMessages(
  deps: ConversationDeps,
  userId: string,
  conversationId: string,
  opts: { cursor?: string; limit: number; q?: string; starred?: boolean },
): Promise<{ messages: Message[]; nextCursor: string | null }> {
  const { db, mediaUrl } = deps;
  const member = await requireMembership(db, userId, conversationId);

  // Disappearing messages: purge this chat's expired rows before paging, so a
  // client that was offline never renders (or downloads) a dead message.
  await sweepExpiredMessages(deps, conversationId).catch(() => {});

  // Fetch newest-first, then reverse to oldest-first for the timeline.
  const rows = await db.message.findMany({
    where: {
      conversationId,
      ...visibleToViewer(userId, member.clearedAt),
      ...(opts.q ? { body: { contains: opts.q, mode: "insensitive" } } : {}),
      ...(opts.starred ? { starredBy: { some: { userId } } } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: opts.limit + 1,
    include: messageInclude,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > opts.limit;
  const page = hasMore ? rows.slice(0, opts.limit) : rows;
  page.reverse();
  // nextCursor points at the oldest message returned, so the next page goes further back.
  const oldest = rows[rows.length - 1];
  return {
    messages: page.map((m) => serializeMessage(m, userId, mediaUrl)),
    nextCursor: hasMore && oldest ? oldest.id : null,
  };
}

export async function sendMessage(
  deps: ConversationDeps,
  userId: string,
  conversationId: string,
  input: SendMessageInput,
): Promise<Message> {
  const { db, mediaUrl } = deps;
  await requireMembership(db, userId, conversationId);
  await assertCanPost(db, userId, conversationId);

  // Idempotency (spec §22): a retried clientMessageId returns the original.
  const existing = await db.message.findUnique({
    where: { senderId_clientMessageId: { senderId: userId, clientMessageId: input.clientMessageId } },
    include: messageInclude,
  });
  if (existing) {
    if (existing.conversationId !== conversationId) {
      throw badRequest("clientMessageId already used in another conversation");
    }
    return serializeMessage(existing, userId, mediaUrl);
  }

  const attachments = await resolveAttachments(db, userId, input.attachments);
  if (input.viewOnce) {
    if (attachments.length === 0) throw badRequest("View-once needs media to show");
    if (attachments.some((a) => a.kind !== "IMAGE" && a.kind !== "VIDEO")) {
      throw badRequest("View-once supports photos and videos only");
    }
  }
  if (input.location && input.contactCard) {
    throw badRequest("A message shares either a location or a contact, not both");
  }
  if (input.sticker && !attachments.some((a) => a.kind === "IMAGE")) {
    throw badRequest("Stickers need an image attachment");
  }

  const preview = input.replyToId
    ? await replyPreviewFor(db, conversationId, input.replyToId)
    : input.statusReplyToId
      ? await statusReplyPreviewFor(db, conversationId, userId, input.statusReplyToId)
      : null;

  // Disappearing messages (5C): the chat's timer stamps every new message.
  const chat = await db.conversation.findUniqueOrThrow({
    where: { id: conversationId },
    select: { ephemeralSeconds: true },
  });
  // @mentions (5E) exist in groups only.
  const mentionIds = await mentionIdsFor(db, conversationId, input.body ?? null);

  const sent = await deliverNewMessage(
    deps,
    userId,
    conversationId,
    {
      clientMessageId: input.clientMessageId,
      type: messageTypeFor(input, attachments),
      body: input.body ?? null,
      replyToId: input.replyToId ?? null,
      ...(input.statusReplyToId ? { statusReplyId: input.statusReplyToId } : {}),
      ...(mentionIds && mentionIds.length > 0
        ? { mentions: { createMany: { data: mentionIds.map((userId) => ({ userId })) } } }
        : {}),
      viewOnce: input.viewOnce ?? false,
      ...(chat.ephemeralSeconds > 0
        ? { expiresAt: new Date(Date.now() + chat.ephemeralSeconds * 1000) }
        : {}),
      ...(preview ? { replyPreview: preview as unknown as Prisma.InputJsonValue } : {}),
      ...(input.location ? { location: input.location as unknown as Prisma.InputJsonValue } : {}),
      ...(input.contactCard ? { contactCard: input.contactCard as unknown as Prisma.InputJsonValue } : {}),
    },
    attachments,
  );

  // Link cards are best-effort and arrive after the send via their own event.
  if (deps.linkUnfurl && sent.type === "TEXT" && firstUrl(sent.body)) {
    void attachLinkPreview(deps, sent.id, sent.conversationId, sent.body, deps.linkUnfurl);
  }
  return sent;
}

/**
 * Mention targets for a message write (5E): the active roster only, so a client
 * can never name an id it is allowed to notify. Returns null outside groups,
 * where there are no mentions to record.
 */
async function mentionIdsFor(
  db: PrismaClient,
  conversationId: string,
  body: string | null,
): Promise<string[] | null> {
  const chat = await db.conversation.findUnique({
    where: { id: conversationId },
    select: { type: true },
  });
  if (chat?.type !== "GROUP") return null;
  if (!body || !body.includes("@")) return [];
  const roster = await db.conversationMember.findMany({
    where: { conversationId, leftAt: null, joinState: "ACTIVE" },
    select: { userId: true, user: { select: { displayName: true } } },
  });
  return parseMentions(
    body,
    roster.map((member) => ({ userId: member.userId, displayName: member.user.displayName })),
  );
}

/** Scrape the body's first link, persist the card, and tell the chat about it. */
async function attachLinkPreview(
  deps: ConversationDeps,
  messageId: string,
  conversationId: string,
  body: string | null,
  limits: { timeoutMs: number; maxBytes: number },
): Promise<void> {
  try {
    const preview = await unfurlLink(body, limits);
    if (!preview) return;
    await deps.db.message.update({
      where: { id: messageId },
      data: { linkPreview: preview as unknown as Prisma.InputJsonValue },
    });
    const members = await deps.db.conversationMember.findMany({
      where: { conversationId, leftAt: null, joinState: "ACTIVE" },
      select: { userId: true },
    });
    deps.hub.publishToUsers(members.map((m) => m.userId), {
      type: "message.linkPreview",
      conversationId,
      messageId,
      preview,
    });
  } catch {
    // A failed scrape is simply no card; the message stands on its own.
  }
}

/** Forwarding cap: 20 messages × 20 chats would otherwise be 400 deliveries. */
const MAX_FORWARDS_PER_REQUEST = 100;

export async function forwardMessages(
  deps: ConversationDeps,
  userId: string,
  input: ForwardMessagesRequest,
): Promise<ForwardMessagesResult> {
  const { db } = deps;
  if (input.messageIds.length * input.conversationIds.length > MAX_FORWARDS_PER_REQUEST) {
    throw badRequest("Too many messages to forward at once");
  }

  const sources = await db.message.findMany({
    where: {
      id: { in: input.messageIds },
      deletedAt: null,
      hiddenBy: { none: { userId } },
      conversation: { members: { some: { userId, leftAt: null, joinState: "ACTIVE" } } },
    },
    include: { attachments: true },
    orderBy: { createdAt: "asc" },
  });
  if (sources.length !== input.messageIds.length) {
    throw badRequest("One or more messages cannot be forwarded");
  }
  // The single view was the sender's promise; the recipient does not own the file.
  if (sources.some((m) => m.viewOnce)) {
    throw badRequest("View-once messages cannot be forwarded");
  }

  const created: Message[] = [];
  for (const conversationId of input.conversationIds) {
    await requireMembership(db, userId, conversationId);
    await assertCanPost(db, userId, conversationId);
    // The forwarded copy lives under the *target* chat's timer, not the source's.
    const target = await db.conversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: { ephemeralSeconds: true },
    });
    for (const source of sources) {
      created.push(
        await deliverNewMessage(
          deps,
          userId,
          conversationId,
          {
            type: source.type,
            body: source.body,
            forwardedFromUserId: source.senderId,
            ...(target.ephemeralSeconds > 0
              ? { expiresAt: new Date(Date.now() + target.ephemeralSeconds * 1000) }
              : {}),
            // JSON-payload columns travel with the message unchanged.
            ...(source.location ? { location: source.location as Prisma.InputJsonValue } : {}),
            ...(source.contactCard ? { contactCard: source.contactCard as Prisma.InputJsonValue } : {}),
            ...(source.linkPreview ? { linkPreview: source.linkPreview as Prisma.InputJsonValue } : {}),
          },
          source.attachments.map(toResolvedAttachment),
        ),
      );
    }
  }
  return { created };
}

/**
 * Attachments are only accepted when this account uploaded them: a storage key
 * harvested from someone else's message has no MediaObject row owned by the
 * sender, so it fails here instead of leaking bytes. MIME type, kind and size
 * always come from the stored object, never from the request.
 */
async function resolveAttachments(
  db: PrismaClient,
  userId: string,
  inputs: AttachmentInput[] | undefined,
): Promise<ResolvedAttachment[]> {
  if (!inputs?.length) return [];
  const owned = await db.mediaObject.findMany({
    where: { ownerId: userId, storageKey: { in: inputs.map((i) => i.storageKey) } },
  });
  const byKey = new Map(owned.map((o) => [o.storageKey, o]));
  return inputs.map((input) => {
    const object = byKey.get(input.storageKey);
    if (!object) throw badRequest(`Unknown media key: ${input.storageKey}`);
    return {
      storageKey: object.storageKey,
      kind: object.kind,
      mimeType: object.mimeType,
      sizeBytes: object.sizeBytes,
      fileName: input.fileName ?? null,
      width: input.width ?? null,
      height: input.height ?? null,
      durationMs: input.durationMs ?? null,
    };
  });
}

interface ResolvedAttachment {
  storageKey: string;
  kind: PrismaAttachmentKind;
  mimeType: string;
  sizeBytes: bigint;
  fileName: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
}

function toResolvedAttachment(a: AttachmentRow): ResolvedAttachment {
  return {
    storageKey: a.storageKey,
    kind: a.kind,
    mimeType: a.mimeType,
    sizeBytes: a.sizeBytes,
    fileName: a.fileName,
    width: a.width,
    height: a.height,
    durationMs: a.durationMs,
  };
}

/** The message type is derived server-side, never trusted from the client. */
function messageTypeFor(
  input: Pick<SendMessageInput, "location" | "contactCard" | "sticker">,
  attachments: ResolvedAttachment[],
): PrismaMessageType {
  if (input.location) return "LOCATION";
  if (input.contactCard) return "CONTACT";
  const kind = attachments[0]?.kind;
  if (!kind) return "TEXT";
  if (kind === "IMAGE" && input.sticker) return "STICKER";
  return kind === "OTHER" ? "DOCUMENT" : kind;
}

/**
 * Snapshot the quoted message so a reply keeps rendering after the original is
 * deleted. View-once media contributes no storage key: a quote must not become a
 * second door into a file whose single view was already spent.
 */
async function replyPreviewFor(
  db: PrismaClient,
  conversationId: string,
  replyToId: string,
): Promise<StoredReplyPreview> {
  const quoted = await db.message.findFirst({
    where: { id: replyToId, conversationId },
    include: { attachments: true, sender: { select: { displayName: true } } },
  });
  if (!quoted) throw badRequest("replyToId is not a message in this conversation");
  const first = quoted.attachments[0];
  return {
    messageId: quoted.id,
    senderId: quoted.senderId,
    senderName: quoted.sender?.displayName ?? null,
    type: quoted.type as Message["type"],
    body: quoted.body,
    kind: (first?.kind ?? null) as Attachment["kind"] | null,
    storageKey: quoted.viewOnce ? null : (first?.storageKey ?? null),
    fileName: first?.fileName ?? null,
  };
}

/**
 * Quote for a status reply (5D): the same snapshot shape, built from the
 * status row so the chat renders WhatsApp's "In reply to their update" strip.
 * The peer check is what keeps a reply from quoting a stranger's status into an
 * unrelated chat — audience rules are enforced by the reply route itself.
 */
async function statusReplyPreviewFor(
  db: PrismaClient,
  conversationId: string,
  userId: string,
  statusId: string,
): Promise<StoredReplyPreview> {
  const status = await db.status.findUnique({
    where: { id: statusId },
    select: {
      id: true,
      authorId: true,
      kind: true,
      text: true,
      storageKey: true,
      expiresAt: true,
      author: { select: { displayName: true } },
    },
  });
  if (!status || status.expiresAt < new Date()) throw notFound("Status not found");
  if (status.authorId === userId) throw badRequest("You cannot reply to your own status");

  const peers = await db.conversationMember.findMany({
    where: { conversationId, userId: { not: userId }, leftAt: null },
    select: { userId: true },
  });
  if (!peers.some((p) => p.userId === status.authorId)) {
    throw badRequest("A status can only be answered in a chat with its author");
  }

  const kind = status.kind;
  return {
    messageId: null,
    senderId: status.authorId,
    senderName: status.author.displayName,
    type: kind === "IMAGE" || kind === "VIDEO" ? kind : "TEXT",
    body: status.text,
    kind: kind === "IMAGE" || kind === "VIDEO" ? kind : null,
    storageKey: status.storageKey,
    fileName: null,
  };
}

/**
 * Persist one new message and run its whole delivery: pending receipts for the
 * members who have not blocked the sender, the "delete chat for me" un-hide,
 * the chat's lastMessageAt, realtime fan-out and instant-delivery ticks.
 */
async function deliverNewMessage(
  deps: ConversationDeps,
  senderId: string,
  conversationId: string,
  data: Omit<Prisma.MessageUncheckedCreateInput, "conversationId" | "senderId">,
  attachments: ResolvedAttachment[],
): Promise<Message> {
  const { db, hub, mediaUrl } = deps;

  // Blocking is deliberately non-revealing (spec §28): a message sent to
  // someone who blocked you is stored and answered with 200, but never
  // receipted or delivered — the sender only ever sees a single tick.
  const others = await db.conversationMember.findMany({
    where: { conversationId, leftAt: null, joinState: "ACTIVE", userId: { not: senderId } },
    select: { userId: true },
  });
  const blockedSet = await blockedRecipients(db, senderId, others.map((o) => o.userId));
  const recipients = others.map((o) => o.userId).filter((id) => !blockedSet.has(id));

  const created = await db.$transaction(async (tx) => {
    const message = await tx.message.create({ data: { ...data, conversationId, senderId } });
    if (attachments.length > 0) {
      // Rows reference the stored bytes; re-sending and forwarding share them.
      await tx.attachment.createMany({
        data: attachments.map((a) => ({ ...a, messageId: message.id })),
      });
    }
    if (recipients.length > 0) {
      await tx.messageReceipt.createMany({
        data: recipients.map((id) => ({ messageId: message.id, userId: id })),
      });
    }
    // "Delete chat for me" is temporary: new activity brings the chat back.
    await tx.conversationMember.updateMany({
      where: { conversationId, hidden: true },
      data: { hidden: false, hiddenAt: null },
    });
    await tx.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: message.createdAt },
    });
    return message;
  });

  // Recipients connected right now count as delivered; the sender's other
  // devices learn about it via message.delivered.
  const pending = await db.messageReceipt.findMany({
    where: { messageId: created.id, deliveredAt: null },
  });
  const deliveredAt = new Date();
  const onlineIds = pending.filter((r) => hub.isOnline(r.userId)).map((r) => r.userId);
  if (onlineIds.length > 0) {
    await db.messageReceipt.updateMany({
      where: { messageId: created.id, userId: { in: onlineIds } },
      data: { deliveredAt },
    });
  }
  const full = await db.message.findUniqueOrThrow({
    where: { id: created.id },
    include: messageInclude,
  });

  const serialized = serializeMessage(full, senderId, mediaUrl);
  await fanOut(db, hub, senderId, conversationId, { type: "message.new", message: serialized }, [
    ...blockedSet,
  ]);
  for (const recipientId of onlineIds) {
    hub.publishToUsers([senderId], {
      type: "message.delivered",
      conversationId,
      messageIds: [created.id],
      userId: recipientId,
      deliveredAt: deliveredAt.toISOString(),
    });
  }

  // Phase 5G: notify each recipient (bell + push). Mentions get their own type.
  if (deps.notifyRecipient) {
    const mentionedSet = new Set((full.mentions ?? []).map((m: { userId: string }) => m.userId));
    const title = full.type === "TEXT" ? (full.body?.slice(0, 255) ?? "New message") : "New message";
    for (const recipientId of recipients) {
      const type = mentionedSet.has(recipientId) ? "MENTION" : "CHAT_MESSAGE";
      void deps.notifyRecipient(recipientId, type, title, full.body, senderId, conversationId, created.id).catch(() => {});
    }
  }

  return serialized;
}

export async function markRead(
  { db, hub }: Pick<ConversationDeps, "db" | "hub">,
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

  // Read receipts are two-way (5C): turning yours off stops the read stamps
  // (and their fan-out) entirely — the peer keeps the single/double tick.
  const me = await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: { readReceiptsEnabled: true },
  });
  if (!me.readReceiptsEnabled) return;

  await db.conversationMember.updateMany({
    where: { userId, conversationId, leftAt: null },
    data: { lastReadAt: readAt },
  });

  // Stamp the sender's receipts (delivered + read) for everything up to here.
  await db.messageReceipt.updateMany({
    where: {
      userId,
      message: { conversationId, senderId: { not: userId }, createdAt: { lte: readAt } },
    },
    data: { deliveredAt: new Date(), readAt: new Date() },
  });

  await fanOut(db, hub, userId, conversationId, {
    type: "message.read",
    conversationId,
    userId,
    readAt: readAt.toISOString(),
  });
}

// ────────────────────────────── chat options (Phase 4A) ──────────────────────────────

export async function editMessage(
  deps: ConversationDeps,
  userId: string,
  messageId: string,
  body: string,
): Promise<Message> {
  const { db, hub } = deps;
  const message = await db.message.findUnique({ where: { id: messageId } });
  if (!message) throw notFound("Message not found");
  await requireMembership(db, userId, message.conversationId);
  if (message.senderId !== userId) throw forbidden("You can only edit your own messages");
  if (message.deletedAt) throw badRequest("Cannot edit a deleted message");

  // An edit can add or drop a mention, so a group's roster rows are rebuilt from
  // the new body (5E). The message keeps its original createdAt, so editing can
  // never re-trigger the unread-mention badge of an already-read chat.
  const mentionIds = await mentionIdsFor(db, message.conversationId, body);
  const edited = await db.message.update({
    where: { id: messageId },
    data: {
      body,
      editedAt: new Date(),
      ...(mentionIds
        ? {
            mentions: {
              deleteMany: {},
              ...(mentionIds.length > 0
                ? { create: mentionIds.map((userId) => ({ userId })) }
                : {}),
            },
          }
        : {}),
    },
    include: messageInclude,
  });

  await fanOut(db, hub, userId, message.conversationId, {
    type: "message.edited",
    conversationId: message.conversationId,
    messageId,
    body: edited.body,
    editedAt: iso(edited.editedAt!),
  });
  return serializeMessage(edited, userId, deps.mediaUrl);
}

export async function deleteMessage(
  { db, hub }: ConversationDeps,
  userId: string,
  messageId: string,
  scope: DeleteMessageScope,
): Promise<void> {
  const message = await db.message.findUnique({ where: { id: messageId } });
  if (!message) throw notFound("Message not found");
  await requireMembership(db, userId, message.conversationId);
  const conversationId = message.conversationId;

  if (scope === "EVERYONE") {
    if (message.senderId !== userId) {
      throw forbidden("You can only delete your own messages for everyone");
    }
    if (!message.deletedAt) {
      await db.$transaction([
        db.message.update({
          where: { id: messageId },
          data: { deletedAt: new Date(), body: null, replyToId: null },
        }),
        db.attachment.deleteMany({ where: { messageId } }),
      ]);
    }
    await fanOut(db, hub, userId, conversationId, {
      type: "message.deleted",
      conversationId,
      messageId,
      scope,
    });
    return;
  }

  // scope === "MINE": hide only for this viewer; other members keep the message.
  await db.messageHidden.upsert({
    where: { messageId_userId: { messageId, userId } },
    create: { messageId, userId },
    update: {},
  });
  // Notify the viewer's other devices (they aren't covered by actor-excluded fan-out).
  hub.publishToUsers([userId], {
    type: "message.deleted",
    conversationId,
    messageId,
    scope,
    userId,
  });
}

export async function reactMessage(
  deps: ConversationDeps,
  userId: string,
  messageId: string,
  emoji: string,
): Promise<Message> {
  const { db } = deps;
  const message = await db.message.findUnique({ where: { id: messageId } });
  if (!message) throw notFound("Message not found");
  await requireMembership(db, userId, message.conversationId);
  if (message.deletedAt) throw badRequest("Cannot react to a deleted message");

  await db.messageReaction.upsert({
    where: { messageId_userId_emoji: { messageId, userId, emoji } },
    create: { messageId, userId, emoji },
    update: {},
  });
  return broadcastReactions(deps, userId, message.conversationId, messageId);
}

export async function removeReaction(
  deps: ConversationDeps,
  userId: string,
  messageId: string,
  emoji: string,
): Promise<Message> {
  const { db } = deps;
  const message = await db.message.findUnique({ where: { id: messageId } });
  if (!message) throw notFound("Message not found");
  await requireMembership(db, userId, message.conversationId);

  await db.messageReaction.deleteMany({ where: { messageId, userId, emoji } });
  return broadcastReactions(deps, userId, message.conversationId, messageId);
}

async function broadcastReactions(
  deps: ConversationDeps,
  userId: string,
  conversationId: string,
  messageId: string,
): Promise<Message> {
  const { db, hub, mediaUrl } = deps;
  const full = await db.message.findUniqueOrThrow({
    where: { id: messageId },
    include: messageInclude,
  });
  const reactions = toTallies(aggregateReactions(full.reactions, userId));
  // Reactions sync to every member, including the actor's other devices.
  const members = await db.conversationMember.findMany({
    where: { conversationId, leftAt: null },
    select: { userId: true },
  });
  hub.publishToUsers(
    members.map((m) => m.userId),
    { type: "message.reacted", conversationId, messageId, reactions },
  );
  return serializeMessage(full, userId, mediaUrl);
}

// ────────────────────────────── chat controls (Phase 5A) ──────────────────────────────

/**
 * Pin / archive / mute. All three live on ConversationMember, so they are
 * per-viewer and never affect anyone else in the chat.
 */
export async function updateConversationSettings(
  deps: ConversationDeps,
  userId: string,
  conversationId: string,
  req: UpdateConversationRequest,
): Promise<ConversationSummary> {
  const { db } = deps;
  await requireMembership(db, userId, conversationId);

  const data: Prisma.ConversationMemberUpdateInput = {};
  if (req.pinned !== undefined) data.pinned = req.pinned;
  if (req.archived !== undefined) {
    data.archived = req.archived;
    // Archiving from the chat list also unhides it (archive is a visible folder).
    if (req.archived) data.hidden = false;
  }
  if (req.muteHours !== undefined) {
    data.mutedUntil =
      req.muteHours > 0 ? new Date(Date.now() + req.muteHours * 60 * 60 * 1000) : null;
  }
  // Phase 5G per-chat notification & appearance prefs.
  if (req.notifyMode !== undefined) data.notifyMode = req.notifyMode;
  if (req.notifySound !== undefined) data.notifySound = req.notifySound;
  if (req.wallpaperKey !== undefined) data.wallpaperKey = req.wallpaperKey;

  await db.conversationMember.update({
    where: { conversationId_userId: { conversationId, userId } },
    data,
  });
  return summarize(deps, userId, conversationId);
}

// ────────────────────────────── disappearing messages (Phase 5C) ──────────────────────────────

/**
 * Turn the chat's disappearing timer on/off (1-1 chats only, WhatsApp rule).
 * Existing messages keep whatever expiry they were sent with.
 */
export async function setConversationEphemeral(
  deps: ConversationDeps,
  userId: string,
  conversationId: string,
  seconds: number,
): Promise<ConversationSummary> {
  const { db } = deps;
  await requireMembership(db, userId, conversationId);
  const conv = await db.conversation.findUniqueOrThrow({
    where: { id: conversationId },
    select: { type: true },
  });
  if (conv.type !== "DIRECT") {
    throw badRequest("Disappearing messages are a 1-1 chat setting");
  }
  await db.conversation.update({ where: { id: conversationId }, data: { ephemeralSeconds: seconds } });
  await fanOutAll(db, deps.hub, conversationId, {
    type: "conversation.ephemeralChanged",
    conversationId,
    seconds,
  });
  return summarize(deps, userId, conversationId);
}

/**
 * Hard-delete one chat's messages whose timer passed, telling every member
 * (including the sweeper's own other devices). Read paths call this
 * opportunistically; the server-wide sweep calls it for hot chats.
 */
export async function sweepExpiredMessages(
  deps: Pick<ConversationDeps, "db" | "hub">,
  conversationId: string,
): Promise<number> {
  const expired = await deps.db.message.findMany({
    where: { conversationId, expiresAt: { lte: new Date() } },
    select: { id: true },
    take: 500,
  });
  if (expired.length === 0) return 0;
  await deps.db.message.deleteMany({ where: { id: { in: expired.map((m) => m.id) } } });
  const members = await deps.db.conversationMember.findMany({
    where: { conversationId, leftAt: null },
    select: { userId: true },
  });
  for (const m of expired) {
    deps.hub.publishToUsers(members.map((x) => x.userId), {
      type: "message.expired",
      conversationId,
      messageId: m.id,
    });
  }
  return expired.length;
}

/**
 * Global disappearing sweep: purge the oldest expired rows in batches and
 * notify their chats. Returns the number deleted.
 */
export async function sweepAllExpired(deps: Pick<ConversationDeps, "db" | "hub">): Promise<number> {
  const { db, hub } = deps;
  let total = 0;
  for (;;) {
    const expired = await db.message.findMany({
      where: { expiresAt: { lte: new Date() } },
      select: { id: true, conversationId: true },
      orderBy: { expiresAt: "asc" },
      take: 200,
    });
    if (expired.length === 0) break;
    await db.message.deleteMany({ where: { id: { in: expired.map((m) => m.id) } } });
    const byChat = new Map<string, string[]>();
    for (const m of expired) {
      const list = byChat.get(m.conversationId) ?? [];
      list.push(m.id);
      byChat.set(m.conversationId, list);
    }
    for (const [conversationId, ids] of byChat) {
      const members = await db.conversationMember.findMany({
        where: { conversationId, leftAt: null },
        select: { userId: true },
      });
      for (const messageId of ids) {
        hub.publishToUsers(members.map((x) => x.userId), {
          type: "message.expired",
          conversationId,
          messageId,
        });
      }
    }
    total += expired.length;
    if (expired.length < 200) break;
  }
  return total;
}

/** "Clear chat": drop this viewer's history behind a watermark; others are untouched. */
export async function clearConversation(
  deps: ConversationDeps,
  userId: string,
  conversationId: string,
): Promise<ConversationSummary> {
  const { db } = deps;
  await requireMembership(db, userId, conversationId);
  const now = new Date();
  await db.conversationMember.update({
    where: { conversationId_userId: { conversationId, userId } },
    // lastReadAt moves too, otherwise the old messages still count as unread.
    data: { clearedAt: now, lastReadAt: now },
  });
  return summarize(deps, userId, conversationId);
}

/**
 * "Delete chat for me": hidden from the list until new activity brings it back
 * (sendMessage unhides). The same message rows remain for everyone else.
 */
export async function deleteConversationForMe(
  { db }: ConversationDeps,
  userId: string,
  conversationId: string,
): Promise<void> {
  await requireMembership(db, userId, conversationId);
  const now = new Date();
  await db.conversationMember.update({
    where: { conversationId_userId: { conversationId, userId } },
    data: { hidden: true, hiddenAt: now, clearedAt: now, lastReadAt: now },
  });
}

/** Star / unstar a message for the caller only. */
export async function setMessageStarred(
  deps: ConversationDeps,
  userId: string,
  messageId: string,
  starred: boolean,
): Promise<Message> {
  const { db } = deps;
  const message = await db.message.findUnique({ where: { id: messageId } });
  if (!message) throw notFound("Message not found");
  await requireMembership(db, userId, message.conversationId);
  if (message.deletedAt) throw badRequest("Cannot star a deleted message");

  if (starred) {
    await db.starredMessage.upsert({
      where: { messageId_userId: { messageId, userId } },
      create: { messageId, userId },
      update: {},
    });
  } else {
    await db.starredMessage.deleteMany({ where: { messageId, userId } });
  }

  const full = await db.message.findUniqueOrThrow({
    where: { id: messageId },
    include: messageInclude,
  });
  return serializeMessage(full, userId, deps.mediaUrl);
}

/** Include shape behind `GET /starred`: the message with its reaction/star state. */
const starredPageInclude = { message: { include: messageInclude } } as const;
type StarredRow = Prisma.StarredMessageGetPayload<{ include: typeof starredPageInclude }>;

/**
 * Starred messages across every chat, newest star first. Chats the viewer
 * cleared keep their stars but hide the older messages, so rows behind a
 * clearedAt watermark are filtered out after fetching.
 */
export async function listStarred(
  deps: ConversationDeps,
  userId: string,
  opts: { cursor?: string; limit: number },
): Promise<{ items: StarredMessage[]; nextCursor: string | null }> {
  const { db } = deps;
  const rows = await db.starredMessage.findMany({
    where: {
      userId,
      message: {
        hiddenBy: { none: { userId } },
        conversation: { members: { some: { userId, leftAt: null, joinState: "ACTIVE" } } },
      },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: opts.limit + 1,
    include: { message: { include: { ...messageInclude } } },
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > opts.limit;
  const page = hasMore ? rows.slice(0, opts.limit) : rows;

  // One query supplies the chat labels + watermarks for the whole page.
  const conversationIds = [...new Set(page.map((r) => r.message.conversationId))];
  const chats = await db.conversation.findMany({
    where: { id: { in: conversationIds } },
    select: {
      id: true,
      type: true,
      title: true,
      members: {
        where: { leftAt: null },
        select: {
          userId: true,
          clearedAt: true,
          user: { select: { displayName: true, phoneIdentity: { select: { phone: true } } } },
        },
      },
    },
  });
  const byId = new Map(chats.map((c) => [c.id, c]));

  const items: StarredMessage[] = [];
  for (const row of page) {
    const chat = byId.get(row.message.conversationId);
    if (!chat) continue;
    const me = chat.members.find((m) => m.userId === userId);
    if (me?.clearedAt && row.message.createdAt <= me.clearedAt) continue;
    const other = chat.members.find((m) => m.userId !== userId);
    items.push({
      message: serializeMessage(row.message, userId, deps.mediaUrl),
      conversationId: chat.id,
      conversationName:
        chat.type === "GROUP"
          ? chat.title
          : (other?.user.displayName ?? other?.user.phoneIdentity?.phone ?? null),
    });
  }

  const oldest = page[page.length - 1];
  return { items, nextCursor: hasMore && oldest ? oldest.id : null };
}

// ────────────────────────────── pins + links (Phase 5E) ──────────────────────────────

/**
 * Pin / unpin a message for the whole chat (5E). Unlike a star, a pin is shared
 * state, so it is announced to every member — including the actor's other
 * devices — and only the message's own chat may pin it.
 */
export async function setMessagePinned(
  deps: ConversationDeps,
  userId: string,
  messageId: string,
  pinned: boolean,
): Promise<Message> {
  const { db } = deps;
  const message = await db.message.findUnique({ where: { id: messageId } });
  if (!message) throw notFound("Message not found");
  await requireMembership(db, userId, message.conversationId);
  if (message.deletedAt) throw badRequest("Cannot pin a deleted message");

  if (pinned) {
    await db.messagePin.upsert({
      where: { messageId },
      create: { messageId, pinnedById: userId },
      // The first pin wins; re-pinning does not reorder or rename it.
      update: {},
    });
  } else {
    await db.messagePin.deleteMany({ where: { messageId } });
  }

  const full = await db.message.findUniqueOrThrow({
    where: { id: messageId },
    include: messageInclude,
  });
  const serialized = serializeMessage(full, userId, deps.mediaUrl);
  await fanOutAll(db, deps.hub, message.conversationId, {
    type: "message.pin",
    conversationId: message.conversationId,
    messageId,
    pin: serialized.pinned,
  });
  return serialized;
}

/**
 * Pinned messages of a chat, newest pin first. Pins are shared, so the only
 * per-viewer filtering is the one that already hides messages ("for me",
 * cleared chats, expired timers).
 */
export async function listPinned(
  deps: ConversationDeps,
  userId: string,
  conversationId: string,
  opts: { cursor?: string; limit: number },
): Promise<{ pins: ChatPin[]; nextCursor: string | null }> {
  const { db } = deps;
  const member = await requireMembership(db, userId, conversationId);

  const rows = await db.messagePin.findMany({
    where: {
      message: {
        conversationId,
        deletedAt: null,
        ...visibleToViewer(userId, member.clearedAt),
      },
    },
    orderBy: [{ pinnedAt: "desc" }, { id: "desc" }],
    take: opts.limit + 1,
    include: { message: { include: messageInclude } },
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > opts.limit;
  const page = hasMore ? rows.slice(0, opts.limit) : rows;
  const oldest = rows[rows.length - 1];
  return {
    pins: page.map((row) => ({
      message: serializeMessage(row.message, userId, deps.mediaUrl),
      pin: {
        userId: row.pinnedById,
        displayName: row.message.pin?.user?.displayName ?? null,
        pinnedAt: row.pinnedAt.toISOString(),
      },
    })),
    nextCursor: hasMore && oldest ? oldest.id : null,
  };
}

// ────────────────────────────── media gallery + view-once (Phase 5B) ──────────────────────────────

const SHARED_MEDIA_TYPES: PrismaMessageType[] = ["IMAGE", "VIDEO", "DOCUMENT", "VOICE"];

/**
 * The chat's "Media, links and docs" grid: messages that carry attachments,
 * newest first, optionally narrowed to one kind. View-once rows still appear so
 * the grid is complete, but with no URL — the gallery cannot quietly download
 * media whose single view nobody has spent yet.
 */
export async function listSharedMedia(
  deps: ConversationDeps,
  userId: string,
  conversationId: string,
  opts: { cursor?: string; limit: number; kind: SharedMediaKind },
): Promise<{ messages: Message[]; nextCursor: string | null }> {
  const { db, mediaUrl } = deps;
  const member = await requireMembership(db, userId, conversationId);
  const types = opts.kind === "ALL" ? SHARED_MEDIA_TYPES : [opts.kind];

  const rows = await db.message.findMany({
    where: {
      conversationId,
      type: { in: types },
      deletedAt: null,
      ...visibleToViewer(userId, member.clearedAt),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: opts.limit + 1,
    include: messageInclude,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > opts.limit;
  const page = hasMore ? rows.slice(0, opts.limit) : rows;
  const oldest = rows[rows.length - 1];
  return {
    messages: page.map((m) => serializeMessage(m, userId, mediaUrl)),
    nextCursor: hasMore && oldest ? oldest.id : null,
  };
}

/**
 * Links tab of a chat's info screen (5E). Served from the `linkPreview` card
 * scraped at send time, so the tab costs one indexed query instead of
 * re-parsing every message body, and it naturally only lists links we already
 * unfurled server-side.
 */
export async function listChatLinks(
  deps: ConversationDeps,
  userId: string,
  conversationId: string,
  opts: { cursor?: string; limit: number },
): Promise<{ links: ChatLinkItem[]; nextCursor: string | null }> {
  const { db } = deps;
  await requireMembership(db, userId, conversationId);

  const rows = await db.message.findMany({
    where: {
      conversationId,
      deletedAt: null,
      linkPreview: { not: Prisma.DbNull },
      ...visibleToViewer(userId),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: opts.limit + 1,
    select: {
      id: true,
      conversationId: true,
      senderId: true,
      createdAt: true,
      linkPreview: true,
      sender: { select: { displayName: true } },
    },
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > opts.limit;
  const oldest = rows[rows.length - 1];
  // `not: DbNull` is the coarse filter; a card with no usable url is dropped
  // here rather than in SQL, so the query stays portable across JSON dialects.
  const cards = (hasMore ? rows.slice(0, opts.limit) : rows)
    .map((row) => ({ row, preview: serializeJsonValue<LinkPreview>(row.linkPreview) }))
    .filter((entry): entry is { row: (typeof rows)[number]; preview: LinkPreview } =>
      Boolean(entry.preview?.url));

  return {
    links: cards.map(({ row, preview }) => ({
      messageId: row.id,
      conversationId: row.conversationId,
      senderId: row.senderId,
      senderDisplayName: row.sender?.displayName ?? null,
      url: preview.url,
      title: preview.title ?? null,
      description: preview.description ?? null,
      image: preview.image ?? null,
      siteName: preview.siteName ?? null,
      createdAt: row.createdAt.toISOString(),
    })),
    nextCursor: hasMore && oldest ? oldest.id : null,
  };
}

/**
 * Spend the single view of a view-once message: the freshly-signed URLs are
 * returned here and nowhere else, exactly once per viewer. A second open answers
 * 409 with no media, which is the whole promise of the feature.
 */
export async function openViewOnce(
  deps: ConversationDeps,
  userId: string,
  messageId: string,
): Promise<ViewOnceOpenResult> {
  const { db, hub, mediaUrl } = deps;
  const message = await db.message.findFirst({
    where: {
      id: messageId,
      deletedAt: null,
      hiddenBy: { none: { userId } },
      conversation: { members: { some: { userId, leftAt: null, joinState: "ACTIVE" } } },
    },
    include: { attachments: true, viewOnceViews: { where: { userId }, select: { id: true } } },
  });
  if (!message || !message.viewOnce) throw notFound("Message not found");
  if (message.viewOnceViews.length > 0) throw alreadyViewed();

  try {
    await db.viewOnceView.create({ data: { messageId, userId } });
  } catch (err) {
    // The unique (messageId, userId) row is the real guard: two devices racing
    // to open the same message must not both receive URLs.
    if ((err as { code?: string }).code !== "P2002") throw err;
    throw alreadyViewed();
  }

  const members = await db.conversationMember.findMany({
    where: { conversationId: message.conversationId, leftAt: null },
    select: { userId: true },
  });
  hub.publishToUsers(members.map((m) => m.userId), {
    type: "message.viewOnceOpened",
    conversationId: message.conversationId,
    messageId,
    userId,
    viewedAt: new Date().toISOString(),
  });

  return { attachments: serializeAttachments(message.attachments, false, mediaUrl) };
}

const alreadyViewed = () =>
  conflict(ApiErrorCode.Conflict, "This message was already viewed");

// ────────────────────────────── chat export (Phase 5C) ──────────────────────────────

/** Generous but bounded: an export is a user's own history, not a bulk dump. */
const EXPORT_MESSAGE_CAP = 25_000;

/**
 * WhatsApp's "Export chat". Answers the viewer's own transcript — the same
 * visibility rules as `listMessages` (per-viewer deletes, cleared-at
 * watermark) — as a JSON document. `includeMedia` adds short-lived signed
 * download URLs so the client can fetch the bytes and build its own archive;
 * view-once media is never exported, that is its whole promise.
 */
export async function exportChat(
  deps: ConversationDeps,
  userId: string,
  conversationId: string,
  includeMedia: boolean,
): Promise<ChatExportDocument> {
  const { db, mediaUrl } = deps;
  const member = await requireMembership(db, userId, conversationId);
  const conversation = await db.conversation.findUniqueOrThrow({
    where: { id: conversationId },
    select: { type: true, title: true },
  });

  const rows = await db.message.findMany({
    where: {
      conversationId,
      deletedAt: null,
      ...visibleToViewer(userId, member.clearedAt),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: EXPORT_MESSAGE_CAP,
    select: {
      id: true,
      senderId: true,
      type: true,
      body: true,
      viewOnce: true,
      createdAt: true,
      sender: { select: { id: true, displayName: true } },
      attachments: {
        select: {
          kind: true,
          mimeType: true,
          fileName: true,
          sizeBytes: true,
          storageKey: true,
        },
      },
    },
  });

  const messages: ChatExportMessage[] = rows.map((m) => ({
    id: m.id,
    senderId: m.senderId,
    senderName: m.sender?.displayName ?? m.senderId,
    type: m.type as ChatExportMessage["type"],
    body: m.body,
    createdAt: m.createdAt.toISOString(),
    attachments: m.attachments.map<ChatExportAttachment>((a) => ({
      kind: a.kind as ChatExportAttachment["kind"],
      mimeType: a.mimeType,
      fileName: a.fileName,
      sizeBytes: Number(a.sizeBytes),
      mediaUrl: includeMedia && !m.viewOnce ? mediaUrl(a.storageKey) : null,
    })),
  }));

  return {
    conversationId,
    title: conversation.title,
    type: conversation.type as ChatExportDocument["type"],
    exportedAt: new Date().toISOString(),
    messageCount: messages.length,
    mediaCount: messages.reduce((n, m) => n + m.attachments.length, 0),
    messages,
  };
}

// ────────────────────────────── presence ──────────────────────────────

/** Called when a user's last socket closes; persists last-seen for "last seen" UI. */
export async function recordLastSeen(db: PrismaClient, userId: string): Promise<void> {
  await db.user.update({ where: { id: userId }, data: { lastSeenAt: new Date() } });
}

// ────────────────────────────── realtime fan-out ──────────────────────────────

async function fanOut(
  db: PrismaClient,
  hub: RealtimeHub,
  actorId: string,
  conversationId: string,
  event: Parameters<RealtimeHub["publishToUsers"]>[1],
  exclude: string[] = [],
): Promise<void> {
  const others = await db.conversationMember.findMany({
    where: { conversationId, leftAt: null, userId: { notIn: [actorId, ...exclude] } },
    select: { userId: true },
  });
  hub.publishToUsers(
    others.map((m) => m.userId),
    event,
  );
}

/** Same fan-out, every member included (the actor's other devices need it too). */
async function fanOutAll(
  db: PrismaClient,
  hub: RealtimeHub,
  conversationId: string,
  event: Parameters<RealtimeHub["publishToUsers"]>[1],
): Promise<void> {
  const members = await db.conversationMember.findMany({
    where: { conversationId, leftAt: null },
    select: { userId: true },
  });
  hub.publishToUsers(members.map((m) => m.userId), event);
}

/**
 * Which of `candidateIds` have blocked `userId`. The sender is never told —
 * callers use this to silently withhold delivery (spec §28).
 */
export async function blockedRecipients(
  db: PrismaClient,
  userId: string,
  candidateIds: string[],
): Promise<Set<string>> {
  if (candidateIds.length === 0) return new Set();
  const rows = await db.blockedUser.findMany({
    where: { userId: { in: candidateIds }, blockedUserId: userId },
    select: { userId: true },
  });
  return new Set(rows.map((r) => r.userId));
}
