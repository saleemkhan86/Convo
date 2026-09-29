import { z } from "zod";
import { e164PhoneSchema } from "./identity.js";
import { mailNewEventSchema } from "./mail.js";

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
]);
export type MessageType = z.infer<typeof messageTypeSchema>;

export const conversationPeerSchema = z.object({
  userId: z.string(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  phone: z.string().nullable(),
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
  createdAt: z.string().datetime(),
});
export type Message = z.infer<typeof messageSchema>;

export const conversationSummarySchema = z.object({
  id: z.string(),
  type: conversationTypeSchema,
  title: z.string().nullable(),
  peer: conversationPeerSchema.nullable(),
  lastMessage: messageSchema.nullable(),
  unreadCount: z.number().int().nonnegative(),
  pinned: z.boolean(),
  archived: z.boolean(),
  mutedUntil: z.string().datetime().nullable(),
  lastReadAt: z.string().datetime().nullable(),
  lastMessageAt: z.string().datetime().nullable(),
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

export const sendMessageRequestSchema = z.object({
  /** Client-generated idempotency key (uuid). Retries return the original. */
  clientMessageId: z.string().uuid(),
  body: z.string().trim().min(1, "Message cannot be empty").max(4096),
  replyToId: z.string().optional(),
});
export type SendMessageRequest = z.infer<typeof sendMessageRequestSchema>;

export const markReadRequestSchema = z.object({
  /** Read up to and including this message; defaults to the latest. */
  messageId: z.string().optional(),
});
export type MarkReadRequest = z.infer<typeof markReadRequestSchema>;

export const cursorQuerySchema = z.object({
  cursor: z.string().max(128).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type CursorQuery = z.infer<typeof cursorQuerySchema>;

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
  }),
  mailNewEventSchema,
]);
export type WsServerEvent = z.infer<typeof wsServerEventSchema>;
