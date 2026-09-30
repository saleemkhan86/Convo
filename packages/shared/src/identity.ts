import { z } from "zod";
import { quietHoursSchema } from "./notifications.js";

/**
 * Core account/identity model.
 *
 * One Convo account holds at most one phone identity and at most one email
 * identity. Either may be absent; neither creates a separate account.
 */

export const e164PhoneSchema = z
  .string()
  .regex(/^\+[1-9]\d{6,14}$/, "Phone number must be in E.164 format (e.g. +919876543210)");

export const emailAddressSchema = z
  .string()
  .trim()
  .min(3)
  .max(320)
  .email("Invalid email address")
  .transform((v) => v.toLowerCase());

export type E164Phone = z.infer<typeof e164PhoneSchema>;
export type EmailAddress = z.infer<typeof emailAddressSchema>;

export const identityStateSchema = z.enum([
  "none",
  "phone_only",
  "email_only",
  "both",
]);
export type IdentityState = z.infer<typeof identityStateSchema>;

export const phoneIdentitySchema = z.object({
  phone: e164PhoneSchema,
  verifiedAt: z.string().datetime(),
});
export type PhoneIdentity = z.infer<typeof phoneIdentitySchema>;

export const emailIdentitySchema = z.object({
  email: z.string(),
  verifiedAt: z.string().datetime(),
});
export type EmailIdentity = z.infer<typeof emailIdentitySchema>;

export const capabilitiesSchema = z.object({
  chats: z.boolean(),
  mail: z.boolean(),
});
export type Capabilities = z.infer<typeof capabilitiesSchema>;

export const presenceVisibilitySchema = z.enum(["EVERYONE", "CONTACTS", "NONE"]);
export type PresenceVisibility = z.infer<typeof presenceVisibilitySchema>;

/**
 * Per-field privacy audience (Phase 5C). Mirrors the server enum.
 * CONTACTS / CONTACTS_EXCEPT are judged against the owner's saved contacts —
 * the same rule last-seen already uses; the *_EXCEPT variant additionally
 * honours `visibilityExcluded` (WhatsApp's "My contacts except…").
 */
export const profileVisibilitySchema = z.enum([
  "EVERYONE",
  "CONTACTS",
  "CONTACTS_EXCEPT",
  "NONE",
]);
export type ProfileVisibility = z.infer<typeof profileVisibilitySchema>;

/** Who may add this account to a group (Phase 5C). */
export const groupAddVisibilitySchema = z.enum(["EVERYONE", "CONTACTS", "NOBODY"]);
export type GroupAddVisibility = z.infer<typeof groupAddVisibilitySchema>;

/**
 * App-lock settings mirrored on the account so every device agrees (5C).
 * The client enforces the lock; `pinHash` is a salted SHA-256 of the local
 * PIN computed by the client — the raw PIN never leaves the device and the
 * server never sees it.
 */
export const appLockSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  biometric: z.boolean().default(false),
  timeoutSeconds: z.number().int().min(0).max(3600).default(0),
  pinHash: z.string().max(128).nullable().default(null),
  salt: z.string().max(128).nullable().default(null),
});
export type AppLockSettings = z.infer<typeof appLockSettingsSchema>;


/** Chat-media auto-download rule (Phase 5B extras); mirrors the server enum. */
export const mediaAutoDownloadSchema = z.enum(["ALWAYS", "WIFI_ONLY"]);
export type MediaAutoDownload = z.infer<typeof mediaAutoDownloadSchema>;

export const accountSchema = z.object({
  id: z.string(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  bio: z.string().nullable(),
  phone: phoneIdentitySchema.nullable(),
  email: emailIdentitySchema.nullable(),
  capabilities: capabilitiesSchema,
  presenceVisibility: presenceVisibilitySchema.default("EVERYONE"),
  mediaAutoDownload: mediaAutoDownloadSchema.default("ALWAYS"),
  // ── Phase 5C privacy ──
  avatarVisibility: profileVisibilitySchema.default("EVERYONE"),
  aboutVisibility: profileVisibilitySchema.default("EVERYONE"),
  onlineVisibility: profileVisibilitySchema.default("EVERYONE"),
  visibilityExcluded: z.array(z.string()).default([]),
  groupAddVisibility: groupAddVisibilitySchema.default("EVERYONE"),
  readReceiptsEnabled: z.boolean().default(true),
  defaultEphemeralSeconds: z.number().int().min(0).default(0),
  appLock: appLockSettingsSchema.nullable().default(null),
  // ── Phase 5G notifications & appearance ──
  /** Off means a notification says "New message" with no sender and no body. */
  notifyPreview: z.boolean().default(true),
  /** Quiet mode: nothing is pushed, the unread badge still counts. */
  notifyMuted: z.boolean().default(false),
  /** Tone key chosen by the client; null = the platform default. */
  notifySound: z.string().nullable().default(null),
  /** Scheduled quiet window; null = never set, so pushes run around the clock. */
  quietHours: quietHoursSchema.nullable().default(null),
  /** Account-wide chat wallpaper; a per-chat value on the member row wins. */
  wallpaperKey: z.string().nullable().default(null),
  // ── Phase 5C security ──
  twoFactorEnabled: z.boolean().default(false),
  /** Set while the deletion grace window runs; null when the account is live. */
  deletionRequestedAt: z.string().datetime().nullable().default(null),
  createdAt: z.string().datetime(),
});
export type Account = z.infer<typeof accountSchema>;

export function identityStateOf(account: {
  phone: unknown | null;
  email: unknown | null;
}): IdentityState {
  if (account.phone && account.email) return "both";
  if (account.phone) return "phone_only";
  if (account.email) return "email_only";
  return "none";
}

export function capabilitiesOf(state: IdentityState): Capabilities {
  return { chats: state === "phone_only" || state === "both", mail: state === "email_only" || state === "both" };
}
