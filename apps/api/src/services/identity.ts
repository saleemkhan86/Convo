import type { Prisma, PrismaClient } from "@prisma/client";
import { ApiErrorCode, type Account } from "@convo/shared";
import type { Config } from "../config.js";
import type { EmailProvider } from "../email/index.js";
import { AppError, conflict, forbidden } from "../lib/errors.js";
import { toAccount, userWithIdentities, type UserWithIdentities } from "./account.js";
import { createChallenge, verifyChallengeCode, type ChallengeContext } from "./challenges.js";

export interface IdentityDeps {
  db: PrismaClient;
  config: Config;
  email: EmailProvider;
}

/**
 * Flow E — connect a second identity to the EXISTING account.
 *
 * Rules (spec §5):
 * - Linking only completes after the user proves ownership of the new identity
 *   via OTP verification.
 * - Never auto-merge accounts based on similarity claims.
 * - If the identity is already attached to another account, refuse with a
 *   safe, non-enumerating error.
 */

export async function requestConnectEmail(
  deps: IdentityDeps,
  user: UserWithIdentities,
  email: string,
  ctx: ChallengeContext,
) {
  if (user.emailIdentity) {
    if (user.emailIdentity.email === email) {
      throw conflict(
        ApiErrorCode.IdentityAlreadyLinkedToThisAccount,
        "This email is already connected to your account",
      );
    }
    throw conflict(
      ApiErrorCode.IdentityAlreadyLinkedToThisAccount,
      "Your account already has an email identity connected",
    );
  }
  const taken = await deps.db.emailIdentity.findUnique({ where: { email } });
  if (taken) {
    throw conflict(
      ApiErrorCode.IdentityLinkedToAnotherAccount,
      "This email could not be connected. If it belongs to you, sign in with it first.",
    );
  }

  return createChallenge(deps.db, deps.config, deps.email, {
    channel: "EMAIL",
    purpose: "CONNECT_IDENTITY",
    target: email,
    userId: user.id,
    ctx,
  });
}

export async function verifyConnectEmail(
  deps: IdentityDeps,
  user: UserWithIdentities,
  input: { challengeId: string; code: string },
  ctx: ChallengeContext,
): Promise<Account> {
  const challenge = await verifyChallengeCode(deps.db, deps.config, {
    challengeId: input.challengeId,
    code: input.code,
    expectedPurpose: "CONNECT_IDENTITY",
    expectedUserId: user.id,
  });
  if (challenge.channel !== "EMAIL") {
    throw new AppError(400, ApiErrorCode.ValidationError, "Challenge channel mismatch");
  }

  const updated = await deps.db.$transaction(async (tx) => {
    // Re-check at commit time: the address may have been claimed between
    // challenge creation and verification.
    const taken = await tx.emailIdentity.findUnique({ where: { email: challenge.target } });
    if (taken && taken.userId === user.id) {
      return tx.user.findUniqueOrThrow({ where: { id: user.id }, ...userWithIdentities });
    }
    if (taken) {
      throw conflict(
        ApiErrorCode.IdentityLinkedToAnotherAccount,
        "This email could not be connected. If it belongs to you, sign in with it first.",
      );
    }
    const existing = await tx.user.findUniqueOrThrow({ where: { id: user.id }, ...userWithIdentities });
    if (existing.emailIdentity) {
      throw conflict(
        ApiErrorCode.IdentityAlreadyLinkedToThisAccount,
        "Your account already has an email identity connected",
      );
    }
    return tx.user.update({
      where: { id: user.id },
      data: { emailIdentity: { create: { email: challenge.target } } },
      ...userWithIdentities,
    });
  });

  await audit(deps.db, user.id, "identity.connect.email", { email: challenge.target }, ctx.ip);
  return toAccount(updated);
}

export async function requestConnectPhone(
  deps: IdentityDeps,
  user: UserWithIdentities,
  phone: string,
  ctx: ChallengeContext,
) {
  if (user.phoneIdentity) {
    if (user.phoneIdentity.phone === phone) {
      throw conflict(
        ApiErrorCode.IdentityAlreadyLinkedToThisAccount,
        "This phone number is already connected to your account",
      );
    }
    throw conflict(
      ApiErrorCode.IdentityAlreadyLinkedToThisAccount,
      "Your account already has a phone identity connected",
    );
  }
  const taken = await deps.db.phoneIdentity.findUnique({ where: { phone } });
  if (taken) {
    throw conflict(
      ApiErrorCode.IdentityLinkedToAnotherAccount,
      "This phone number could not be connected. If it belongs to you, sign in with it first.",
    );
  }

  return createChallenge(deps.db, deps.config, deps.email, {
    channel: "PHONE",
    purpose: "CONNECT_IDENTITY",
    target: phone,
    userId: user.id,
    ctx,
  });
}

export async function verifyConnectPhone(
  deps: IdentityDeps,
  user: UserWithIdentities,
  input: { challengeId: string; code: string },
  ctx: ChallengeContext,
): Promise<Account> {
  const challenge = await verifyChallengeCode(deps.db, deps.config, {
    challengeId: input.challengeId,
    code: input.code,
    expectedPurpose: "CONNECT_IDENTITY",
    expectedUserId: user.id,
  });
  if (challenge.channel !== "PHONE") {
    throw new AppError(400, ApiErrorCode.ValidationError, "Challenge channel mismatch");
  }

  const updated = await deps.db.$transaction(async (tx) => {
    const taken = await tx.phoneIdentity.findUnique({ where: { phone: challenge.target } });
    if (taken && taken.userId === user.id) {
      return tx.user.findUniqueOrThrow({ where: { id: user.id }, ...userWithIdentities });
    }
    if (taken) {
      throw conflict(
        ApiErrorCode.IdentityLinkedToAnotherAccount,
        "This phone number could not be connected. If it belongs to you, sign in with it first.",
      );
    }
    const existing = await tx.user.findUniqueOrThrow({ where: { id: user.id }, ...userWithIdentities });
    if (existing.phoneIdentity) {
      throw conflict(
        ApiErrorCode.IdentityAlreadyLinkedToThisAccount,
        "Your account already has a phone identity connected",
      );
    }
    return tx.user.update({
      where: { id: user.id },
      data: { phoneIdentity: { create: { phone: challenge.target } } },
      ...userWithIdentities,
    });
  });

  await audit(deps.db, user.id, "identity.connect.phone", { phone: challenge.target }, ctx.ip);
  return toAccount(updated);
}

/**
 * Recovery guard (spec §34): only VERIFIED identities can authenticate or
 * recover an account. This function is the single place that decides whether
 * a presented identity grants access — possession of an unverified
 * identifier never does, because identities are only created upon successful
 * OTP verification.
 */
export async function assertAccountAccessible(db: PrismaClient, userId: string): Promise<void> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { status: true } });
  if (!user) throw forbidden("Account not found");
  if (user.status === "BANNED") throw forbidden("This account has been suspended");
  if (user.status === "DEACTIVATED") throw forbidden("This account is deactivated");
}

async function audit(
  db: PrismaClient,
  userId: string,
  action: string,
  metadata: Record<string, unknown>,
  ip?: string,
): Promise<void> {
  await db.auditLog.create({ data: { userId, action, metadata: metadata as Prisma.InputJsonValue, ip } });
}
