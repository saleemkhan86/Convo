import { z } from "zod";
import { accountSchema, appLockSettingsSchema, emailAddressSchema, e164PhoneSchema, groupAddVisibilitySchema, mediaAutoDownloadSchema, presenceVisibilitySchema, profileVisibilitySchema } from "./identity.js";
import { notifySoundSchema, quietHoursSchema, wallpaperKeySchema } from "./notifications.js";

export const otpLength = 6;
export const otpSchema = z.string().regex(new RegExp(`^\\d{${otpLength}}$`), "Enter the 6-digit code");

export const challengeSchema = z.object({
  challengeId: z.string(),
  expiresInSeconds: z.number().int(),
  /** Only populated when the server runs with DEV_EXPOSE_OTP=true (local development). */
  devOtp: z.string().optional(),
});
export type Challenge = z.infer<typeof challengeSchema>;

export const sessionTokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  accessExpiresInSeconds: z.number().int(),
});
export type SessionTokens = z.infer<typeof sessionTokensSchema>;

export const twoFactorPinSchema = z
  .string()
  .regex(/^\d{6}$/, "PIN must be 6 digits");

/**
 * Result of an OTP verify when the account has a PIN set: no session yet —
 * exchange the one-time token at `POST /auth/2fa/verify`.
 */
export const twoFactorRequiredSchema = z.object({
  twoFactorRequired: z.literal(true),
  twoFactorToken: z.string(),
  expiresInSeconds: z.number().int(),
});
export type TwoFactorRequired = z.infer<typeof twoFactorRequiredSchema>;

/**
 * An OTP verify either lands a session (two-step verification off) or stops
 * at the PIN wall (Phase 5C): exactly one branch is present.
 */
export const authResultSchema = z.union([
  z.object({
    session: sessionTokensSchema,
    account: accountSchema,
    isNewAccount: z.boolean(),
  }),
  twoFactorRequiredSchema.extend({
    account: accountSchema.omit({ phone: true, email: true }).partial().optional(),
  }),
]);
export type AuthResult = z.infer<typeof authResultSchema>;

/** The branch that carries a real session — what a client stores after sign-in. */
export type SessionAuthResult = Extract<AuthResult, { session: SessionTokens }>;

// --- Unauthenticated auth flows (A–D) ---

export const requestPhoneOtpRequestSchema = z.object({ phone: e164PhoneSchema });
export const verifyPhoneOtpRequestSchema = z.object({
  challengeId: z.string().min(1),
  code: otpSchema,
});

export const requestEmailOtpRequestSchema = z.object({ email: emailAddressSchema });
export const verifyEmailOtpRequestSchema = z.object({
  challengeId: z.string().min(1),
  code: otpSchema,
});

export const refreshRequestSchema = z.object({ refreshToken: z.string().min(1) });

// --- Authenticated identity linking (flow E) ---

export const connectIdentityRequestSchema = z.object({
  challengeId: z.string().min(1),
  code: otpSchema,
});

// --- Profile ---

export const updateProfileRequestSchema = z.object({
  displayName: z.string().trim().min(1).max(64).nullable().optional(),
  avatarUrl: z.string().url().max(2048).nullable().optional(),
  bio: z.string().trim().max(280).nullable().optional(),
  presenceVisibility: presenceVisibilitySchema.optional(),
  mediaAutoDownload: mediaAutoDownloadSchema.optional(),
  // ── Phase 5C privacy ──
  avatarVisibility: profileVisibilitySchema.optional(),
  aboutVisibility: profileVisibilitySchema.optional(),
  onlineVisibility: profileVisibilitySchema.optional(),
  visibilityExcluded: z.array(z.string()).max(500).optional(),
  groupAddVisibility: groupAddVisibilitySchema.optional(),
  readReceiptsEnabled: z.boolean().optional(),
  defaultEphemeralSeconds: z.number().int().min(0).max(90 * 86_400).optional(),
  /** App-lock mirror; clients hash the PIN locally before sending it. */
  appLock: appLockSettingsSchema.nullable().optional(),
  // ── Phase 5G notifications & appearance ──
  notifyPreview: z.boolean().optional(),
  notifyMuted: z.boolean().optional(),
  notifySound: notifySoundSchema.nullable().optional(),
  /** Replaces the whole window; null turns scheduled quiet hours off. */
  quietHours: quietHoursSchema.nullable().optional(),
  wallpaperKey: wallpaperKeySchema.nullable().optional(),
});
export type UpdateProfileRequest = z.infer<typeof updateProfileRequestSchema>;

