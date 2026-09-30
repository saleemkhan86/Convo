import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { Prisma, type PrismaClient } from "@prisma/client";
import type {
  DeleteAccountResult,
  DeviceInfo,
  RegisterDeviceRequest,
  SessionInfo,
} from "@convo/shared";
import { badRequest, unauthorized } from "../lib/errors.js";
import { generateOpaqueToken, hashToken } from "../lib/tokens.js";
import type { Config } from "../config.js";

const scrypt = promisify(scryptCb) as (
  password: Buffer | string,
  salt: Buffer | string,
  keylen: number,
) => Promise<Buffer>;

/**
 * Account security (Phase 5C): two-step verification (login PIN), the active
 * sessions list with revoke, linked devices, and the deletion grace window.
 */

export interface SecurityDeps {
  db: PrismaClient;
  config: Config;
}

// ────────────────────────────── two-step verification ──────────────────────────────

const TWO_FACTOR_TTL_SECONDS = 10 * 60;
const TWO_FACTOR_MAX_ATTEMPTS = 5;
/** Marker target for 2FA challenges — never a valid phone/email, so the
 *  LOGIN/CONNECT lookups can't collide with these rows. */
const TWO_FACTOR_TARGET_PREFIX = "2fa:";

export function twoFactorEnabled(user: { twoFactorHash: string | null }): boolean {
  return user.twoFactorHash !== null;
}

/** scrypt with a per-account random salt; output stored as `salt:hash` hex. */
export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(pin, salt, 32);
  return `${salt.toString("hex")}:${derived.toString("hex")}`;
}

export async function verifyPinHash(pin: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(":");
  // Buffer.from swallows invalid hex silently, so "zz:yy" would decode to two
  // empty buffers and compare equal — any PIN would pass. Check the shape first.
  if (!isHex(saltHex) || !isHex(hashHex)) return false;
  const expected = Buffer.from(hashHex, "hex");
  const derived = await scrypt(pin, Buffer.from(saltHex, "hex"), expected.length);
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}

function isHex(value: string | undefined): value is string {
  return value !== undefined && value.length > 0 && /^[0-9a-f]+$/i.test(value);
}

/** Issue/replacement endpoint (`PUT /me/two-factor`) writes the PIN. */
export async function setTwoFactorPin(
  db: PrismaClient,
  userId: string,
  pin: string,
): Promise<void> {
  await db.user.update({
    where: { id: userId },
    data: { twoFactorHash: await hashPin(pin), twoFactorUpdatedAt: new Date() },
  });
}

export async function disableTwoFactor(db: PrismaClient, userId: string): Promise<void> {
  await db.user.update({
    where: { id: userId },
    data: { twoFactorHash: null, twoFactorUpdatedAt: new Date() },
  });
}

/**
 * After a successful OTP verify on a PIN-protected account: mint a short-lived
 * one-time token (hashed, attempt-capped) the client exchanges at
 * `POST /auth/2fa/verify`. The PIN itself is never stored in the row.
 */
export async function startTwoFactorChallenge(
  db: PrismaClient,
  userId: string,
): Promise<{ token: string; expiresInSeconds: number }> {
  const token = generateOpaqueToken();
  await db.verificationChallenge.create({
    data: {
      channel: "PHONE",
      purpose: "TWO_FACTOR",
      target: TWO_FACTOR_TARGET_PREFIX + userId,
      codeHash: hashToken(token),
      userId,
      expiresAt: new Date(Date.now() + TWO_FACTOR_TTL_SECONDS * 1000),
    },
  });
  return { token, expiresInSeconds: TWO_FACTOR_TTL_SECONDS };
}

