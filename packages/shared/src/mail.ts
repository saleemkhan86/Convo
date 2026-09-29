import { z } from "zod";
import { emailAddressSchema } from "./identity.js";

/**
 * Mail contracts (spec §10, §11, §15, §17, §18).
 *
 * Mail is chat-style but keeps real email semantics: each account owns its own
 * copy of a thread and its messages (per-owner EmailThread/EmailMessage), tied
 * together across mailboxes by a shared `threadKey` and RFC 5322 threading
 * headers (`internetMessageId`, `inReplyTo`, `references`).
 *
 * Phase 3 delivers Convo-internal mail (recipient has a Convo email identity):
 * the message is mirrored into the recipient's mailbox and pushed over the
 * realtime socket. External SMTP delivery is Phase 4; the composer never
 * reveals which route an address took (anti-enumeration).
 *
 * Sends go over HTTP and are idempotent via a client-generated `clientSendId`,
 * exactly like chat messages.
 */

export const mailDirectionSchema = z.enum(["INBOUND", "OUTBOUND"]);
export type MailDirection = z.infer<typeof mailDirectionSchema>;

export const mailStatusSchema = z.enum([
  "QUEUED",
  "SENDING",
  "SENT",
  "DELIVERED",
  "BOUNCED",
  "FAILED",
]);
export type MailStatus = z.infer<typeof mailStatusSchema>;

export const mailParticipantSchema = z.object({
  address: z.string(),
  displayName: z.string().nullable(),
  /** Resolved Convo account id when the participant has a Convo email identity. */
  convoUserId: z.string().nullable(),
  isExternal: z.boolean(),
});
export type MailParticipant = z.infer<typeof mailParticipantSchema>;

export const mailMessageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  direction: mailDirectionSchema,
  status: mailStatusSchema,
  fromAddress: z.string(),
  toAddresses: z.array(z.string()),
  subject: z.string().nullable(),
  bodyText: z.string().nullable(),
  internetMessageId: z.string().nullable(),
  inReplyTo: z.string().nullable(),
  references: z.array(z.string()),
  /** Set when routed Convo-internal; mirrors the sender's outbound message id. */
  convoMessageId: z.string().nullable(),
  createdAt: z.string().datetime(),
  sentAt: z.string().datetime().nullable(),
  receivedAt: z.string().datetime().nullable(),
});
export type MailMessage = z.infer<typeof mailMessageSchema>;

export const mailThreadSummarySchema = z.object({
  id: z.string(),
  subject: z.string().nullable(),
  participants: z.array(mailParticipantSchema),
  lastMessage: mailMessageSchema.nullable(),
  unreadCount: z.number().int().nonnegative(),
  lastActivityAt: z.string().datetime(),
  lastReadAt: z.string().datetime().nullable(),
});
export type MailThreadSummary = z.infer<typeof mailThreadSummarySchema>;

export const mailThreadListSchema = z.object({
  threads: z.array(mailThreadSummarySchema),
  nextCursor: z.string().nullable(),
});
export type MailThreadList = z.infer<typeof mailThreadListSchema>;

export const mailMessagePageSchema = z.object({
  /// Oldest-first page of messages.
  messages: z.array(mailMessageSchema),
  /// Pass as `cursor` to fetch the next (older) page.
  nextCursor: z.string().nullable(),
});
export type MailMessagePage = z.infer<typeof mailMessagePageSchema>;

export const composeMailRequestSchema = z.object({
  /** Client-generated idempotency key (uuid). Retries return the original. */
  clientSendId: z.string().uuid(),
  to: z.array(emailAddressSchema).min(1).max(25),
  subject: z.string().trim().max(998).optional(),
  body: z.string().trim().min(1, "Message cannot be empty").max(65536),
});
export type ComposeMailRequest = z.infer<typeof composeMailRequestSchema>;

export const replyMailRequestSchema = z.object({
  clientSendId: z.string().uuid(),
  body: z.string().trim().min(1, "Message cannot be empty").max(65536),
});
export type ReplyMailRequest = z.infer<typeof replyMailRequestSchema>;

/** Result of a successful compose/reply: the sender's thread + created message. */
export const sendMailResultSchema = z.object({
  thread: mailThreadSummarySchema,
  message: mailMessageSchema,
});
export type SendMailResult = z.infer<typeof sendMailResultSchema>;

/** Realtime: a new mail message landed in the current user's mailbox. */
export const mailNewEventSchema = z.object({
  type: z.literal("mail.new"),
  thread: mailThreadSummarySchema,
  message: mailMessageSchema,
});
export type MailNewEvent = z.infer<typeof mailNewEventSchema>;
