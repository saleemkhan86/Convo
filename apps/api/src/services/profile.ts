import type { PrismaClient } from "@prisma/client";
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
    },
    ...userWithIdentities,
  });
  return toAccount(user);
}
