import type { PrismaClient, Prisma } from "@prisma/client";
import type {
  BlockedUser,
  Contact,
  ReportRequest,
  ReportResult,
  RecentRecipient,
  SearchMatch,
  UpsertContactRequest,
  UserCard,
  GlobalSearchResult,
} from "@convo/shared";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import {
  messageInclude,
  serializeMessage,
  summarize,
  lastSeenVisibleTo,
  type MediaUrlFor,
} from "./conversations.js";
import { fieldVisibleToUser, PROFILE_QUERY } from "./privacy.js";
import { summaryOf } from "./groups.js";

/**
 * Contacts, blocking, reporting and search (Phase 5A, spec §9, §10, §28).
 *
 * A Contact belongs to its owner alone; the server never exposes one address
 * book to another user. Resolving a contact to a Convo account only ever uses
 * a verified identity row, so a typo in the address book cannot claim someone
 * else's account.
 */

export interface ContactDeps {
  db: PrismaClient;
  /** Search results show messages, so they need media URLs signed per response. */
  mediaUrl: MediaUrlFor;
}

type MsgRow = Prisma.MessageGetPayload<{ include: typeof messageInclude }>;

function toContact(c: {
  id: string;
  displayName: string;
  phone: string | null;
  email: string | null;
  avatarUrl: string | null;
  source: Contact["source"];
  convoUserId: string | null;
  createdAt: Date;
}): Contact {
  return {
    id: c.id,
    displayName: c.displayName,
    phone: c.phone,
    email: c.email,
    avatarUrl: c.avatarUrl,
    source: c.source,
    convoUserId: c.convoUserId,
    createdAt: c.createdAt.toISOString(),
  };
}

/**
 * Best-effort account resolution for an address-book entry. Only verified
 * identity rows match, and a deactivated account does not.
 */
async function resolveConvoUserId(
  db: PrismaClient,
  phone?: string | null,
  email?: string | null,
): Promise<string | null> {
  if (phone) {
    const row = await db.phoneIdentity.findUnique({
      where: { phone },
      include: { user: { select: { id: true, status: true } } },
    });
    if (row?.user.status === "ACTIVE") return row.userId;
  }
  if (email) {
    const row = await db.emailIdentity.findUnique({
      where: { email },
      include: { user: { select: { id: true, status: true } } },
    });
    if (row?.user.status === "ACTIVE") return row.userId;
  }
  return null;
}

// ────────────────────────────── contacts ──────────────────────────────

export async function listContacts(
  { db }: ContactDeps,
  ownerId: string,
): Promise<{ contacts: Contact[] }> {
  const rows = await db.contact.findMany({
    where: { ownerId },
    orderBy: [{ displayName: "asc" }, { id: "asc" }],
  });
  return { contacts: rows.map(toContact) };
}

/** Create, or update the row that already owns this phone/email for this user. */
export async function upsertContact(
  { db }: ContactDeps,
  ownerId: string,
  req: UpsertContactRequest,
): Promise<Contact> {
  const existing = req.id
    ? await db.contact.findFirst({ where: { id: req.id, ownerId } })
    : await db.contact.findFirst({
        where: {
          ownerId,
          OR: [
            ...(req.phone ? [{ phone: req.phone }] : []),
            ...(req.email ? [{ email: req.email }] : []),
          ],
        },
      });
  if (req.id && !existing) throw notFound("Contact not found");

  const convoUserId = await resolveConvoUserId(db, req.phone, req.email);
  const data = {
    displayName: req.displayName,
    phone: req.phone ?? existing?.phone ?? null,
    email: req.email ?? existing?.email ?? null,
    avatarUrl: req.avatarUrl ?? existing?.avatarUrl ?? null,
    convoUserId,
  };

  const row = existing
    ? await db.contact.update({ where: { id: existing.id }, data })
    : await db.contact.create({ data: { ...data, ownerId, source: "MANUAL" } });
  return toContact(row);
}

export async function deleteContact(
  { db }: ContactDeps,
  ownerId: string,
  id: string,
): Promise<void> {
  const deleted = await db.contact.deleteMany({ where: { id, ownerId } });
  if (deleted.count === 0) throw notFound("Contact not found");
}

/**
 * "Message new chat" recents: the DIRECT peers this user talked to most
 * recently. Contacts win the display name when the viewer has saved them.
 */
