import { z } from "zod";
import { e164PhoneSchema } from "./identity.js";
import { mailNewEventSchema } from "./mail.js";
import {
  wsCallClientEventSchema,
  wsCallServerEventSchemas,
} from "./calls.js";
import {
  groupChangedEventSchema,
  groupJoinRequestNewEventSchema,
  groupJoinedEventSchema,
} from "./groups.js";
import { statusNewEventSchema, statusViewedEventSchema } from "./statuses.js";
import {
  notifyModeSchema,
  notifySoundSchema,
  wallpaperKeySchema,
  wsNotificationServerEventSchemas,
} from "./notifications.js";
import { chatFolderRefSchema } from "./folders.js";

/**
 * Chats contracts (spec §9, §22, §23).
 *
 * Sending always goes over HTTP so the client can retry safely: the
 * client-generated `clientMessageId` makes a retry return the original
 * message instead of creating a duplicate. The socket is downstream only
 * (plus typing/read signals), so a dropped connection can never duplicate
 * or lose a message.
 */

export const conversationTypeSchema = z.enum(["DIRECT", "GROUP"]);
export type ConversationType = z.infer<typeof conversationTypeSchema>;

export const messageTypeSchema = z.enum([
  "TEXT",
  "IMAGE",
  "VIDEO",
  "DOCUMENT",
  "VOICE",
  "STICKER",
  "SYSTEM",
  "LOCATION",
  "CONTACT",
]);
export type MessageType = z.infer<typeof messageTypeSchema>;

/** Viewer-agnostic tally of one emoji on a message. */
export const reactionTallySchema = z.object({
  emoji: z.string().min(1).max(16),
  count: z.number().int().nonnegative(),
});
export type ReactionTally = z.infer<typeof reactionTallySchema>;

/** Per-viewer reaction: tally plus whether the current user reacted. */
export const messageReactionSchema = reactionTallySchema.extend({
  reactedByMe: z.boolean().default(false),
});
export type MessageReactionSummary = z.infer<typeof messageReactionSchema>;

/** How far a message has progressed for its recipients (own-message tick). */
export const messageReceiptStatusSchema = z.enum(["SENT", "DELIVERED", "READ"]);
export type MessageReceiptStatus = z.infer<typeof messageReceiptStatusSchema>;

/**
 * Server-scraped Open Graph card for the first link in a message body
 * (Phase 5B extras). Unfurling happens after the send, so a fresh message
 * may briefly have none; `message.linkPreview` delivers it when it lands.
 * The image is the publisher's own URL, loaded by the client directly.
 */
export const linkPreviewSchema = z.object({
  url: z.string(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  image: z.string().nullable(),
  siteName: z.string().nullable(),
});
export type LinkPreview = z.infer<typeof linkPreviewSchema>;

/** Payload of a LOCATION message: a dropped pin, plus whatever the client labels it. */
export const messageLocationSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  name: z.string().trim().max(120).optional(),
  address: z.string().trim().max(300).optional(),
});
export type MessageLocation = z.infer<typeof messageLocationSchema>;

/**
 * Payload of a CONTACT message: the shared person's card, frozen at share
 * time. Only what the sharer already sees (their own contact entry or a
 * Convo profile) can ever be put into one.
 */
export const sharedContactSchema = z.object({
  userId: z.string().optional(),
  displayName: z.string().trim().min(1).max(80),
  phone: z.string().trim().max(20).optional(),
  email: z.string().trim().max(254).optional(),
  avatarUrl: z.string().url().max(2048).optional(),
});
export type SharedContact = z.infer<typeof sharedContactSchema>;

/** Chat attachment kinds (Phase 5B) — mirrors the server's AttachmentKind. */
export const attachmentKindSchema = z.enum(["IMAGE", "VIDEO", "DOCUMENT", "VOICE", "OTHER"]);
export type AttachmentKind = z.infer<typeof attachmentKindSchema>;

/**
 * An attachment as the client sees it. `mediaUrl` is a short-lived signed URL
 * minted per response: it is never stored, and it is null for view-once media
 * the viewer has not opened yet (see `POST /messages/:id/view-once`).
 */