/** Consume the 2FA token; throws 401 on any mismatch — never which part failed. */
export async function consumeTwoFactorToken(
  db: PrismaClient,
  token: string,
  pin: string,
): Promise<string> {
  const challenge = await db.verificationChallenge.findFirst({
    where: { codeHash: hashToken(token), purpose: "TWO_FACTOR" },
    orderBy: { createdAt: "desc" },
  });
  if (
    !challenge ||
    challenge.purpose !== "TWO_FACTOR" ||
    challenge.consumedAt ||
    challenge.expiresAt.getTime() < Date.now() ||
    !challenge.userId
  ) {
    throw unauthorized("Invalid or expired verification");
  }
  if (challenge.attempts >= TWO_FACTOR_MAX_ATTEMPTS) {
    await db.verificationChallenge.update({
      where: { id: challenge.id },
      data: { consumedAt: new Date() },
    });
    throw unauthorized("Too many attempts — sign in again");
  }

  const user = await db.user.findUnique({
    where: { id: challenge.userId },
    select: { twoFactorHash: true },
  });
  if (!user?.twoFactorHash) throw unauthorized("Invalid or expired verification");

  if (!(await verifyPinHash(pin, user.twoFactorHash))) {
    await db.verificationChallenge.update({
      where: { id: challenge.id },
      data: { attempts: { increment: 1 } },
    });
    throw unauthorized("Invalid or expired verification");
  }

  await db.verificationChallenge.update({
    where: { id: challenge.id },
    data: { consumedAt: new Date() },
  });
  return challenge.userId;
}

// ────────────────────────────── active sessions ──────────────────────────────

function serializeSession(
  s: {
    id: string;
    deviceInfo: string | null;
    ip: string | null;
    createdAt: Date;
    expiresAt: Date;
  },
  currentId: string | undefined,
): SessionInfo {
  return {
    id: s.id,
    deviceInfo: s.deviceInfo,
    ip: s.ip,
    createdAt: s.createdAt.toISOString(),
    expiresAt: s.expiresAt.toISOString(),
    current: s.id === currentId,
  };
}

/** Live refresh-token rows. Revoking one signs that device out at its next refresh. */
export async function listSessions(
  db: PrismaClient,
  userId: string,
  currentSessionId?: string,
): Promise<SessionInfo[]> {
  const rows = await db.refreshToken.findMany({
    where: {
      userId,
      revokedAt: null,
      expiresAt: { gt: new Date() },
      // The chain's live end: a row another token already replaced is history.
      replacedById: null,
    },
    orderBy: { createdAt: "desc" },
  });
  return rows.map((r) => serializeSession(r, currentSessionId));
}

export async function revokeSession(
  db: PrismaClient,
  userId: string,
  sessionId: string,
): Promise<void> {
  const revoked = await db.refreshToken.updateMany({
    where: { id: sessionId, userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (revoked.count === 0) throw badRequest("Session not found");
}

/** Sign out everywhere else — the caller's own session (if known) survives. */
export async function revokeOtherSessions(
  db: PrismaClient,
  userId: string,
  keepSessionId?: string,
): Promise<number> {
  const res = await db.refreshToken.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(keepSessionId ? { id: { not: keepSessionId } } : {}),
    },
    data: { revokedAt: new Date() },
  });
  return res.count;
}

// ────────────────────────────── linked devices ──────────────────────────────

export async function upsertDevice(
  db: PrismaClient,
  userId: string,
  req: RegisterDeviceRequest,
): Promise<DeviceInfo> {
  // Native token is the natural key for mobile; web endpoint for browsers.
  const existing = req.pushToken
    ? await db.device.findUnique({ where: { userId_pushToken: { userId, pushToken: req.pushToken } } })
    : req.webPush
      ? await db.device.findUnique({
          where: { userId_pushEndpoint: { userId, pushEndpoint: req.webPush.endpoint } },
        })
      : await db.device.findFirst({
          where: { userId, platform: req.platform, pushToken: null, pushEndpoint: null },
          orderBy: { lastSeenAt: "desc" },
        });
  const row = existing
    ? await db.device.update({
        where: { id: existing.id },
        data: {
          appVersion: req.appVersion ?? null,
          lastSeenAt: new Date(),
          ...(req.webPush
            ? { pushEndpoint: req.webPush.endpoint, pushKeys: req.webPush.keys }
            : {}),
        },
      })
    : await db.device.create({
        data: {
          userId,
          platform: req.platform,
          pushToken: req.pushToken ?? null,
          pushEndpoint: req.webPush?.endpoint ?? null,
          pushKeys: req.webPush ? (req.webPush.keys as Prisma.InputJsonValue) : Prisma.JsonNull,
          appVersion: req.appVersion ?? null,
        },
      });
  return serializeDevice(row);
}

