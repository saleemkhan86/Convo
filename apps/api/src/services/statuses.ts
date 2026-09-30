import type { Prisma } from "@prisma/client";
import type {
  CreateStatusRequest,
  ReplyToStatusRequest,
  ReplyToStatusResult,
  StatusItem,
  StatusList,
  StatusMute,
  StatusViewer,
} from "@convo/shared";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import type { MediaStorage } from "../media/index.js";
import {
  openDirectChat,
  sendMessage,
  type ConversationDeps,
  type SendMessageInput,
} from "./conversations.js";

/**
 * Ephemeral statuses (Phase 4B), WhatsApp-style: text / photo / video / link,
 * auto-expiring (default 24h, user-selectable), with audience privacy:
 * EVERYONE, CONTACTS (mutual contact book), CUSTOM (allow-list), or
 * CONTACTS_EXCEPT (block-list).
 */

/** `mediaUrl` comes from ConversationDeps: statuses and chats sign media alike. */
export interface StatusDeps extends ConversationDeps {
  media: MediaStorage;
}

type StatusRow = Prisma.StatusGetPayload<{
  include: { author: { include: { phoneIdentity: true } }; views: { select: { userId: true } } };
}>;

function statusSelect(viewerId: string) {
  return {
    id: true,
    authorId: true,
    kind: true,
    text: true,
    storageKey: true,
    mimeType: true,
    visibility: true,
    audience: true,
    excluded: true,
    shareReadReceipts: true,
    createdAt: true,
    expiresAt: true,
    author: { select: { id: true, displayName: true, avatarUrl: true } },
    views: { where: { userId: viewerId }, select: { userId: true } },
    _count: { select: { views: true } },
  } satisfies Prisma.StatusSelect;
}

type StatusPageRow = Prisma.StatusGetPayload<{ select: ReturnType<typeof statusSelect> }>;

function serialize(s: StatusPageRow, viewerId: string, deps: StatusDeps): StatusItem {
  const isMine = s.authorId === viewerId;
  return {
    id: s.id,
    author: {
      userId: s.author.id,
      displayName: s.author.displayName,
      avatarUrl: s.author.avatarUrl,
    },
    kind: s.kind,
    text: s.text,
    mediaUrl: s.storageKey ? deps.mediaUrl(s.storageKey) : null,
    visibility: s.visibility,
    createdAt: s.createdAt.toISOString(),
    expiresAt: s.expiresAt.toISOString(),
    viewCount: isMine ? s._count.views : null,
    hasViews: isMine ? s._count.views > 0 : null,
    shareReadReceipts: s.shareReadReceipts,
    seenByMe: !isMine && s.views.length > 0,
    isMine,
  };
}

/** Whether `viewerId` may see `status` under its audience rules. */
export function matchesAudience(status: { visibility: string; audience: string[]; excluded: string[]; authorId: string }, viewerId: string, contactIds: Set<string>): boolean {
  if (status.authorId === viewerId) return true;
  switch (status.visibility) {
    case "EVERYONE":
      return true;
    case "CONTACTS":
      return contactIds.has(viewerId);
    case "CUSTOM":
      return status.audience.includes(viewerId);
    case "CONTACTS_EXCEPT":
      return contactIds.has(viewerId) && !status.excluded.includes(viewerId);
    default:
      return false;
  }
}

/** Accounts that count as "contacts" of the author (either direction). */
async function contactIdsOf(db: ConversationDeps["db"], userId: string): Promise<Set<string>> {
  const rows = await db.contact.findMany({
    where: { OR: [{ ownerId: userId }, { convoUserId: userId }] },
    select: { ownerId: true, convoUserId: true },
  });
  const set = new Set<string>();
  for (const row of rows) {
    if (row.ownerId !== userId && row.ownerId) set.add(row.ownerId);
    if (row.convoUserId !== userId && row.convoUserId) set.add(row.convoUserId);
  }
  return set;
}

export async function createStatus(
  deps: StatusDeps,
  userId: string,
  req: CreateStatusRequest,
): Promise<StatusItem> {
  if (req.kind === "IMAGE" || req.kind === "VIDEO") {
    if (!req.storageKey) throw badRequest("Upload the media before posting a status");
  }

  const expiresAt = new Date(Date.now() + req.durationHours * 3600_000);
  let audience: string[] = [];
  let excluded: string[] = [];
  if (req.visibility === "CUSTOM") {
    audience = [...new Set(req.userIds)].filter((id) => id !== userId);
    if (audience.length === 0) throw badRequest("Choose at least one audience member");
  } else if (req.visibility === "CONTACTS_EXCEPT") {
    excluded = [...new Set(req.userIds)];
  }

  const created = await deps.db.status.create({
    data: {
      authorId: userId,
      kind: req.kind,
      text: req.text ?? null,
      storageKey: req.storageKey ?? null,
      mimeType: req.mimeType ?? null,
      visibility: req.visibility,
      audience,
      excluded,
      shareReadReceipts: req.shareReadReceipts,
      expiresAt,
    },
    select: statusSelect(userId),
  });

  await fanOutNewStatus(deps, userId, created);
  return serialize(created, userId, deps);
}