export const attachmentSchema = z.object({
  id: z.string(),
  kind: attachmentKindSchema,
  mimeType: z.string(),
  fileName: z.string().nullable(),
  sizeBytes: z.number().int().nonnegative(),
  width: z.number().int().nonnegative().nullable(),
  height: z.number().int().nonnegative().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  mediaUrl: z.string().nullable(),
});
export type Attachment = z.infer<typeof attachmentSchema>;

/**
 * Snapshot of the quoted message, taken when the reply is sent so the quote
 * keeps rendering after the original is edited, deleted or cleared away.
 */
export const replyPreviewSchema = z.object({
  messageId: z.string().nullable(),
  senderId: z.string().nullable(),
  senderName: z.string().nullable(),
  type: messageTypeSchema,
  body: z.string().nullable(),
  kind: attachmentKindSchema.nullable(),
  fileName: z.string().nullable(),
  mediaUrl: z.string().nullable(),
});
export type ReplyPreview = z.infer<typeof replyPreviewSchema>;

/** Who a forwarded message originally came from (WhatsApp's "Forwarded" label). */
export const forwardedFromSchema = z.object({
  userId: z.string(),
  displayName: z.string().nullable(),
});
export type ForwardedFrom = z.infer<typeof forwardedFromSchema>;

/**
 * A message that answers someone's status update (Phase 5D). The quoted
 * content itself rides in `replyPreview`, exactly like a reply to a message,
 * so the chat needs only this marker to label the bubble "Status reply". The
 * id goes null with the status itself: the reply always survives.
 */
export const statusReplySchema = z.object({
  statusId: z.string(),
});
export type StatusReply = z.infer<typeof statusReplySchema>;

/**
 * A pin (5E) is one per message and shared by the whole chat, so it carries who
 * pinned it and when. Unpinned messages report null.
 */
export const messagePinSchema = z.object({
  userId: z.string(),
  displayName: z.string().nullable(),
  pinnedAt: z.string().datetime(),
});
export type MessagePin = z.infer<typeof messagePinSchema>;

export const conversationPeerSchema = z.object({
  userId: z.string(),
  displayName: z.string().nullable(),
  /** Null when the peer's avatarVisibility hides it from the viewer (5C). */
  avatarUrl: z.string().nullable(),
  /** Peer's about/bio; null when aboutVisibility hides it (5C). */
  bio: z.string().nullable().default(null),
  phone: z.string().nullable(),
  /** Present only when the peer's presenceVisibility allows the viewer. */
  lastSeenAt: z.string().datetime().nullable(),
});
export type ConversationPeer = z.infer<typeof conversationPeerSchema>;

export const messageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  senderId: z.string().nullable(),
  clientMessageId: z.string(),
  type: messageTypeSchema,
  body: z.string().nullable(),
  replyToId: z.string().nullable(),
  editedAt: z.string().datetime().nullable(),
  deletedAt: z.string().datetime().nullable(),
  reactions: z.array(messageReactionSchema).default([]),
  /** Populated for the caller's own messages; null for others'. */
  deliveryStatus: messageReceiptStatusSchema.nullable().default(null),
  /** Whether the caller starred this message (per-viewer bookmark). */
  starredByMe: z.boolean().default(false),
  /** Media attached to this message (Phase 5B). Empty for text. */
  attachments: z.array(attachmentSchema).default([]),
  /** View-once media: each recipient may open it exactly once. */
  viewOnce: z.boolean().default(false),
  /** The caller already burned their single view of this message. */
  viewOnceOpened: z.boolean().default(false),
  /** Set when this message was forwarded from another chat. */
  forwardedFrom: forwardedFromSchema.nullable().default(null),
  /** Quoted-message snapshot for replies; outlives the original. */
  replyPreview: replyPreviewSchema.nullable().default(null),
  /** Set when this message answers a status update (type stays TEXT). */
  statusReply: statusReplySchema.nullable().default(null),
  /** @mention targets resolved server-side from the group roster (5E). */
  mentions: z.array(z.string()).default([]),
  /** The caller is named in this message — drives the mention badge. */
  mentionedMe: z.boolean().default(false),
  /** Pinned for the whole chat (5E); null when it is not pinned. */
  pinned: messagePinSchema.nullable().default(null),
  /** Scrape card for the first link in the body; arrives async after the send. */
  linkPreview: linkPreviewSchema.nullable().default(null),
  /** Set for LOCATION messages (type is LOCATION). */
  location: messageLocationSchema.nullable().default(null),
  /** Set for CONTACT messages (type is CONTACT). */
  contactCard: sharedContactSchema.nullable().default(null),
  /** Disappearing messages (5C): when this message self-destructs; null = permanent. */
  expiresAt: z.string().datetime().nullable().default(null),
  createdAt: z.string().datetime(),
});
export type Message = z.infer<typeof messageSchema>;

