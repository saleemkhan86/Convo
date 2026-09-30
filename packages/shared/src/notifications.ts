import { z } from "zod";

/**
 * Notification centre and notification settings (Phase 5G).
 *
 * A `Notification` row is the record of something the user was told about. It
 * outlives the socket that carried the event and the push that woke the phone,
 * which is why the row — not the push — is the source of truth for the bell.
 *
 * The rules that decide *whether* to tell are stored server-side (account-wide
 * preview/quiet toggles plus a per-chat `notifyMode`), so a chat muted on the
 * phone stays muted on the laptop, and so a push never leaks content the
 * recipient has switched off: the server withholds the body instead of trusting
 * a client to hide it.
 */

export const notificationTypeSchema = z.enum([
  "CHAT_MESSAGE",
  /** An @-mention, which still rings through a mentions-only or muted group. */
  "MENTION",
  "MAIL_MESSAGE",
  "CALL_MISSED",
  "SYSTEM",
]);
export type NotificationType = z.infer<typeof notificationTypeSchema>;

/** Whose action this reports. Null for `SYSTEM`, which has no author. */
export const notificationActorSchema = z.object({
  userId: z.string(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
});
export type NotificationActor = z.infer<typeof notificationActorSchema>;

export const notificationItemSchema = z.object({
  id: z.string(),
  type: notificationTypeSchema,
  actor: notificationActorSchema.nullable(),
  /** Where a tap goes. All three are null for a `SYSTEM` row. */
  conversationId: z.string().nullable(),
  messageId: z.string().nullable(),
  callId: z.string().nullable(),
  title: z.string(),
  /**
   * Null either because this kind has nothing to preview or because previews
   * are off for this account. The client draws "New message" — it cannot tell
   * the two apart, and it does not need to: neither is a secret to reveal.
   */
  body: z.string().nullable(),
  /** When a collapsed notification stands for several events. */
  count: z.number().int().positive(),
  readAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type NotificationItem = z.infer<typeof notificationItemSchema>;

export const notificationListSchema = z.object({
  items: z.array(notificationItemSchema),
  nextCursor: z.string().nullable(),
});
export type NotificationList = z.infer<typeof notificationListSchema>;

export const unreadNotificationCountSchema = z.object({
  count: z.number().int().nonnegative(),
});
export type UnreadNotificationCount = z.infer<typeof unreadNotificationCountSchema>;

/** `GET /notifications` — the centre, newest first. */
export const listNotificationsQuerySchema = z.object({
  cursor: z.string().max(128).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  unreadOnly: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  /** One kind arrives as a bare query value, several as a repeated param. */
  type: z
    .union([z.array(notificationTypeSchema), notificationTypeSchema])
    .transform((v) => (Array.isArray(v) ? v : [v]))
    .optional(),
});
export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;

/**
 * `POST /notifications/read`. Exactly one scope: ids (the rows just opened),
 * one conversation (tapping its chat clears everything it caused), or `all`
 * (the centre's mark-read header). Combining them would make the badge
 * ambiguous, so the schema refuses.
 */
const notificationScopeSchema = {
  ids: z.array(z.string()).min(1).max(200).optional(),
  conversationId: z.string().optional(),
  all: z.boolean().optional(),
};

function hasExactlyOneScope(v: { ids?: string[]; conversationId?: string; all?: boolean }): boolean {
  return (
    [v.ids !== undefined, v.conversationId !== undefined, v.all === true].filter(Boolean).length === 1
  );
}

const ONE_SCOPE = { message: "Pick exactly one of ids, conversationId or all" };

export const markNotificationsReadRequestSchema = z
  .object(notificationScopeSchema)
  .refine(hasExactlyOneScope, ONE_SCOPE);
export type MarkNotificationsReadRequest = z.infer<typeof markNotificationsReadRequestSchema>;

/**
 * `POST /notifications/dismiss` — drop rows from the centre without reading
 * them. The messages themselves are untouched; this is only about the list.
 */
export const dismissNotificationsRequestSchema = z
  .object(notificationScopeSchema)
  .refine(hasExactlyOneScope, ONE_SCOPE);
export type DismissNotificationsRequest = z.infer<typeof dismissNotificationsRequestSchema>;

// ─────────────────────────────── preferences ───────────────────────────────

/**
 * Per-chat alert level; mirrors the server enum. This is the permanent switch —
 * `mutedUntil` (5A) is the timed one, and a chat is quiet while either says so.
 * `MENTIONS_ONLY` is the only mode that still rings for an @-mention, which is
 * how a muted group keeps reaching you for the messages meant for you.
 */
export const notifyModeSchema = z.enum(["ALL", "MENTIONS_ONLY", "NOTHING"]);
export type NotifyMode = z.infer<typeof notifyModeSchema>;

/** A wall-clock "HH:MM", 24-hour. */
const clockTimeSchema = z
  .string()
  .regex(/^([01]?\d|2[0-3]):[0-5]\d$/, "Time must be HH:MM");

export const quietHoursSchema = z.object({
  start: clockTimeSchema,
  end: clockTimeSchema,
  /** IANA zone both times are read in, e.g. `Asia/Karachi`. */
  timeZone: z.string().min(1).max(64),
});
export type QuietHours = z.infer<typeof quietHoursSchema>;

/** Minutes since local midnight in `timeZone`, falling back to UTC if unknown. */
export function localMinutesOf(timeZone: string, at: Date): number {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(at);
    const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
    const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
    return hour * 60 + minute;
  } catch {
    return at.getUTCHours() * 60 + at.getUTCMinutes();
  }
}

/**
 * True when `at` falls inside the window. A window whose end is before its
 * start wraps past midnight (22:00→07:00 is quiet overnight). `start === end`
 * is treated as **off**, not as all day: a zero-length window is what a client
 * sends when the user never picked one, and losing notifications is worse than
 * receiving one at an odd hour. Use `notifyMuted` for permanent silence.
 */
export function inQuietHours(quiet: QuietHours | null | undefined, at: Date = new Date()): boolean {
  if (!quiet) return false;
  const start = minutesOf(quiet.start);
  const end = minutesOf(quiet.end);
  if (start === end) return false;
  const now = localMinutesOf(quiet.timeZone, at);
  return start < end ? now >= start && now < end : now >= start || now < end;
}

function minutesOf(hhmm: string): number {
  const [hour, minute] = hhmm.split(":").map(Number) as [number, number];
  return hour * 60 + minute;
}

/**
 * Chat wallpaper (5G): either a built-in pattern the client draws itself
 * (`builtin:<id>`) or the storage key of an image the *user owns*. A pattern
 * cannot tell a real key from an invented one, so the API validates the media
 * case against `MediaObject` ownership instead of trusting this shape.
 *
 * Both the account default (`PATCH /me`) and the per-chat override
 * (`PATCH /conversations/:id`, on the member row) take this same shape; null
 * clears whichever of the two is being written.
 */
export const wallpaperKeySchema = z.string().trim().min(1).max(128);

/** Notification tone: a client-side key, null = fall back to the platform default. */
export const notifySoundSchema = z.string().trim().min(1).max(64);

// ─────────────────────────────── realtime ───────────────────────────────

/**
 * A row landed in the centre. The underlying event still arrives on its own
 * (`message.new`, `call.ended`) — this exists so the bell agrees on every
 * device, including one that never opened the chat.
 */
export const notificationNewEventSchema = z.object({
  type: z.literal("notification.new"),
  notification: notificationItemSchema,
});
export type NotificationNewEvent = z.infer<typeof notificationNewEventSchema>;

/**
 * Read state is per-account, not per-device, so it is echoed to the user's other
 * sockets: the badge on the laptop has to agree with the one just tapped on the
 * phone. Exactly one of `all` / `conversationId` / `ids` describes the scope.
 */
export const notificationReadEventSchema = z.object({
  type: z.literal("notification.read"),
  ids: z.array(z.string()),
  all: z.boolean(),
  conversationId: z.string().nullable(),
  unreadCount: z.number().int().nonnegative(),
});
export type NotificationReadEvent = z.infer<typeof notificationReadEventSchema>;

/** The same scope, applied to leaving the centre instead of being read. */
export const notificationDismissedEventSchema = z.object({
  type: z.literal("notification.dismissed"),
  ids: z.array(z.string()),
  all: z.boolean(),
  conversationId: z.string().nullable(),
  unreadCount: z.number().int().nonnegative(),
});
export type NotificationDismissedEvent = z.infer<typeof notificationDismissedEventSchema>;

export const wsNotificationServerEventSchemas = [
  notificationNewEventSchema,
  notificationReadEventSchema,
  notificationDismissedEventSchema,
];
export type WsNotificationServerEvent = z.infer<(typeof wsNotificationServerEventSchemas)[number]>;