// --- Two-step verification (Phase 5C) ---

export const setTwoFactorRequestSchema = z.object({ pin: twoFactorPinSchema });

export const verifyTwoFactorRequestSchema = z.object({
  twoFactorToken: z.string().min(1),
  pin: twoFactorPinSchema,
});

export const twoFactorStatusSchema = z.object({ enabled: z.boolean() });
export type TwoFactorStatus = z.infer<typeof twoFactorStatusSchema>;

// --- Active sessions + linked devices (Phase 5C) ---

export const revokeOtherSessionsResultSchema = z.object({ revoked: z.number().int() });
export type RevokeOtherSessionsResult = z.infer<typeof revokeOtherSessionsResultSchema>;

export const sessionInfoSchema = z.object({
  id: z.string(),
  deviceInfo: z.string().nullable(),
  ip: z.string().nullable(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  current: z.boolean(),
});
export type SessionInfo = z.infer<typeof sessionInfoSchema>;

/**
 * A browser Push API subscription (Phase 5G). `endpoint` is the URL our sender
 * POSTs to; `keys` are the browser's ECDH public key and the shared secret the
 * payload is encrypted with. Both belong to the *server*: no endpoint ever
 * returns them, and a device row only reports that push is registered — a
 * leaked subscription would let anyone push to that browser.
 */
export const webPushSubscriptionSchema = z.object({
  endpoint: z.string().url().max(700),
  keys: z.object({
    p256dh: z.string().min(40).max(120),
    auth: z.string().min(16).max(64),
  }),
});
export type WebPushSubscription = z.infer<typeof webPushSubscriptionSchema>;

export const registerDeviceRequestSchema = z
  .object({
    platform: z.enum(["ANDROID", "IOS", "WEB", "DESKTOP"]),
    /** Native (Expo/FCM/APNs) registration token. */
    pushToken: z.string().max(512).optional(),
    /** Web Push subscription; browsers have no token. */
    webPush: webPushSubscriptionSchema.optional(),
    appVersion: z.string().max(32).optional(),
  })
  .refine((v) => v.pushToken !== undefined || v.webPush !== undefined, {
    message: "Nothing to register: need a push token or a web subscription",
  });
export type RegisterDeviceRequest = z.infer<typeof registerDeviceRequestSchema>;

export const deviceInfoSchema = z.object({
  id: z.string(),
  platform: z.enum(["ANDROID", "IOS", "WEB", "DESKTOP"]),
  appVersion: z.string().nullable(),
  /** Which way this device can be woken. The details never leave the server. */
  pushTokenPresent: z.boolean(),
  webPushPresent: z.boolean(),
  lastSeenAt: z.string().datetime(),
  createdAt: z.string().datetime(),
});
export type DeviceInfo = z.infer<typeof deviceInfoSchema>;

// --- Account deletion (Phase 5C) ---

export const deleteAccountResultSchema = z.object({
  deletionScheduledAt: z.string().datetime(),
  graceDays: z.number().int(),
});
export type DeleteAccountResult = z.infer<typeof deleteAccountResultSchema>;

// --- Mail routing (section 16 of the spec) ---

export const mailRouteSchema = z.enum(["CONVO_INTERNAL", "EXTERNAL_SMTP"]);
export type MailRoute = z.infer<typeof mailRouteSchema>;