export const conversationSummarySchema = z.object({
  id: z.string(),
  type: conversationTypeSchema,
  title: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  peer: conversationPeerSchema.nullable(),
  /** Populated for GROUP conversations. */
  group: z
    .object({
      memberCount: z.number().int().nonnegative(),
      myRole: z.enum(["MEMBER", "ADMIN"]).nullable(),
      announceOnly: z.boolean(),
      whoCanSend: z.enum(["ALL", "ADMINS"]),
    })
    .nullable()
    .default(null),
  lastMessage: messageSchema.nullable(),
  unreadCount: z.number().int().nonnegative(),
  /** Unread @mentions for the caller (5E). Only groups ever report more than 0. */
  unreadMentions: z.number().int().nonnegative().default(0),
  pinned: z.boolean(),
  archived: z.boolean(),
  mutedUntil: z.string().datetime().nullable(),
  /** Disappearing-messages timer for this chat, seconds (0 = off). */
  ephemeralSeconds: z.number().int().min(0).default(0),
  lastReadAt: z.string().datetime().nullable(),
  lastMessageAt: z.string().datetime().nullable(),
  // ── Phase 5G per-viewer notification & appearance state ──
  /** The viewer's own alert level for this chat; never another member's. */
  notifyMode: notifyModeSchema.default("ALL"),
  notifySound: notifySoundSchema.nullable().default(null),
  wallpaperKey: wallpaperKeySchema.nullable().default(null),
  /** Folders this chat sits in for the viewer (5G). */
  folders: z.array(chatFolderRefSchema).default([]),
});
export type ConversationSummary = z.infer<typeof conversationSummarySchema>;

export const conversationListSchema = z.object({
  conversations: z.array(conversationSummarySchema),
  nextCursor: z.string().nullable(),
});
export type ConversationList = z.infer<typeof conversationListSchema>;

export const messagePageSchema = z.object({
  /// Oldest-first page of messages.
  messages: z.array(messageSchema),
  /// Pass as `cursor` to fetch the next (older) page.
  nextCursor: z.string().nullable(),
});
export type MessagePage = z.infer<typeof messagePageSchema>;

export const startConversationRequestSchema = z.object({
  phone: e164PhoneSchema,
});
export type StartConversationRequest = z.infer<typeof startConversationRequestSchema>;

/**
 * Reference to a file the caller previously uploaded. Only the key travels:
 * kind, mime type and size are read back from the server's own `MediaObject`
 * row, so a client cannot mislabel a 100 MB file or attach somebody else's key.
 */
export const attachmentInputSchema = z.object({
  storageKey: z.string().regex(/^[a-f0-9-]{20,64}\.[a-z0-9]{2,8}$/i, "Unknown media key"),
  /** Display label for documents; path separators are stripped. */
  fileName: z
    .string()
    .trim()
    .max(255)
    .optional()
    .transform((v) => (v ? v.replace(/[\\/]/g, "").slice(-160) : v)),
  width: z.number().int().min(0).max(30000).optional(),
  height: z.number().int().min(0).max(30000).optional(),
  durationMs: z.number().int().min(0).max(24 * 60 * 60 * 1000).optional(),
});
export type AttachmentInput = z.infer<typeof attachmentInputSchema>;

