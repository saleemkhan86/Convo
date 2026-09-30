import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { Account, AuthResult, SessionTokens } from "@convo/shared";
import type { Config } from "../config.js";
import type { EmailProvider } from "../email/index.js";
import { AppError, unauthorized } from "../lib/errors.js";
import { generateOpaqueToken, hashToken } from "../lib/tokens.js";
import { toAccount, userWithIdentities, type UserWithIdentities } from "./account.js";
import { createChallenge, verifyChallengeCode, type ChallengeContext } from "./challenges.js";
import { consumeTwoFactorToken, startTwoFactorChallenge } from "./security.js";

export interface AuthDeps {
  db: PrismaClient;
  config: Config;
  email: EmailProvider;
  jwt: FastifyInstance;
}

export interface LoginContext extends ChallengeContext {
  deviceInfo?: string;
}

export async function requestPhoneOtp(
  deps: AuthDeps,
  phone: string,
  ctx: LoginContext,
) {
  return createChallenge(deps.db, deps.config, deps.email, {
    channel: "PHONE",
    purpose: "LOGIN",
    target: phone,
    ctx,
  });
}

export async function requestEmailOtp(
  deps: AuthDeps,
  email: string,
  ctx: LoginContext,
) {
  return createChallenge(deps.db, deps.config, deps.email, {
    channel: "EMAIL",
    purpose: "LOGIN",
    target: email,
    ctx,
  });
}

/**
 * Completes flows A–D: verifies the OTP, then either restores the existing
 * account (identity found) or creates a new one with this first identity.
 */
export async function verifyLoginOtp(
  deps: AuthDeps,
  input: { challengeId: string; code: string },
  ctx: LoginContext,
): Promise<AuthResult> {
  const challenge = await verifyChallengeCode(deps.db, deps.config, {
    challengeId: input.challengeId,
    code: input.code,
    expectedPurpose: "LOGIN",
  });

  const isNewAccount =
    challenge.channel === "PHONE"
      ? !(await deps.db.phoneIdentity.findUnique({ where: { phone: challenge.target } }))
      : !(await deps.db.emailIdentity.findUnique({ where: { email: challenge.target } }));

  const user = await findOrCreateAccount(deps.db, challenge.channel, challenge.target);

  if (user.status === "BANNED") {
    throw new AppError(403, "FORBIDDEN", "This account has been suspended");
  }

  // Two-step verification (Phase 5C): the OTP proved the identity, the PIN
  // proves the person. No session exists until both are in hand.
  if (user.twoFactorHash) {
    const started = await startTwoFactorChallenge(deps.db, user.id);
    await deps.db.auditLog.create({
      data: {
        userId: user.id,
        action: "auth.login_second_factor",
        metadata: { channel: challenge.channel, challengeId: challenge.id },
        ip: ctx.ip,
      },
    });
    return {
      twoFactorRequired: true,
      twoFactorToken: started.token,
      expiresInSeconds: started.expiresInSeconds,
    };
  }

  const session = await issueSession(deps, user.id, ctx);

  await deps.db.auditLog.create({
    data: {
      userId: user.id,
      action: isNewAccount ? "auth.signup" : "auth.login",
      metadata: { channel: challenge.channel, challengeId: challenge.id },
      ip: ctx.ip,
    },
  });

  return { session, account: toAccount(user), isNewAccount };
}

/**
 * Second leg of a two-step-verification login (`POST /auth/2fa/verify`): the
 * OTP already succeeded, so the one-time token + PIN now mint the session.
 */
