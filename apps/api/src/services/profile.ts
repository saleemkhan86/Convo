import type { Prisma, PrismaClient } from "@prisma/client";
import type { Account, UpdateProfileRequest } from "@convo/shared";
import { toAccount, userWithIdentities } from "./account.js";

export async function getAccount(db: PrismaClient, userId: string): Promise<Account> {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId }, ...userWithIdentities });
  return toAccount(user);
}

export async function updateProfile(
  db: PrismaClient,
  userId: string,
  patch: UpdateProfileRequest,
): Promise<Account> {
  const user = await db.user.update({
    where: { id: userId },
    data: {
      ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
      ...(patch.avatarUrl !== undefined ? { avatarUrl: patch.avatarUrl } : {}),
      ...(patch.bio !== undefined ? { bio: patch.bio } : {}),
      ...(patch.presenceVisibility !== undefined ? { presenceVisibility: patch.presenceVisibility } : {}),
      ...(patch.mediaAutoDownload !== undefined ? { mediaAutoDownload: patch.mediaAutoDownload } : {}),
      // Phase 5C privacy.
      ...(patch.avatarVisibility !== undefined ? { avatarVisibility: patch.avatarVisibility } : {}),
      ...(patch.aboutVisibility !== undefined ? { aboutVisibility: patch.aboutVisibility } : {}),
      ...(patch.onlineVisibility !== undefined ? { onlineVisibility: patch.onlineVisibility } : {}),
      ...(patch.visibilityExcluded !== undefined
        ? { visibilityExcluded: patch.visibilityExcluded as unknown as Prisma.InputJsonValue }
        : {}),
      ...(patch.groupAddVisibility !== undefined ? { groupAddVisibility: patch.groupAddVisibility } : {}),
      ...(patch.readReceiptsEnabled !== undefined ? { readReceiptsEnabled: patch.readReceiptsEnabled } : {}),
      ...(patch.defaultEphemeralSeconds !== undefined
        ? { defaultEphemeralSeconds: patch.defaultEphemeralSeconds }
        : {}),
      ...(patch.appLock !== undefined ? appLockData(patch.appLock) : {}),
      // Phase 5G notification & appearance prefs.
      ...(patch.notifyPreview !== undefined ? { notifyPreview: patch.notifyPreview } : {}),
      ...(patch.notifyMuted !== undefined ? { notifyMuted: patch.notifyMuted } : {}),
      ...(patch.notifySound !== undefined ? { notifySound: patch.notifySound } : {}),
      ...(patch.quietHours !== undefined ? quietHoursData(patch.quietHours) : {}),
      ...(patch.wallpaperKey !== undefined ? { wallpaperKey: patch.wallpaperKey } : {}),
    },
    ...userWithIdentities,
  });
  return toAccount(user);
}

/**
 * A quiet window is one nested setting spread over three columns, so writing it
 * always writes all three — otherwise `{ start: "22:00" }` over an old end time
 * would invent a window nobody asked for. `null` clears the whole window.
 */
function quietHoursData(
  quietHours: UpdateProfileRequest["quietHours"],
): Pick<Prisma.UserUpdateInput, "notifyQuietStart" | "notifyQuietEnd" | "notifyQuietTz"> {
  if (!quietHours) {
    return { notifyQuietStart: null, notifyQuietEnd: null, notifyQuietTz: null };
  }
  return {
    notifyQuietStart: quietHours.start,
    notifyQuietEnd: quietHours.end,
    notifyQuietTz: quietHours.timeZone,
  };
}

/**
 * App-lock lives inside the `clientSettings` JSON mirror, so updating it must
 * not clobber sibling keys other clients may add later (Prisma JSON path
 * mutation). `null` removes the key entirely.
 */
function appLockData(
  appLock: UpdateProfileRequest["appLock"],
): Pick<Prisma.UserUpdateInput, "clientSettings"> {
  if (appLock === null) return { clientSettings: { path: ["appLock"], delete: true } };
  return { clientSettings: { path: ["appLock"], data: appLock } };
}