/**
 * `POST /statuses/:id/reply` (Phase 5D): answer someone's status in a 1-1 chat
 * with its author, the way WhatsApp opens a reply thread from the viewer. The
 * chat is created on demand, so a viewer never needs the author's phone number.
 * `clientMessageId` keeps the usual idempotent-retry rule.
 */
export const replyToStatusRequestSchema = z.object({
  clientMessageId: z.string().uuid(),
  body: z.string().trim().min(1).max(4096),
});
export type ReplyToStatusRequest = z.infer<typeof replyToStatusRequestSchema>;

export const replyToStatusResultSchema = z.object({
  /** The 1-1 chat with the status author, created when it did not exist. */
  conversationId: z.string(),
  message: messageSchema,
});
export type ReplyToStatusResult = z.infer<typeof replyToStatusResultSchema>;

export const sendMessageRequestSchema = z
  .object({
    /** Client-generated idempotency key (uuid). Retries return the original. */
    clientMessageId: z.string().uuid(),
    body: z.string().trim().max(4096).optional(),
    replyToId: z.string().optional(),
    /** Media uploaded through `POST /media/upload`, referenced by its key. */
    attachments: z.array(attachmentInputSchema).min(1).max(10).optional(),
    /** Send as view-once media: each recipient gets exactly one open. */
    viewOnce: z.boolean().default(false),
    /** Share a pin instead of text/media (makes the message a LOCATION one). */
    location: messageLocationSchema.optional(),
    /** Share a contact card (makes the message a CONTACT one). */
    contactCard: sharedContactSchema.optional(),
    /** GIF/sticker picked from the catalog: first attachment renders edge-to-edge. */
    sticker: z.boolean().default(false),
  })
  .refine(
    (v) =>
      (v.body?.length ?? 0) > 0 ||
      (v.attachments?.length ?? 0) > 0 ||
      v.location !== undefined ||
      v.contactCard !== undefined,
    { message: "Message cannot be empty" },
  )
  .refine((v) => v.viewOnce === false || (v.attachments?.length ?? 0) > 0, {
    message: "View-once needs media to show",
  })
  .refine((v) => v.location === undefined || v.contactCard === undefined, {
    message: "A message shares either a location or a contact, not both",
  });
export type SendMessageRequest = z.infer<typeof sendMessageRequestSchema>;

/**
 * `POST /messages/forward` — one or more messages into one or more chats.
 * Media is copied server-side, so the forward gets its own storage key and the
 * original chat's attachment is untouched.
 */
export const forwardMessagesRequestSchema = z.object({
  messageIds: z.array(z.string()).min(1).max(20),
  conversationIds: z.array(z.string()).min(1).max(20),
});
export type ForwardMessagesRequest = z.infer<typeof forwardMessagesRequestSchema>;

export const forwardMessagesResultSchema = z.object({
  /** One created message per (message, conversation) pair. */
  created: z.array(messageSchema),
});
export type ForwardMessagesResult = z.infer<typeof forwardMessagesResultSchema>;

/**
 * `POST /messages/:id/view-once` — burn the single view. The signed URLs come
 * back here only, never in a timeline payload, so nothing is fetched unless the
 * recipient meant to open it.
 */
export const viewOnceOpenResultSchema = z.object({
  attachments: z.array(attachmentSchema),
});
export type ViewOnceOpenResult = z.infer<typeof viewOnceOpenResultSchema>;

/** `GET /conversations/:id/media` — the shared-media grid of a chat. */
export const sharedMediaKindSchema = z.enum(["ALL", "IMAGE", "VIDEO", "DOCUMENT", "VOICE"]);
export type SharedMediaKind = z.infer<typeof sharedMediaKindSchema>;

export const markReadRequestSchema = z.object({
  /** Read up to and including this message; defaults to the latest. */
  messageId: z.string().optional(),
});
export type MarkReadRequest = z.infer<typeof markReadRequestSchema>;

export const editMessageRequestSchema = z.object({
  body: z.string().trim().min(1, "Message cannot be empty").max(4096),
});
export type EditMessageRequest = z.infer<typeof editMessageRequestSchema>;

