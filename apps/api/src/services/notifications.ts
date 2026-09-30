import type { Prisma, PrismaClient } from "@prisma/client";
import {
  inQuietHours,
  type DismissNotificationsRequest,
  type ListNotificationsQuery,
  type MarkNotificationsReadRequest,
  type NotificationItem,
  type NotificationList,
  type NotificationType,
  type QuietHours,
  type UnreadNotificationCount,
} from "@convo/shared";
import type { RealtimeHub } from "./realtime.js";
import type { PushTransport } from "./push.js";

/**
 * The notification centre (Phase 5G).
 *
 * Three separate questions get three separate answers, which is the whole point
 * of this module:
 *
 * 1. *Did it happen?* → always write the row. The centre is history and the
 *    unread badge is counted from it; muting a chat does not erase the fact that
 *    forty messages arrived.
 * 2. *Do awake devices hear about it?* → always emit `notification.new`. The
 *    bell is per-viewer state, and a second device that never opened the chat
 *    still has to learn a badge exists.
 * 3. *Should a closed app be woken?* → only if the recipient's own settings
 *    allow it. This is the one the prefs govern, and the one that cannot be
 *    delegated to a client: a push is rendered by the OS, outside any app, so
 *    the server must be what withholds the sender and the body when previews
 *    are off.
 */

export interface NotifyDeps {
  db: PrismaClient;
  hub: Pick<RealtimeHub, "publishToUsers">;
  push?: PushTransport;
}

/** What happened, as much of it as the caller has to hand. */
export interface NotifyEvent {
  /** Who is being told — never the actor, and never more than one user per call. */
  userId: string;
  type: NotificationType;
  title: string;
  body?: string | null;
  actorId?: string | null;
  conversationId?: string | null;
  messageId?: string | null;
  callId?: string | null;
}

/** Why a push was withheld. Returned rather than logged so tests and the
 * settings screen can read the same answer the server acted on. */
export type SuppressReason =
  | "GLOBAL_MUTED"
  | "QUIET_HOURS"
  | "CHAT_TIMED_MUTE"
  | "CHAT_NOTHING"
  | "CHAT_MENTIONS_ONLY";

export interface RecipientPrefs {
  notifyMuted: boolean;
  notifyPreview: boolean;
  quietHours: QuietHours | null;
}

export interface ChatPrefs {
  notifyMode: "ALL" | "MENTIONS_ONLY" | "NOTHING";
  mutedUntil: Date | null;
}

const CHAT_TYPES: readonly NotificationType[] = ["CHAT_MESSAGE", "MENTION"];

/**
 * What a preview-free alert may honestly say. None of these name a sender or
 * quote a message: with previews off that is all a locked screen ever gets.
 */
const NEUTRAL_TITLE: Record<NotificationType, string> = {
  CHAT_MESSAGE: "New message",
  MENTION: "Someone mentioned you",
  MAIL_MESSAGE: "New email",
  CALL_MISSED: "Missed call",
  SYSTEM: "Convo",
};

/**
 * The one place mute rules are decided, so the phone, the browser and the push
 * payload can never disagree about whether an alert is allowed.
 *
 * A timed mute (5A) or `NOTHING` silences everything, mentions included —
 * that is what "mute" promises. `MENTIONS_ONLY` is the one setting that keeps a
 * group quiet while still letting a message written *to you* through.
 */
export function suppressionOf(
  prefs: RecipientPrefs,
  chat: ChatPrefs | null,
  type: NotificationType,
  now: Date,
): SuppressReason | null {
  if (prefs.notifyMuted) return "GLOBAL_MUTED";
  if (inQuietHours(prefs.quietHours, now)) return "QUIET_HOURS";
  if (!chat || !CHAT_TYPES.includes(type)) return null;
  if (chat.mutedUntil && chat.mutedUntil.getTime() > now.getTime()) return "CHAT_TIMED_MUTE";
  if (chat.notifyMode === "NOTHING") return "CHAT_NOTHING";
  if (chat.notifyMode === "MENTIONS_ONLY" && type !== "MENTION") return "CHAT_MENTIONS_ONLY";
  return null;
}

/**
 * Tell one user about one event. Returns the centre row, or null when there is
 * nobody to tell (account gone) or the event is their own.
 */
