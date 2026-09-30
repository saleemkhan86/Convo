import type { Prisma } from "@prisma/client";
import {
  appLockSettingsSchema,
  capabilitiesOf,
  identityStateOf,
  type Account,
  type AppLockSettings,
  type QuietHours,
} from "@convo/shared";

export const userWithIdentities = {
  include: { phoneIdentity: true, emailIdentity: true },
} as const;

export type UserWithIdentities = Prisma.UserGetPayload<typeof userWithIdentities>;

/** Stored `User.clientSettings` blob — only the app-lock mirror is typed today. */
type ClientSettings = { appLock?: AppLockSettings };

function clientSettingsOf(raw: Prisma.JsonValue | null): ClientSettings | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const parsed = appLockSettingsSchema.safeParse(obj.appLock);
  return parsed.success ? { appLock: parsed.data } : null;
}

/** The exclusion list is a JSON array of userIds; junk reads as empty. */
function excludedOf(raw: Prisma.JsonValue | null | undefined): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string");
}

/**
 * The quiet window is three columns (a Postgres row can't hold a partial
 * nested object cleanly) and a half-set window means "never set", so the reader
 * reassembles it or reports null.
 */
function quietHoursOf(user: UserWithIdentities): QuietHours | null {
  const { notifyQuietStart: start, notifyQuietEnd: end, notifyQuietTz: timeZone } = user;
  if (!start || !end || !timeZone) return null;
  return { start, end, timeZone };
}

export function toAccount(user: UserWithIdentities): Account {
  const phone = user.phoneIdentity
    ? { phone: user.phoneIdentity.phone, verifiedAt: user.phoneIdentity.verifiedAt.toISOString() }
    : null;
  const email = user.emailIdentity
    ? {
        email: user.emailIdentity.email,
        verifiedAt: user.emailIdentity.verifiedAt.toISOString(),
      }
    : null;
  const state = identityStateOf({ phone, email });
  return {
    id: user.id,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    bio: user.bio,
    phone,
    email,
    capabilities: capabilitiesOf(state),
    presenceVisibility: user.presenceVisibility,
    mediaAutoDownload: user.mediaAutoDownload,
    avatarVisibility: user.avatarVisibility,
    aboutVisibility: user.aboutVisibility,
    onlineVisibility: user.onlineVisibility,
    visibilityExcluded: excludedOf(user.visibilityExcluded),
    groupAddVisibility: user.groupAddVisibility,
    readReceiptsEnabled: user.readReceiptsEnabled,
    defaultEphemeralSeconds: user.defaultEphemeralSeconds,
    appLock: clientSettingsOf(user.clientSettings)?.appLock ?? null,
    notifyPreview: user.notifyPreview,
    notifyMuted: user.notifyMuted,
    notifySound: user.notifySound,
    quietHours: quietHoursOf(user),
    wallpaperKey: user.wallpaperKey,
    twoFactorEnabled: user.twoFactorHash !== null,
    deletionRequestedAt: user.deletionRequestedAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
  };
}
