import type { ChallengeChannel, ChallengePurpose, PrismaClient } from "@prisma/client";
import { ApiErrorCode } from "@convo/shared";
import type { Config } from "../config.js";
import type { EmailProvider } from "../email/index.js";
import { AppError } from "../lib/errors.js";
import { generateOtp, hashCode, verifyCodeHash } from "../lib/otp.js";

export interface ChallengeContext {
  ip?: string;
}

export interface CreatedChallenge {
  challengeId: string;
  expiresInSeconds: number;
  devOtp?: string;
}

/**
 * Creates an OTP challenge for a target (phone E.164 or lowercase email).
 * Enforces a resend cooldown, expires previous open challenges for the same
 * target/purpose, stores only the hash, and dispatches the code.
 */
export async function createChallenge(
  db: PrismaClient,
  config: Config,
  email: EmailProvider,
  opts: {
    channel: ChallengeChannel;
    purpose: ChallengePurpose;
    target: string;
    userId?: string;
    ctx?: ChallengeContext;
  },
): Promise<CreatedChallenge> {
  const cooldownCutoff = new Date(Date.now() - config.OTP_RESEND_COOLDOWN_SECONDS * 1000);
  const recent = await db.verificationChallenge.findFirst({
    where: {
      target: opts.target,
      purpose: opts.purpose,
      createdAt: { gte: cooldownCutoff },
      consumedAt: null,
    },
    orderBy: { createdAt: "desc" },
  });
  if (recent) {
    throw new AppError(
      429,
      ApiErrorCode.RateLimited,
      `Please wait ${config.OTP_RESEND_COOLDOWN_SECONDS}s before requesting another code`,
    );
  }

  const code = generateOtp();
  const expiresAt = new Date(Date.now() + config.OTP_TTL_SECONDS * 1000);

  const challenge = await db.$transaction(async (tx) => {
    await tx.verificationChallenge.updateMany({
      where: { target: opts.target, purpose: opts.purpose, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    return tx.verificationChallenge.create({
      data: {
        channel: opts.channel,
        purpose: opts.purpose,
        target: opts.target,
        codeHash: hashCode(code),
        expiresAt,
        userId: opts.userId,
      },
    });
  });

  await dispatchCode(config, email, challenge.id, opts.channel, opts.target, code, opts.ctx);

  return {
    challengeId: challenge.id,
    expiresInSeconds: config.OTP_TTL_SECONDS,
    ...(config.DEV_EXPOSE_OTP ? { devOtp: code } : {}),
  };
}

async function dispatchCode(
  config: Config,
  email: EmailProvider,
  challengeId: string,
  channel: ChallengeChannel,
  target: string,
  code: string,
  ctx?: ChallengeContext,
): Promise<void> {
  if (channel === "EMAIL") {
    await email.sendEmail({
      to: [target],
      subject: `${code} is your Convo verification code`,
      text: `Your Convo verification code is ${code}. It expires in ${Math.round(config.OTP_TTL_SECONDS / 60)} minutes. If you didn't request this, you can safely ignore this email.`,
      html: verificationEmailHtml(code, config.OTP_TTL_SECONDS),
    });
    return;
  }
  // SMS delivery requires an SMS provider (Twilio/MSG91/etc.) — see docs/TODO.md.
  // In development the code is logged and (optionally) exposed via DEV_EXPOSE_OTP.
  console.log(`[auth] SMS OTP for ${target} (challenge ${challengeId}, ip ${ctx?.ip ?? "?"}): ${code}`);
}

function verificationEmailHtml(code: string, ttlSeconds: number): string {
  const minutes = Math.round(ttlSeconds / 60);
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;background:#f6f7f9;padding:24px">
  <div style="max-width:420px;margin:0 auto;background:#fff;border-radius:16px;padding:32px">
    <p style="font-weight:700;font-size:18px;color:#111">Convo</p>
    <p style="color:#444">Your verification code is:</p>
    <p style="font-size:32px;letter-spacing:8px;font-weight:700;color:#111">${code}</p>
    <p style="color:#888;font-size:13px">Expires in ${minutes} minutes. If you didn't request this, ignore this email.</p>
  </div></body></html>`;
}

export interface VerifiedChallenge {
  id: string;
  channel: ChallengeChannel;
  purpose: ChallengePurpose;
  target: string;
  userId: string | null;
}

/**
 * Validates an OTP attempt: expiry, attempt caps, constant-time hash compare.
 * Consumes the challenge on success.
 */
export async function verifyChallengeCode(
  db: PrismaClient,
  config: Config,
  opts: { challengeId: string; code: string; expectedPurpose: ChallengePurpose; expectedUserId?: string },
): Promise<VerifiedChallenge> {
  const challenge = await db.verificationChallenge.findUnique({ where: { id: opts.challengeId } });
  if (!challenge || challenge.purpose !== opts.expectedPurpose || challenge.consumedAt) {
    throw new AppError(400, ApiErrorCode.ChallengeNotFound, "Invalid or already used challenge");
  }
  if (opts.expectedUserId !== undefined && challenge.userId !== opts.expectedUserId) {
    throw new AppError(400, ApiErrorCode.ChallengeNotFound, "Invalid or already used challenge");
  }
  if (challenge.expiresAt.getTime() < Date.now()) {
    throw new AppError(400, ApiErrorCode.OtpExpired, "This code has expired. Request a new one.");
  }
  if (challenge.attempts >= config.OTP_MAX_ATTEMPTS) {
    await db.verificationChallenge.update({
      where: { id: challenge.id },
      data: { consumedAt: new Date() },
    });
    throw new AppError(
      429,
      ApiErrorCode.OtpAttemptsExceeded,
      "Too many incorrect attempts. Request a new code.",
    );
  }

  await db.verificationChallenge.update({
    where: { id: challenge.id },
    data: { attempts: { increment: 1 } },
  });

  if (!verifyCodeHash(opts.code, challenge.codeHash)) {
    throw new AppError(400, ApiErrorCode.OtpInvalid, "Incorrect code");
  }

  await db.verificationChallenge.update({
    where: { id: challenge.id },
    data: { consumedAt: new Date() },
  });

  return {
    id: challenge.id,
    channel: challenge.channel,
    purpose: challenge.purpose,
    target: challenge.target,
    userId: challenge.userId,
  };
}