export async function listRecentRecipients(
  { db }: ContactDeps,
  ownerId: string,
  limit: number,
): Promise<{ recipients: RecentRecipient[] }> {
  const memberships = await db.conversationMember.findMany({
    where: {
      userId: ownerId,
      leftAt: null,
      hidden: false,
      conversation: { type: "DIRECT", members: { none: { joinState: "PENDING" } } },
    },
    include: {
      conversation: {
        include: {
          members: {
            where: { leftAt: null },
            include: { user: { include: { phoneIdentity: true } } },
          },
        },
      },
    },
    orderBy: [{ conversation: { lastMessageAt: "desc" } }, { id: "asc" }],
    take: limit,
  });

  const recipients: RecentRecipient[] = [];
  for (const m of memberships) {
    const other = m.conversation.members.find((x) => x.userId !== ownerId);
    if (!other) continue;
    recipients.push({
      userId: other.userId,
      displayName: other.user.displayName,
      avatarUrl: other.user.avatarUrl,
      phone: other.user.phoneIdentity?.phone ?? null,
      conversationId: m.conversationId,
      lastMessageAt: m.conversation.lastMessageAt?.toISOString() ?? null,
    });
  }
  return { recipients };
}

// ────────────────────────────── blocking ──────────────────────────────

/**
 * Block a user, by account id or by phone number. An unknown or deactivated
 * phone answers with the same generic 404 the chat-start flow uses, so this
 * cannot be used to test whether a number has a Convo account.
 */
export async function blockUser(
  { db }: ContactDeps,
  ownerId: string,
  req: { userId?: string; phone?: string },
): Promise<BlockedUser> {
  const targetId = await resolveBlockTarget(db, ownerId, req);
  await db.blockedUser.upsert({
    where: { userId_blockedUserId: { userId: ownerId, blockedUserId: targetId } },
    create: { userId: ownerId, blockedUserId: targetId },
    update: {},
  });
  const card = await blockedCard(db, ownerId, targetId);
  if (!card) throw notFound("User not found");
  return card;
}

export async function unblockUser(
  { db }: ContactDeps,
  ownerId: string,
  userId: string,
): Promise<void> {
  await db.blockedUser.deleteMany({ where: { userId: ownerId, blockedUserId: userId } });
}

export async function listBlocked(
  { db }: ContactDeps,
  ownerId: string,
): Promise<{ blocked: BlockedUser[] }> {
  const rows = await db.blockedUser.findMany({
    where: { userId: ownerId },
    include: { blocked: { include: { phoneIdentity: true } } },
    orderBy: { createdAt: "desc" },
  });
  return {
    blocked: rows.map((r) => ({
      userId: r.blockedUserId,
      displayName: r.blocked.displayName,
      avatarUrl: r.blocked.avatarUrl,
      phone: r.blocked.phoneIdentity?.phone ?? null,
      blockedAt: r.createdAt.toISOString(),
    })),
  };
}

async function resolveBlockTarget(
  db: PrismaClient,
  ownerId: string,
  req: { userId?: string; phone?: string },
): Promise<string> {
  if (req.userId) {
    if (req.userId === ownerId) throw badRequest("You cannot block your own account");
    const user = await db.user.findFirst({
      where: { id: req.userId, status: "ACTIVE" },
      select: { id: true },
    });
    if (!user) throw notFound("No Convo account found for that phone number");
    return user.id;
  }
  const identity = await db.phoneIdentity.findUnique({
    where: { phone: req.phone ?? "" },
    include: { user: { select: { id: true, status: true } } },
  });
  if (!identity || identity.user.status !== "ACTIVE" || identity.userId === ownerId) {
    throw notFound("No Convo account found for that phone number");
  }
  return identity.userId;
}

async function blockedCard(
  db: PrismaClient,
  blockerId: string,
  blockedId: string,
): Promise<BlockedUser | null> {
  const row = await db.blockedUser.findUnique({
    where: { userId_blockedUserId: { userId: blockerId, blockedUserId: blockedId } },
  });
  if (!row) return null;
  const user = await db.user.findUnique({
    where: { id: blockedId },
    include: { phoneIdentity: true },
  });
  return {
    userId: blockedId,
    displayName: user?.displayName ?? null,
    avatarUrl: user?.avatarUrl ?? null,
    phone: user?.phoneIdentity?.phone ?? null,
    blockedAt: row.createdAt.toISOString(),
  };
}