export async function notifyUser(
  deps: NotifyDeps,
  event: NotifyEvent,
): Promise<NotificationItem | null> {
  // Your own message from another device is not news to you.
  if (event.actorId === event.userId && event.type !== "SYSTEM") return null;

  const recipient = await loadRecipientPrefs(deps.db, event.userId);
  if (!recipient) return null;

  const chat = event.conversationId
    ? await loadChatPrefs(deps.db, event.userId, event.conversationId)
    : null;
  const suppressed = suppressionOf(recipient, chat, event.type, new Date());
  const dedupeKey = event.conversationId ? `${event.type}:${event.conversationId}` : null;

  const row = await writeNotification(deps.db, {
    userId: event.userId,
    type: event.type,
    title: event.title,
    body: event.body ?? null,
    actorId: event.actorId ?? null,
    conversationId: event.conversationId ?? null,
    messageId: event.messageId ?? null,
    callId: event.callId ?? null,
    dedupeKey,
  });

  const item = serializeNotification(row, recipient.notifyPreview);
  deps.hub.publishToUsers([event.userId], { type: "notification.new", notification: item });

  if (!suppressed) {
    // Fire and forget: a push that fails in the background must not fail the
    // request that caused it, and a retry is the next alert's job.
    void deps.push
      ?.send(event.userId, {
        title: item.title,
        body: item.body,
        type: event.type,
        tag: dedupeKey ?? `${event.type}:${row.id}`,
        data: pushData(event),
        ttlSeconds: 24 * 3600,
      })
      ?.catch(() => undefined);
  }
  return item;
}

/**
 * Collapse, don't pile up. A repeat alert for the same chat updates the one
 * live row, so the shade shows "Sam: 4 messages" instead of four lines — the
 * reason `dedupeKey` is unique per (kind, chat). Reading ends the collapse: the
 * next message starts a fresh count of one.
 */
async function writeNotification(
  db: PrismaClient,
  input: {
    userId: string;
    type: NotificationType;
    title: string;
    body: string | null;
    actorId: string | null;
    conversationId: string | null;
    messageId: string | null;
    callId: string | null;
    dedupeKey: string | null;
  },
): Promise<NotificationRow> {
  const data = {
    type: input.type,
    title: input.title,
    body: input.body,
    actorId: input.actorId,
    conversationId: input.conversationId,
    messageId: input.messageId,
    callId: input.callId,
  };
  if (!input.dedupeKey) {
    return db.notification.create({ data: { ...data, userId: input.userId }, ...withActor });
  }

  const where = { userId_dedupeKey: { userId: input.userId, dedupeKey: input.dedupeKey } };
  const existing = await db.notification.findUnique({
    where,
    select: { readAt: true, count: true },
  });
  if (!existing) {
    try {
      return await db.notification.create({
        data: { ...data, userId: input.userId, dedupeKey: input.dedupeKey, count: 1 },
        ...withActor,
      });
    } catch {
      // A concurrent writer claimed the key between the read and the create.
      // Rounding its count down by one is a cosmetic loss; dropping the alert
      // would not be, so fall through to the update.
    }
  }
  return db.notification.update({
    where,
    data: {
      ...data,
      // Already read means the previous count was seen — start over at one.
      count: existing && existing.readAt === null ? existing.count + 1 : 1,
      readAt: null,
      dismissedAt: null,
    },
    ...withActor,
  });
}

const withActor = {
  include: { actor: { select: { id: true, displayName: true, avatarUrl: true } } },
} as const;

type NotificationRow = Prisma.NotificationGetPayload<typeof withActor>;

/**
 * Previews are a *display* rule, not a storage rule: the row keeps its content,
 * and this decides what a reader sees. So turning previews back on reveals the
 * alerts that already arrived rather than leaving them blank forever.
 */
