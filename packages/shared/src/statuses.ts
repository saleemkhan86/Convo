import { z } from "zod";

/**
 * Status contracts (Phase 4B): ephemeral 24h posts — text, photo, video, or
 * link — with WhatsApp-style audience privacy. Media is uploaded through the
 * server (POST /media/upload) and referenced by `storageKey`.
 */

export const statusKindSchema = z.enum(["TEXT", "IMAGE", "VIDEO", "URL"]);
export type StatusKind = z.infer<typeof statusKindSchema>;

export const statusVisibilitySchema = z.enum([
  "EVERYONE",
  "CONTACTS",
  "CUSTOM",
  "CONTACTS_EXCEPT",
]);
export type StatusVisibility = z.infer<typeof statusVisibilitySchema>;

export const statusAuthorSchema = z.object({
  userId: z.string(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
});
export type StatusAuthor = z.infer<typeof statusAuthorSchema>;

export const statusItemSchema = z.object({
  id: z.string(),
  author: statusAuthorSchema,
  kind: statusKindSchema,
  /** Caption / text content / URL. */
  text: z.string().nullable(),
  /** Present for IMAGE/VIDEO; an expiring URL the client can load. */
  mediaUrl: z.string().nullable(),
  visibility: statusVisibilitySchema,
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  /** Author-only: how many accounts have watched this status. */
  viewCount: z.number().int().nonnegative().nullable().default(null),
  /** Author-only: true once at least one other account has watched it. */
  hasViews: z.boolean().nullable().default(null),
  /** Author-only: false hides this status from the "viewed by" list (5D). */
  shareReadReceipts: z.boolean().default(true),
  /** Viewer-only: true when this account has already watched it. */
  seenByMe: z.boolean().default(false),
  isMine: z.boolean(),
});
export type StatusItem = z.infer<typeof statusItemSchema>;

export const statusViewerSchema = z.object({
  userId: z.string(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  viewedAt: z.string().datetime(),
});
export type StatusViewer = z.infer<typeof statusViewerSchema>;

export const createStatusRequestSchema = z.object({
  kind: statusKindSchema,
  /** Required for TEXT/URL; optional caption for IMAGE/VIDEO. */
  text: z.string().trim().max(2048).optional(),
  /** Required for IMAGE/VIDEO; a key returned by POST /media/upload. */
  storageKey: z.string().max(256).optional(),
  mimeType: z.string().max(128).optional(),
  /** Lifetime in hours. Defaults to 24. */
  durationHours: z.number().int().min(1).max(168).default(24),
  visibility: statusVisibilitySchema.default("EVERYONE"),
  /** CUSTOM: who may view. CONTACTS_EXCEPT: who may NOT view. */
  userIds: z.array(z.string()).max(500).default([]),
  /** Post (5D): when false, viewers are never recorded for this status. */
  shareReadReceipts: z.boolean().default(true),
});
export type CreateStatusRequest = z.infer<typeof createStatusRequestSchema>;

export const createStatusRequestSchemaChecked = createStatusRequestSchema.superRefine(
  (value, ctx) => {
    if ((value.kind === "TEXT" || value.kind === "URL") && !value.text) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["text"],
        message: "Text and URL statuses need a text value",
      });
    }
    if (value.kind === "URL" && value.text) {
      try {
        const url = new URL(value.text);
        if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("bad protocol");
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["text"],
          message: "URL statuses need a valid http(s) link",
        });
      }
    }
    if ((value.kind === "IMAGE" || value.kind === "VIDEO") && !value.storageKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["storageKey"],
        message: "Photo and video statuses need an uploaded media key",
      });
    }
  },
);

export const statusListSchema = z.object({
  /** The caller's own statuses, newest first, including expired-soon ones. */
  mine: z.array(statusItemSchema),
  /** Others' active statuses matching each author's audience rules. */
  others: z.array(statusItemSchema),
});
export type StatusList = z.infer<typeof statusListSchema>;

/** Server → client: a new status was posted that this user may see. */
export const statusNewEventSchema = z.object({
  type: z.literal("status.new"),
  status: statusItemSchema,
});
export type StatusNewEvent = z.infer<typeof statusNewEventSchema>;

/** Server → client (author only): a viewer watched one of their statuses. */
export const statusViewedEventSchema = z.object({
  type: z.literal("status.viewed"),
  statusId: z.string(),
  viewer: statusViewerSchema,
});
export type StatusViewedEvent = z.infer<typeof statusViewedEventSchema>;

/**
 * "Mute this author's updates" (Phase 5D). Per viewer and deliberately never
 * broadcast — like 5A's chat controls, muting is private state.
 */
export const statusMuteSchema = z.object({
  userId: z.string(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  mutedAt: z.string().datetime(),
});
export type StatusMute = z.infer<typeof statusMuteSchema>;

export const statusMuteListSchema = z.object({
  items: z.array(statusMuteSchema),
});
export type StatusMuteList = z.infer<typeof statusMuteListSchema>;