// ────────────────────────────── reporting ──────────────────────────────

const REASONS: Record<ReportRequest["reason"], string> = {
  SPAM: "SPAM",
  ABUSE: "ABUSE",
  HARASSMENT: "HARASSMENT",
  FRAUD: "FRAUD",
  VIOLENT: "VIOLENT",
  IMPERSONATION: "IMPERSONATION",
  OTHER: "OTHER",
};

/**
 * File a moderation report. The target must be something the reporter can
 * actually see, so the endpoint cannot be used to probe ids. When
 * `blockAfterReport` is set the reporter also blocks the account behind the
 * target (the sender of a message, the peer of a direct chat).
 */
export async function reportTarget(
  { db }: ContactDeps,
  reporterId: string,
  req: ReportRequest,
): Promise<ReportResult> {
  let accountableUserId: string | null = null;

  if (req.targetType === "USER") {
    if (req.targetId === reporterId) throw forbidden("You cannot report your own account");
    const user = await db.user.findFirst({
      where: { id: req.targetId, status: "ACTIVE" },
      select: { id: true },
    });
    if (!user) throw notFound("Report target not found");
    accountableUserId = user.id;
  } else if (req.targetType === "MESSAGE") {
    const message = await db.message.findFirst({
      where: {
        id: req.targetId,
        conversation: { members: { some: { userId: reporterId, leftAt: null } } },
      },
    });
    if (!message) throw notFound("Report target not found");
    accountableUserId = message.senderId;
  } else {
    const conv = await db.conversation.findFirst({
      where: { id: req.targetId, members: { some: { userId: reporterId, leftAt: null } } },
      include: { members: { where: { leftAt: null }, select: { userId: true } } },
    });
    if (!conv) throw notFound("Report target not found");
    const peer = conv.members.find((m) => m.userId !== reporterId);
    accountableUserId = conv.type === "DIRECT" ? (peer?.userId ?? null) : null;
  }

  const report = await db.report.create({
    data: {
      reporterId,
      targetType: req.targetType,
      targetId: req.targetId,
      reason: REASONS[req.reason],
      details: req.details ?? null,
    },
  });

  let blocked = false;
  if (req.blockAfterReport && accountableUserId && accountableUserId !== reporterId) {
    await db.blockedUser.upsert({
      where: { userId_blockedUserId: { userId: reporterId, blockedUserId: accountableUserId } },
      create: { userId: reporterId, blockedUserId: accountableUserId },
      update: {},
    });
    blocked = true;
  }
  return { id: report.id, blocked };
}

// ────────────────────────────── contact info ──────────────────────────────

/**
 * The contact-info card for one account, as seen by `viewerId`. Phone numbers
 * are only revealed when the viewer saved the person as a contact or they
 * share a chat; last-seen follows the target's own visibility setting.
 */
export async function getUserCard(
  { db }: ContactDeps,
  viewerId: string,
  targetId: string,
): Promise<UserCard> {
  if (targetId === viewerId) {
    const me = await db.user.findUniqueOrThrow({
      where: { id: viewerId },
      include: { phoneIdentity: true },
    });
    return {
      userId: me.id,
      displayName: me.displayName,
      avatarUrl: me.avatarUrl,
      bio: me.bio,
      phone: me.phoneIdentity?.phone ?? null,
      lastSeenAt: me.lastSeenAt?.toISOString() ?? null,
      blockedByMe: false,
      sharedConversationId: null,
    };
  }

  const target = await db.user.findFirst({
    where: { id: targetId, status: "ACTIVE" },
    ...PROFILE_QUERY,
  });
  if (!target) throw notFound("User not found");

  const [blocked, shared, asContact] = await Promise.all([
    db.blockedUser.findUnique({
      where: { userId_blockedUserId: { userId: viewerId, blockedUserId: targetId } },
      select: { id: true },
    }),
    db.conversation.findFirst({
      where: {
        type: "DIRECT",
        members: { some: { userId: viewerId, leftAt: null } },
        AND: { members: { some: { userId: targetId, leftAt: null } } },
      },
      select: { id: true },
    }),
    db.contact.findFirst({
      where: { ownerId: viewerId, convoUserId: targetId },
      select: { id: true },
    }),
  ]);

  // Phase 5C: avatar, about and last-seen each answer to their own audience;
  // the viewer's own saved copy of a contact always keeps their local data.
  const [lastSeenOk, avatarOk, aboutOk] = await Promise.all([
    lastSeenVisibleTo(db, viewerId, target),
    fieldVisibleToUser(db, viewerId, target, "avatar"),
    fieldVisibleToUser(db, viewerId, target, "about"),
  ]);
  const showPhone = asContact !== null || shared !== null || target.presenceVisibility === "EVERYONE";

  return {
    userId: target.id,
    displayName: target.displayName,
    avatarUrl: avatarOk ? target.avatarUrl : null,
    bio: aboutOk ? target.bio : null,
    phone: showPhone ? (target.phoneIdentity?.phone ?? null) : null,
    lastSeenAt: lastSeenOk ? (target.lastSeenAt?.toISOString() ?? null) : null,
    blockedByMe: blocked !== null,
    sharedConversationId: shared?.id ?? null,
  };
}