async function fanOutNewStatus(
  deps: StatusDeps,
  authorId: string,
  item: StatusPageRow,
): Promise<void> {
  const rule = { visibility: item.visibility, audience: item.audience, excluded: item.excluded };
  let recipients: string[];
  if (rule.visibility === "CUSTOM") {
    recipients = rule.audience;
  } else if (rule.visibility === "EVERYONE") {
    const users = await deps.db.user.findMany({
      where: { id: { not: authorId }, status: "ACTIVE" },
      select: { id: true },
    });
    recipients = users.map((u) => u.id);
  } else {
    // CONTACTS / CONTACTS_EXCEPT: only the author's saved contacts may view.
    const contacts = await deps.db.contact.findMany({
      where: { ownerId: authorId, convoUserId: { not: null } },
      select: { convoUserId: true },
    });
    const set = new Set(contacts.map((c) => c.convoUserId as string));
    if (rule.visibility === "CONTACTS_EXCEPT") for (const id of rule.excluded) set.delete(id);
    recipients = [...set];
  }

  const online = recipients.filter((id) => deps.hub.isOnline(id));
  if (online.length === 0) return;
  // A muted author's posts never arrive live either — otherwise "mute" would
  // only apply on the next pull and the ring would keep lighting up.
  const mutes = await deps.db.statusMute.findMany({
    where: { authorId, userId: { in: online } },
    select: { userId: true },
  });
  const muted = new Set(mutes.map((m) => m.userId));
  const audience = online.filter((id) => !muted.has(id));
  if (audience.length === 0) return;
  // Status payloads carry per-viewer fields; fan-out uses a neutral copy.
  const neutral: StatusItem = {
    ...serialize(item, authorId, deps),
    viewCount: null,
    hasViews: null,
    seenByMe: false,
  };
  deps.hub.publishToUsers(audience, { type: "status.new", status: neutral });
}

export async function listStatuses(
  deps: StatusDeps,
  userId: string,
): Promise<StatusList> {
  const now = new Date();
  // Lazy cleanup of this author's expired statuses (their media too).
  const expiredMine = await deps.db.status.findMany({
    where: { authorId: userId, expiresAt: { lt: now } },
    select: { id: true, storageKey: true },
  });
  if (expiredMine.length > 0) {
    await deps.db.status.deleteMany({ where: { id: { in: expiredMine.map((e) => e.id) } } });
  }

  const contactIds = await contactIdsOf(deps.db, userId);
  // Muted authors (5D) drop out of the feed entirely; their statuses stay
  // reachable again the moment the viewer unmutes them.
  const mutedRows = await deps.db.statusMute.findMany({
    where: { userId },
    select: { authorId: true },
  });
  const muted = new Set(mutedRows.map((m) => m.authorId));

  const mine = await deps.db.status.findMany({
    where: { authorId: userId, expiresAt: { gte: now } },
    orderBy: { createdAt: "desc" },
    select: statusSelect(userId),
  });

  const all = await deps.db.status.findMany({
    where: { authorId: { not: userId }, expiresAt: { gte: now }, author: { status: "ACTIVE" } },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: statusSelect(userId),
  });

  return {
    mine: mine.map((s) => serialize(s, userId, deps)),
    others: all
      .filter((s) => !muted.has(s.authorId) && matchesAudience(s, userId, contactIds))
      .map((s) => serialize(s, userId, deps)),
  };
}

export async function markStatusViewed(
  deps: StatusDeps,
  userId: string,
  statusId: string,
): Promise<{ ok: true }> {
  const status = await deps.db.status.findUnique({
    where: { id: statusId },
    select: {
      id: true,
      authorId: true,
      visibility: true,
      audience: true,
      excluded: true,
      shareReadReceipts: true,
      expiresAt: true,
    },
  });
  if (!status || status.expiresAt < new Date()) throw notFound("Status not found");
  if (status.authorId === userId) return { ok: true };

  const contactIds = await contactIdsOf(deps.db, status.authorId);
  if (!matchesAudience(status, userId, contactIds)) throw notFound("Status not found");

  // The author turned receipts off (5D): the view is simply never recorded, so
  // there is nothing to reveal later. The viewer's own client still knows it
  // has watched this status.
  if (!status.shareReadReceipts) return { ok: true };

  const existing = await deps.db.statusView.findUnique({
    where: { statusId_userId: { statusId, userId } },
  });
  if (existing) return { ok: true };

  const view = await deps.db.statusView.create({
    data: { statusId, userId },
    include: { user: { select: { id: true, displayName: true, avatarUrl: true } } },
  });
  deps.hub.publishToUsers([status.authorId], {
    type: "status.viewed",
    statusId,
    viewer: {
      userId: view.user.id,
      displayName: view.user.displayName,
      avatarUrl: view.user.avatarUrl,
      viewedAt: view.viewedAt.toISOString(),
    },
  });
  return { ok: true };
}