function serializeNotification(row: NotificationRow, preview: boolean): NotificationItem {
  return {
    id: row.id,
    type: row.type,
    actor: row.actor
      ? { userId: row.actor.id, displayName: row.actor.displayName, avatarUrl: row.actor.avatarUrl }
      : null,
    conversationId: row.conversationId,
    messageId: row.messageId,
    callId: row.callId,
    title: preview ? row.title : NEUTRAL_TITLE[row.type],
    body: preview ? row.body : null,
    count: row.count,
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function pushData(event: NotifyEvent): Record<string, string> {
  const out: Record<string, string> = {};
  if (event.conversationId) out.conversationId = event.conversationId;
  if (event.messageId) out.messageId = event.messageId;
  if (event.callId) out.callId = event.callId;
  return out;
}

/** ─────────────────────────────── reading ─────────────────────────────── */

export async function listNotifications(
  db: PrismaClient,
  userId: string,
  query: ListNotificationsQuery,
): Promise<NotificationList> {
  const rows = await db.notification.findMany({
    where: {
      userId,
      // Dismissed rows have left the centre; read ones stay, like a shade you
      // looked at but never swept away.
      dismissedAt: null,
      ...(query.unreadOnly ? { readAt: null } : {}),
      ...(query.type && query.type.length > 0
        ? { type: { in: query.type } }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: query.limit + 1,
    include: { actor: { select: { id: true, displayName: true, avatarUrl: true } } },
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });

  const preview = await previewVisible(db, userId);
  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const oldest = rows[rows.length - 1];
  return {
    items: page.map((row) => serializeNotification(row as NotificationRow, preview)),
    nextCursor: hasMore && oldest ? oldest.id : null,
  };
}

export async function unreadNotificationCount(
  db: PrismaClient,
  userId: string,
): Promise<UnreadNotificationCount> {
  const count = await db.notification.count({ where: { userId, readAt: null, dismissedAt: null } });
  return { count };
}

/** ──────────────────────────── writing back ─────────────────────────── */

/**
 * Read state is per-account, not per-device, so it is echoed to the user's
 * other sockets: the badge on the laptop has to agree with the one that was just
 * tapped on the phone.
 */
export async function markNotificationsRead(
  deps: NotifyDeps,
  userId: string,
  req: MarkNotificationsReadRequest,
): Promise<UnreadNotificationCount> {
  await deps.db.notification.updateMany({
    where: scopeWhere(userId, req, { readAt: null }),
    data: { readAt: new Date() },
  });
  return announceChange(deps, "notification.read", userId, req);
}

export async function dismissNotifications(
  deps: NotifyDeps,
  userId: string,
  req: DismissNotificationsRequest,
): Promise<UnreadNotificationCount> {
  await deps.db.notification.updateMany({
    where: scopeWhere(userId, req, { dismissedAt: null }),
    data: { dismissedAt: new Date() },
  });
  return announceChange(deps, "notification.dismissed", userId, req);
}

/**
 * Opening a chat clears everything that chat caused, so one gesture settles both
 * the chat badge and the bell — and, unlike tapping a single notification, does
 * it on every device at once.
 */
export async function clearChatNotifications(
  deps: NotifyDeps,
  userId: string,
  conversationId: string,
): Promise<void> {
  await markNotificationsRead(deps, userId, { conversationId });
}

function scopeWhere(
  userId: string,
  req: { ids?: string[]; conversationId?: string; all?: boolean },
  onlyUnset: Prisma.NotificationWhereInput,
): Prisma.NotificationWhereInput {
  if (req.all) return { userId, ...onlyUnset };
  return {
    userId,
    dismissedAt: null,
    ...onlyUnset,
    ...(req.ids ? { id: { in: req.ids } } : {}),
    ...(req.conversationId ? { conversationId: req.conversationId } : {}),
  };
}

async function announceChange(
  deps: NotifyDeps,
  type: "notification.read" | "notification.dismissed",
  userId: string,
  req: { ids?: string[]; conversationId?: string; all?: boolean },
): Promise<UnreadNotificationCount> {
  const unread = await unreadNotificationCount(deps.db, userId);
  const event = {
    ids: req.ids ?? [],
    all: req.all === true,
    conversationId: req.conversationId ?? null,
    unreadCount: unread.count,
  };
  deps.hub.publishToUsers([userId], { type, ...event });
  return unread;
}

/** ────────────────────────── preference reads ────────────────────────── */

async function loadRecipientPrefs(db: PrismaClient, userId: string): Promise<RecipientPrefs | null> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      notifyMuted: true,
      notifyPreview: true,
      notifyQuietStart: true,
      notifyQuietEnd: true,
      notifyQuietTz: true,
    },
  });
  if (!user) return null;
  return { notifyMuted: user.notifyMuted, notifyPreview: user.notifyPreview, quietHours: quietHoursOf(user) };
}

async function loadChatPrefs(
  db: PrismaClient,
  userId: string,
  conversationId: string,
): Promise<ChatPrefs | null> {
  return db.conversationMember.findFirst({
    where: { conversationId, userId, leftAt: null },
    select: { notifyMode: true, mutedUntil: true },
  });
}

function quietHoursOf(user: {
  notifyQuietStart: string | null;
  notifyQuietEnd: string | null;
  notifyQuietTz: string | null;
}): QuietHours | null {
  if (!user.notifyQuietStart || !user.notifyQuietEnd || !user.notifyQuietTz) return null;
  return { start: user.notifyQuietStart, end: user.notifyQuietEnd, timeZone: user.notifyQuietTz };
}

/** Lists need the preview flag once, not per row. */
async function previewVisible(db: PrismaClient, userId: string): Promise<boolean> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { notifyPreview: true } });
  return user?.notifyPreview ?? true;
}