// ────────────────────────────── global search ──────────────────────────────

/**
 * One query across the caller's own data: address book, chats, message bodies
 * and public groups. Everything is scoped to rows the viewer already has
 * access to, and nothing here is a search over other people's private data.
 */
export async function globalSearch(
  deps: ContactDeps,
  userId: string,
  q: string,
  limit: number,
): Promise<GlobalSearchResult> {
  const { db, mediaUrl } = deps;
  const contains = { contains: q, mode: "insensitive" as const };
  const activeMembership = { some: { userId, leftAt: null, joinState: "ACTIVE" as const, hidden: false } };

  const [contacts, messageRows, conversationRows] = await Promise.all([
    db.contact.findMany({
      where: {
        ownerId: userId,
        OR: [{ displayName: contains }, ...(q.startsWith("+") ? [{ phone: { contains: q } }] : []), { email: contains }],
      },
      orderBy: [{ displayName: "asc" }, { id: "asc" }],
      take: limit,
    }),
    db.message.findMany({
      where: {
        body: contains,
        type: { not: "SYSTEM" },
        deletedAt: null,
        hiddenBy: { none: { userId } },
        conversation: { members: activeMembership },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
      include: messageInclude,
    }),
    db.conversation.findMany({
      where: {
        members: activeMembership,
        OR: [
          { title: contains },
          { members: { some: { leftAt: null, user: { displayName: contains } } } },
          { members: { some: { leftAt: null, user: { phoneIdentity: { phone: { contains: q } } } } } },
        ],
      },
      orderBy: { lastMessageAt: "desc" },
      take: limit,
      select: { id: true },
    }),
  ]);

  const messages: SearchMatch[] = await Promise.all(
    messageRows.map(async (row) => ({
      message: serializeMessage(row as MsgRow, userId, mediaUrl),
      conversationId: row.conversationId,
      conversationName: await chatLabel(db, userId, row.conversationId),
    })),
  );

  const groups = await db.conversation.findMany({
    where: {
      type: "GROUP",
      title: contains,
      group: { visibility: "PUBLIC" },
      members: { none: { userId, leftAt: null } },
    },
    include: { group: true, members: true },
    orderBy: { lastMessageAt: "desc" },
    take: limit,
  });

  return {
    query: q,
    contacts: contacts.map(toContact),
    conversations: await Promise.all(
      conversationRows.map((c) => summarize({ db, mediaUrl }, userId, c.id)),
    ),
    messages,
    groups: groups.map((conv) => summaryOf(conv, null, false, mediaUrl)),
  };
}

/** Display label for a chat: group title, or the other person's name. */
async function chatLabel(
  db: PrismaClient,
  userId: string,
  conversationId: string,
): Promise<string | null> {
  const conv = await db.conversation.findUnique({
    where: { id: conversationId },
    select: {
      type: true,
      title: true,
      members: {
        where: { leftAt: null },
        select: { userId: true, user: { select: { displayName: true, phoneIdentity: { select: { phone: true } } } } },
      },
    },
  });
  if (!conv) return null;
  if (conv.type === "GROUP") return conv.title;
  const other = conv.members.find((m) => m.userId !== userId);
  return other?.user.displayName ?? other?.user.phoneIdentity?.phone ?? null;
}