/** Who the delete applies to: only the caller, or everyone in the chat. */
export const deleteMessageScopeSchema = z.enum(["MINE", "EVERYONE"]);
export type DeleteMessageScope = z.infer<typeof deleteMessageScopeSchema>;

export const deleteMessageRequestSchema = z.object({
  scope: deleteMessageScopeSchema.default("EVERYONE"),
});
export type DeleteMessageRequest = z.infer<typeof deleteMessageRequestSchema>;

export const reactMessageRequestSchema = z.object({
  emoji: z.string().min(1).max(16),
});
export type ReactMessageRequest = z.infer<typeof reactMessageRequestSchema>;

export const cursorQuerySchema = z.object({
  cursor: z.string().max(128).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type CursorQuery = z.infer<typeof cursorQuerySchema>;

/** `GET /conversations/:id/media` — the shared-media grid, newest first. */
export const listSharedMediaQuerySchema = cursorQuerySchema.extend({
  kind: sharedMediaKindSchema.default("ALL"),
});
export type ListSharedMediaQuery = z.infer<typeof listSharedMediaQuerySchema>;

/**
 * `GET /conversations/:id/links` — the "Links" tab (Phase 5E). Built from the
 * `linkPreview` scrape cards already stored on messages, so no second fetch of
 * the pages happens here.
 */
export const chatLinkItemSchema = z.object({
  messageId: z.string(),
  conversationId: z.string(),
  senderId: z.string().nullable(),
  senderDisplayName: z.string().nullable(),
  url: z.string(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  image: z.string().nullable(),
  siteName: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type ChatLinkItem = z.infer<typeof chatLinkItemSchema>;

export const chatLinkListSchema = z.object({
  links: z.array(chatLinkItemSchema),
  nextCursor: z.string().nullable(),
});
export type ChatLinkList = z.infer<typeof chatLinkListSchema>;

/** `GET /conversations/:id/pins` — pinned messages of a chat, newest pin first. */
export const chatPinSchema = z.object({
  message: messageSchema,
  pin: messagePinSchema,
});
export type ChatPin = z.infer<typeof chatPinSchema>;

export const chatPinListSchema = z.object({
  pins: z.array(chatPinSchema),
  nextCursor: z.string().nullable(),
});
export type ChatPinList = z.infer<typeof chatPinListSchema>;

/**
 * GIF catalog (Phase 5B extras). Clients only ever talk to our own `/giphy/*`
 * proxy — the Giphy API key lives in `apps/api/.env` and never reaches a
 * client. Picking a GIF downloads it into our own media storage, so the chat
 * message references a normal owned `storageKey` like any other attachment.
 */
export const giphyItemSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  previewUrl: z.string(),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
});
export type GiphyItem = z.infer<typeof giphyItemSchema>;

export const giphySearchQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(25).default(12),
});
export type GiphySearchQuery = z.infer<typeof giphySearchQuerySchema>;

export const giphyListResultSchema = z.object({
  /** False when GIPHY_API_KEY is unset: the picker hides itself. */
  enabled: z.boolean(),
  items: z.array(giphyItemSchema),
});
export type GiphyListResult = z.infer<typeof giphyListResultSchema>;

export const giphyUploadRequestSchema = z.object({
  giphyId: z.string().min(1).max(40),
});
export type GiphyUploadRequest = z.infer<typeof giphyUploadRequestSchema>;

/**
 * Per-viewer chat controls (Phase 5A, spec §9; notification + appearance state
 * added in 5G). `muteHours` follows WhatsApp's presets: 8 (8 hours), 168
 * (1 week), 8760 (1 year); 0 unmutes. A null `notifySound`/`wallpaperKey`
 * clears the per-chat override so the account default applies again.
 */
export const updateConversationRequestSchema = z
  .object({
    pinned: z.boolean().optional(),
    archived: z.boolean().optional(),
    muteHours: z.number().int().min(0).max(8760).optional(),
    notifyMode: notifyModeSchema.optional(),
    notifySound: notifySoundSchema.nullable().optional(),
    wallpaperKey: wallpaperKeySchema.nullable().optional(),
  })
  .refine(
    (v) =>
      v.pinned !== undefined ||
      v.archived !== undefined ||
      v.muteHours !== undefined ||
      v.notifyMode !== undefined ||
      v.notifySound !== undefined ||
      v.wallpaperKey !== undefined,
    { message: "Nothing to update" },
  );
export type UpdateConversationRequest = z.infer<typeof updateConversationRequestSchema>;

/**
 * Disappearing messages (Phase 5C): `PATCH /conversations/:id/ephemeral`.
 * Only 1-1 chats support the timer; 0 turns it off. New messages then carry
 * `expiresAt` and are hard-deleted server-side once it passes.
 */
export const updateEphemeralRequestSchema = z.object({
  seconds: z
    .number()
    .int()
    .refine((v) => v === 0 || v === 86_400 || v === 7 * 86_400 || v === 90 * 86_400, {
      message: "Timer must be 24h, 7d, 90d or 0 (off)",
    }),
});
export type UpdateEphemeralRequest = z.infer<typeof updateEphemeralRequestSchema>;

/**
 * `GET /conversations/:id/export` (Phase 5C). Answers the chat transcript as a
 * JSON document. With `includeMedia=true` every attachment also carries a
 * short-lived signed `mediaUrl`, so the client can fetch the bytes and build
 * its own archive — the API never streams a ZIP.
 */
export const exportChatQuerySchema = z.object({
  includeMedia: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .default("false"),
});
export type ExportChatQuery = z.infer<typeof exportChatQuerySchema>;

export const chatExportAttachmentSchema = z.object({
  kind: attachmentKindSchema,
  mimeType: z.string(),
  fileName: z.string().nullable(),
  sizeBytes: z.number().int().nonnegative(),
  mediaUrl: z.string().nullable(),
});
export type ChatExportAttachment = z.infer<typeof chatExportAttachmentSchema>;

export const chatExportMessageSchema = z.object({
  id: z.string(),
  senderId: z.string().nullable(),
  senderName: z.string().nullable(),
  type: messageTypeSchema,
  body: z.string().nullable(),
  createdAt: z.string().datetime(),
  attachments: z.array(chatExportAttachmentSchema).default([]),
});
export type ChatExportMessage = z.infer<typeof chatExportMessageSchema>;

export const chatExportDocumentSchema = z.object({
  conversationId: z.string(),
  title: z.string().nullable(),
  type: conversationTypeSchema,
  exportedAt: z.string().datetime(),
  messageCount: z.number().int().nonnegative(),
  mediaCount: z.number().int().nonnegative(),
  messages: z.array(chatExportMessageSchema),
});
export type ChatExportDocument = z.infer<typeof chatExportDocumentSchema>;

/** Message controls: a per-viewer bookmark. */
export const starMessageRequestSchema = z.object({
  starred: z.boolean().default(true),
});
export type StarMessageRequest = z.infer<typeof starMessageRequestSchema>;

/**
 * `GET /conversations` — the chat list, or the archive when `archived=true`.
 * `folderId` narrows to one 5G folder; `unfiled=true` asks for the chats in no
 * folder at all (the "everything else" tab). `folderId` wins if both arrive.
 */
export const listConversationsQuerySchema = cursorQuerySchema.extend({
  archived: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  folderId: z.string().optional(),
  unfiled: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
});
export type ListConversationsQuery = z.infer<typeof listConversationsQuerySchema>;

/** In-chat history view: free-text search, starred-only, or both. */
export const listMessagesQuerySchema = cursorQuerySchema.extend({
  q: z.string().trim().min(1).max(100).optional(),
  starred: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
});
export type ListMessagesQuery = z.infer<typeof listMessagesQuerySchema>;

/** `GET /starred` — starred messages across all of the caller's chats. */
export const starredMessageSchema = z.object({
  message: messageSchema,
  conversationId: z.string(),
  conversationName: z.string().nullable(),
});
export type StarredMessage = z.infer<typeof starredMessageSchema>;

export const starredMessageListSchema = z.object({
  items: z.array(starredMessageSchema),
  nextCursor: z.string().nullable(),
});
export type StarredMessageList = z.infer<typeof starredMessageListSchema>;

/** Socket protocol: client → server. */
export const wsClientEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ping") }),
  z.object({
    type: z.literal("watch"),
    /** Subscribe to presence updates for these users (max 100). */
    userIds: z.array(z.string()).min(1).max(100),
  }),
  z.object({
    type: z.literal("typing"),
    conversationId: z.string(),
    isTyping: z.boolean(),
  }),
  z.object({
    type: z.literal("read"),
    conversationId: z.string(),
    messageId: z.string().optional(),
  }),
  ...wsCallClientEventSchema.options,
]);
export type WsClientEvent = z.infer<typeof wsClientEventSchema>;

