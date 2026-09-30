import { z } from "zod";
import { conversationSummarySchema, messageSchema } from "./chats.js";
import { groupSummarySchema } from "./groups.js";
import { e164PhoneSchema, emailAddressSchema } from "./identity.js";

/**
 * Contacts, blocking and reporting contracts (Phase 5A, spec §9, §10, §28).
 *
 * A Contact is private to its owner — it is never shared with the server's
 * other users. Saving one only *attempts* to resolve a Convo account from the
 * verified phone/email; unmatched rows stay plain address-book entries.
 * Blocking is deliberately non-revealing: a blocked sender's messages still
 * return HTTP 200, they are just never delivered or fanned out.
 */

export const contactSourceSchema = z.enum(["MANUAL", "SYNCED", "RECENT"]);
export type ContactSource = z.infer<typeof contactSourceSchema>;

export const contactSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  source: contactSourceSchema,
  /** Set when the identity resolves to a Convo account (chats can be opened). */
  convoUserId: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type Contact = z.infer<typeof contactSchema>;

export const contactListSchema = z.object({ contacts: z.array(contactSchema) });
export type ContactList = z.infer<typeof contactListSchema>;

/** Create or update (keyed by owner + phone, or owner + email). */
export const upsertContactRequestSchema = z
  .object({
    id: z.string().optional(),
    displayName: z.string().trim().min(1, "Name is required").max(128),
    phone: e164PhoneSchema.optional(),
    email: emailAddressSchema.optional(),
    avatarUrl: z.string().trim().max(2048).optional(),
  })
  .refine((v) => v.phone !== undefined || v.email !== undefined, {
    message: "Provide a phone number or an email address",
  });
export type UpsertContactRequest = z.infer<typeof upsertContactRequestSchema>;

export const contactRefSchema = z.object({ id: z.string().min(1) });

/** Recent-recipient autocomplete (WhatsApp's "message new chat" suggestions). */
export const recentRecipientSchema = z.object({
  userId: z.string(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  phone: z.string().nullable(),
  conversationId: z.string(),
  lastMessageAt: z.string().datetime().nullable(),
});
export type RecentRecipient = z.infer<typeof recentRecipientSchema>;

export const recentRecipientListSchema = z.object({
  recipients: z.array(recentRecipientSchema),
});
export type RecentRecipientList = z.infer<typeof recentRecipientListSchema>;

/** Block either an account you already share a chat with, or a phone number. */
export const blockRequestSchema = z
  .object({
    userId: z.string().optional(),
    phone: e164PhoneSchema.optional(),
  })
  .refine((v) => (v.userId === undefined) !== (v.phone === undefined), {
    message: "Provide exactly one of userId or phone",
  });
export type BlockRequest = z.infer<typeof blockRequestSchema>;

export const blockedUserSchema = z.object({
  userId: z.string(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  phone: z.string().nullable(),
  blockedAt: z.string().datetime(),
});
export type BlockedUser = z.infer<typeof blockedUserSchema>;

export const blockedListSchema = z.object({ blocked: z.array(blockedUserSchema) });
export type BlockedList = z.infer<typeof blockedListSchema>;

/** Mirrors the ReportTargetType enum, minus EMAIL (mail reporting is later). */
export const reportTargetTypeSchema = z.enum(["USER", "MESSAGE", "CONVERSATION"]);
export type ReportTargetType = z.infer<typeof reportTargetTypeSchema>;

export const reportReasonSchema = z.enum([
  "SPAM",
  "ABUSE",
  "HARASSMENT",
  "FRAUD",
  "VIOLENT",
  "IMPERSONATION",
  "OTHER",
]);
export type ReportReason = z.infer<typeof reportReasonSchema>;

export const reportRequestSchema = z.object({
  targetType: reportTargetTypeSchema,
  targetId: z.string().min(1),
  reason: reportReasonSchema,
  details: z.string().trim().max(2000).optional(),
  /** WhatsApp offers "block" as part of the report flow. */
  blockAfterReport: z.boolean().default(false),
});
export type ReportRequest = z.infer<typeof reportRequestSchema>;

export const reportResultSchema = z.object({
  id: z.string(),
  /** True when the report flow also blocked the target. */
  blocked: z.boolean(),
});
export type ReportResult = z.infer<typeof reportResultSchema>;

/**
 * `GET /users/:id` — the contact-info card (Phase 5A).
 * Fields the owner chose to hide are null rather than withheld with an error,
 * and a shared conversation id is only returned when one actually exists.
 */
export const userCardSchema = z.object({
  userId: z.string(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  bio: z.string().nullable(),
  /** Only when the caller saved them as a contact or shares a chat. */
  phone: z.string().nullable(),
  lastSeenAt: z.string().datetime().nullable(),
  blockedByMe: z.boolean(),
  sharedConversationId: z.string().nullable(),
});
export type UserCard = z.infer<typeof userCardSchema>;

/** `GET /search` — one query across the caller's own data. */
export const globalSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(100),
  limit: z.coerce.number().int().min(1).max(30).default(10),
});
export type GlobalSearchQuery = z.infer<typeof globalSearchQuerySchema>;

export const searchMatchSchema = z.object({
  message: messageSchema,
  conversationId: z.string(),
  conversationName: z.string().nullable(),
});
export type SearchMatch = z.infer<typeof searchMatchSchema>;

export const globalSearchResultSchema = z.object({
  query: z.string(),
  contacts: z.array(contactSchema),
  conversations: z.array(conversationSummarySchema),
  messages: z.array(searchMatchSchema),
  groups: z.array(groupSummarySchema),
});
export type GlobalSearchResult = z.infer<typeof globalSearchResultSchema>;