export async function verifyTwoFactorLogin(
  deps: AuthDeps,
  input: { twoFactorToken: string; pin: string },
  ctx: LoginContext,
): Promise<AuthResult> {
  const userId = await consumeTwoFactorToken(deps.db, input.twoFactorToken, input.pin);
  const user = await deps.db.user.findUniqueOrThrow({
    where: { id: userId },
    ...userWithIdentities,
  });
  if (user.status === "BANNED") {
    throw new AppError(403, "FORBIDDEN", "This account has been suspended");
  }

  const session = await issueSession(deps, user.id, ctx);
  await deps.db.auditLog.create({
    data: {
      userId: user.id,
      action: "auth.login",
      metadata: { channel: "PHONE", secondFactor: true },
      ip: ctx.ip,
    },
  });
  return { session, account: toAccount(user), isNewAccount: false };
}

/** Restores the account owning this identity, or creates one (flows A/B vs C/D). */async function findOrCreateAccount(
  db: PrismaClient,
  channel: "PHONE" | "EMAIL",
  target: string,
): Promise<UserWithIdentities> {
  if (channel === "PHONE") {
    const existing = await db.phoneIdentity.findUnique({ where: { phone: target } });
    if (existing) {
      return db.user.findUniqueOrThrow({ where: { id: existing.userId }, ...userWithIdentities });
    }
    try {
      return await db.user.create({
        data: { phoneIdentity: { create: { phone: target } } },
        ...userWithIdentities,
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        const raced = await db.phoneIdentity.findUniqueOrThrow({ where: { phone: target } });
        return db.user.findUniqueOrThrow({ where: { id: raced.userId }, ...userWithIdentities });
      }
      throw err;
    }
  }
  const existing = await db.emailIdentity.findUnique({ where: { email: target } });
  if (existing) {
    return db.user.findUniqueOrThrow({ where: { id: existing.userId }, ...userWithIdentities });
  }
  try {
    return await db.user.create({
      data: { emailIdentity: { create: { email: target } } },
      ...userWithIdentities,
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      const raced = await db.emailIdentity.findUniqueOrThrow({ where: { email: target } });
      return db.user.findUniqueOrThrow({ where: { id: raced.userId }, ...userWithIdentities });
    }
    throw err;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "P2002"
  );
}

async function issueSession(
  deps: AuthDeps,
  userId: string,
  ctx: LoginContext,
): Promise<SessionTokens & { recordId: string }> {
  const refreshToken = generateOpaqueToken();
  const refreshExpiresAt = new Date(Date.now() + deps.config.REFRESH_TOKEN_TTL_DAYS * 86_400_000);

  const record = await deps.db.refreshToken.create({
    data: {
      userId,
      tokenHash: hashToken(refreshToken),
      deviceInfo: ctx.deviceInfo,
      ip: ctx.ip,
      expiresAt: refreshExpiresAt,
    },
  });

  const accessToken = deps.jwt.jwt.sign(
    { sub: userId, sid: record.id },
    { expiresIn: deps.config.ACCESS_TOKEN_TTL_SECONDS },
  );

  return {
    accessToken,
    refreshToken,
    accessExpiresInSeconds: deps.config.ACCESS_TOKEN_TTL_SECONDS,
    recordId: record.id,
  };
}

/** Rotates a refresh token: the old one is revoked and replaced (replay-safe). */
export async function refreshSession(
  deps: AuthDeps,
  refreshToken: string,
  ctx: LoginContext,
): Promise<SessionTokens> {
  const tokenHash = hashToken(refreshToken);
  const existing = await deps.db.refreshToken.findUnique({ where: { tokenHash } });
  if (!existing || existing.revokedAt || existing.expiresAt.getTime() < Date.now()) {
    throw unauthorized("Invalid or expired refresh token");
  }

  const session = await issueSession(deps, existing.userId, ctx);
  await deps.db.refreshToken.update({
    where: { id: existing.id },
    data: { revokedAt: new Date(), replacedById: session.recordId },
  });
  const { recordId: _recordId, ...tokens } = session;
  return tokens;
}

export async function logout(deps: AuthDeps, refreshToken: string): Promise<void> {
  await deps.db.refreshToken.updateMany({
    where: { tokenHash: hashToken(refreshToken), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export function serializeAccount(user: UserWithIdentities): Account {
  return toAccount(user);
}