export async function listDevices(db: PrismaClient, userId: string): Promise<DeviceInfo[]> {
  const rows = await db.device.findMany({
    where: { userId },
    orderBy: { lastSeenAt: "desc" },
  });
  return rows.map(serializeDevice);
}

/** Unlinking only removes the push registration; sessions stay separate. */
export async function deleteDevice(db: PrismaClient, userId: string, deviceId: string): Promise<void> {
  const deleted = await db.device.deleteMany({ where: { id: deviceId, userId } });
  if (deleted.count === 0) throw badRequest("Device not found");
}

function serializeDevice(d: {
  id: string;
  platform: DeviceInfo["platform"];
  appVersion: string | null;
  lastSeenAt: Date;
  createdAt: Date;
  pushToken: string | null;
  pushEndpoint: string | null;
}): DeviceInfo {
  return {
    id: d.id,
    platform: d.platform,
    appVersion: d.appVersion,
    pushTokenPresent: d.pushToken !== null,
    webPushPresent: d.pushEndpoint !== null,
    lastSeenAt: d.lastSeenAt.toISOString(),
    createdAt: d.createdAt.toISOString(),
  };
}

// ────────────────────────────── account deletion ──────────────────────────────

/**
 * Soft delete with a grace window (spec §34): login keeps working during the
 * window so the account can be rescued; `GET /me` reports the schedule so the
 * clients can show it. Past the deadline `sweepExpiredAccounts` anonymises and
 * removes the row.
 */
export async function requestAccountDeletion(
  deps: SecurityDeps,
  userId: string,
): Promise<DeleteAccountResult> {
  const scheduled = new Date(
    Date.now() + deps.config.ACCOUNT_DELETION_GRACE_DAYS * 86_400_000,
  );
  await deps.db.user.update({ where: { id: userId }, data: { deletionRequestedAt: new Date() } });
  return {
    deletionScheduledAt: scheduled.toISOString(),
    graceDays: deps.config.ACCOUNT_DELETION_GRACE_DAYS,
  };
}

export async function cancelAccountDeletion(
  db: PrismaClient,
  userId: string,
): Promise<void> {
  await db.user.update({ where: { id: userId }, data: { deletionRequestedAt: null } });
}

/** When the request was made; null when not scheduled. */
export function deletionRequestedAtOf(user: { deletionRequestedAt: Date | null }): Date | null {
  return user.deletionRequestedAt;
}

/**
 * Finish every deletion past its grace: anonymise first (messages survive via
 * the SetNull sender relation, exactly like a deleted WhatsApp contact's
 * bubbles), then remove the user row; every dependent row cascades.
 */
export async function sweepExpiredAccounts(deps: SecurityDeps): Promise<number> {
  const db = deps.db;
  const deadline = new Date(
    Date.now() - deps.config.ACCOUNT_DELETION_GRACE_DAYS * 86_400_000,
  );
  const due = await db.user.findMany({
    where: { deletionRequestedAt: { lt: deadline } },
    select: { id: true },
    take: 50,
  });
  for (const u of due) {
    await db.user.update({
      where: { id: u.id },
      data: {
        displayName: null,
        avatarUrl: null,
        bio: null,
        phoneIdentity: { delete: {} },
        emailIdentity: { delete: {} },
      },
    });
    await db.user.delete({ where: { id: u.id } });
  }
  return due.length;
}