/** Socket protocol: server → client. */
export const wsServerEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), userId: z.string() }),
  z.object({ type: z.literal("pong") }),
  z.object({ type: z.literal("message.new"), message: messageSchema }),
  z.object({
    type: z.literal("message.read"),
    conversationId: z.string(),
    userId: z.string(),
    readAt: z.string().datetime(),
  }),
  z.object({
    type: z.literal("typing"),
    conversationId: z.string(),
    userId: z.string(),
    isTyping: z.boolean(),
  }),
  z.object({
    type: z.literal("presence"),
    userId: z.string(),
    online: z.boolean(),
    /** Sent when a peer goes offline (if visible); drives "last seen …". */
    lastSeenAt: z.string().datetime().nullable().optional(),
  }),
  z.object({
    type: z.literal("message.edited"),
    conversationId: z.string(),
    messageId: z.string(),
    body: z.string().nullable(),
    editedAt: z.string().datetime(),
  }),
  z.object({
    type: z.literal("message.deleted"),
    conversationId: z.string(),
    messageId: z.string(),
    scope: deleteMessageScopeSchema,
    /** userIds affected for scope=MINE; omitted for scope=EVERYONE. */
    userId: z.string().optional(),
  }),
  z.object({
    type: z.literal("message.reacted"),
    conversationId: z.string(),
    messageId: z.string(),
    reactions: z.array(reactionTallySchema),
  }),
  z.object({
    type: z.literal("message.delivered"),
    conversationId: z.string(),
    /** Message ids now delivered to this user. */
    messageIds: z.array(z.string()),
    userId: z.string(),
    deliveredAt: z.string().datetime(),
  }),
  z.object({
    /** A recipient burned their single view of view-once media. */
    type: z.literal("message.viewOnceOpened"),
    conversationId: z.string(),
    messageId: z.string(),
    userId: z.string(),
    viewedAt: z.string().datetime(),
  }),
  z.object({
    /** A message was pinned or unpinned for the whole chat (5E). */
    type: z.literal("message.pin"),
    conversationId: z.string(),
    messageId: z.string(),
    /** null means the message is no longer pinned. */
    pin: messagePinSchema.nullable(),
  }),
  z.object({
    /** The async link scrape for a message body finished; show the card. */
    type: z.literal("message.linkPreview"),
    conversationId: z.string(),
    messageId: z.string(),
    preview: linkPreviewSchema,
  }),
  z.object({
    /** A disappearing message hit its timer; drop it from the timeline. */
    type: z.literal("message.expired"),
    conversationId: z.string(),
    messageId: z.string(),
  }),
  z.object({
    /** Someone changed the chat's disappearing timer (1-1 chats). */
    type: z.literal("conversation.ephemeralChanged"),
    conversationId: z.string(),
    seconds: z.number().int().min(0),
    /** Set when this reflects one member's per-viewer choice. */
    userId: z.string().optional(),
  }),
  groupChangedEventSchema,
  groupJoinRequestNewEventSchema,
  groupJoinedEventSchema,
  statusNewEventSchema,
  statusViewedEventSchema,
  mailNewEventSchema,
  ...wsCallServerEventSchemas,
  ...wsNotificationServerEventSchemas,
]);
export type WsServerEvent = z.infer<typeof wsServerEventSchema>;