export async function listStatusViewers(
  deps: StatusDeps,
  userId: string,
  statusId: string,
): Promise<StatusViewer[]> {
  const status = await deps.db.status.findUnique({ where: { id: statusId }, select: { authorId: true } });
  if (!status) throw notFound("Status not found");
  if (status.authorId !== userId) throw forbidden("Only the author can see who viewed a status");

  const views = await deps.db.statusView.findMany({
    where: { statusId },
    orderBy: { viewedAt: "desc" },
    include: { user: { select: { id: true, displayName: true, avatarUrl: true } } },
  });
  return views.map((v) => ({
    userId: v.user.id,
    displayName: v.user.displayName,
    avatarUrl: v.user.avatarUrl,
    viewedAt: v.viewedAt.toISOString(),
  }));
}

export async function deleteStatus(
  deps: StatusDeps,
  userId: string,
  statusId: string,
): Promise<{ ok: true }> {
  const status = await deps.db.status.findUnique({ where: { id: statusId } });
  if (!status) throw notFound("Status not found");
  if (status.authorId !== userId) throw forbidden("You can only delete your own statuses");

  await deps.db.status.delete({ where: { id: statusId } });
  return { ok: true };
}

/**
 * Answer someone's status (Phase 5D): the reply is a normal 1-1 message to its
 * author, carrying the quoted status as its reply preview. The chat is opened
 * on demand, so viewing a status is enough to answer it.
 */
export async function replyToStatus(
  deps: StatusDeps,
  userId: string,
  statusId: string,
  req: ReplyToStatusRequest,
): Promise<ReplyToStatusResult> {
  const status = await deps.db.status.findUnique({
    where: { id: statusId },
    select: {
      id: true,
      authorId: true,
      visibility: true,
      audience: true,
      excluded: true,
      expiresAt: true,
    },
  });
  // Unknown, expired and not-for-you all read the same way: you cannot reply to
  // a status you were never allowed to open.
  if (!status || status.expiresAt < new Date()) throw notFound("Status not found");
  if (status.authorId === userId) throw badRequest("You cannot reply to your own status");

  const contactIds = await contactIdsOf(deps.db, status.authorId);
  if (!matchesAudience(status, userId, contactIds)) throw notFound("Status not found");

  const conversationId = await openDirectChat(deps, userId, status.authorId);
  const input: SendMessageInput = {
    clientMessageId: req.clientMessageId,
    body: req.body,
    statusReplyToId: status.id,
  };
  const message = await sendMessage(deps, userId, conversationId, input);
  return { conversationId, message };
}

// ────────────────────────────── muting an author ──────────────────────────────

export async function muteStatusAuthor(
  deps: StatusDeps,
  userId: string,
  authorId: string,
): Promise<{ ok: true }> {
  if (authorId === userId) throw badRequest("You cannot mute your own statuses");
  const author = await deps.db.user.findUnique({
    where: { id: authorId },
    select: { id: true, status: true },
  });
  if (!author || author.status !== "ACTIVE") throw notFound("Status not found");

  await deps.db.statusMute.upsert({
    where: { userId_authorId: { userId, authorId } },
    create: { userId, authorId },
    update: {},
  });
  return { ok: true };
}

export async function unmuteStatusAuthor(
  deps: StatusDeps,
  userId: string,
  authorId: string,
): Promise<{ ok: true }> {
  await deps.db.statusMute.deleteMany({ where: { userId, authorId } });
  return { ok: true };
}

export async function listStatusMutes(deps: StatusDeps, userId: string): Promise<StatusMute[]> {
  const rows = await deps.db.statusMute.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    include: { author: { select: { id: true, displayName: true, avatarUrl: true } } },
  });
  return rows.map((r) => ({
    userId: r.author.id,
    displayName: r.author.displayName,
    avatarUrl: r.author.avatarUrl,
    mutedAt: r.createdAt.toISOString(),
  }));
}
