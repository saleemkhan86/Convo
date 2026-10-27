import { createHash, randomBytes } from "node:crypto";
import type { MailOAuthPurpose, MailProvider, PrismaClient } from "@prisma/client";
import { hashToken } from "../lib/tokens.js";
import {
  MailTokenCipher,
  oauthCodeVerifierAad,
  type EncryptedToken,
} from "./crypto.js";

export type OAuthClient = "web" | "mobile";

export interface OAuthStateDeps {
  db: PrismaClient;
  cipher: MailTokenCipher;
}

export interface CreateOAuthStateArgs {
  purpose: MailOAuthPurpose;
  provider: MailProvider;
  userId?: string;
  client?: OAuthClient;
  redirectAfter?: string;
  ttlSeconds: number;
}

export interface CreatedOAuthState {
  state: string;
  nonce: string;
  codeChallenge: string;
  expiresAt: Date;
}

export interface ConsumedOAuthState {
  purpose: MailOAuthPurpose;
  provider: MailProvider;
  userId: string | null;
  nonce: string;
  codeVerifier: string;
  client: string;
  redirectAfter: string | null;
}

export type OAuthStateErrorCode = "invalid_state";

export class MailOAuthStateError extends Error {
  readonly code: OAuthStateErrorCode;

  constructor(message = "Invalid or expired OAuth state") {
    super(message);
    this.name = "MailOAuthStateError";
    this.code = "invalid_state";
  }
}

/** PKCE S256 pair; the verifier never leaves the server unencrypted. */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export async function createOAuthState(
  deps: OAuthStateDeps,
  args: CreateOAuthStateArgs,
): Promise<CreatedOAuthState> {
  const pkce = createPkcePair();
  const state = randomBytes(32).toString("base64url");
  const stateHash = hashToken(state);
  const nonce = randomBytes(16).toString("base64url");
  const expiresAt = new Date(Date.now() + args.ttlSeconds * 1000);
  const verifier = deps.cipher.encrypt(
    pkce.verifier,
    oauthCodeVerifierAad(stateHash),
  );

  const now = Date.now();
  await deps.db.mailOAuthState.deleteMany({
    where: {
      OR: [
        { expiresAt: { lt: new Date(now - 24 * 60 * 60 * 1000) } },
        { consumedAt: { lt: new Date(now - 24 * 60 * 60 * 1000) } },
      ],
    },
  });

  await deps.db.mailOAuthState.create({
    data: {
      stateHash,
      purpose: args.purpose,
      provider: args.provider,
      userId: args.userId ?? null,
      nonce,
      codeVerifierCiphertext: Buffer.from(verifier.ciphertext),
      codeVerifierIv: Buffer.from(verifier.iv),
      codeVerifierTag: Buffer.from(verifier.tag),
      keyVersion: verifier.keyVersion,
      client: args.client ?? "web",
      redirectAfter: args.redirectAfter ?? null,
      expiresAt,
    },
  });

  return {
    state,
    nonce,
    codeChallenge: pkce.challenge,
    expiresAt,
  };
}

export async function consumeOAuthState(
  deps: OAuthStateDeps,
  state: string,
): Promise<ConsumedOAuthState> {
  if (!state) throw new MailOAuthStateError();
  const stateHash = hashToken(state);
  const row = await deps.db.mailOAuthState.findUnique({ where: { stateHash } });
  if (!row || row.consumedAt || row.expiresAt.getTime() <= Date.now()) {
    throw new MailOAuthStateError();
  }

  // Single use: two browser tabs racing the same callback must not both win.
  const consumed = await deps.db.mailOAuthState.updateMany({
    where: { id: row.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  if (consumed.count !== 1) throw new MailOAuthStateError();

  const envelope: EncryptedToken = {
    ciphertext: row.codeVerifierCiphertext,
    iv: row.codeVerifierIv,
    tag: row.codeVerifierTag,
    keyVersion: row.keyVersion,
  };
  const codeVerifier = deps.cipher.decrypt(envelope, oauthCodeVerifierAad(stateHash));

  return {
    purpose: row.purpose,
    provider: row.provider,
    userId: row.userId,
    nonce: row.nonce,
    codeVerifier,
    client: row.client,
    redirectAfter: row.redirectAfter,
  };
}

export interface CreateAuthHandoffArgs {
  userId: string;
  ttlSeconds: number;
}

export interface CreatedAuthHandoff {
  code: string;
  expiresAt: Date;
}

/** One-time code a browser callback hands to the client instead of tokens. */
export async function createAuthHandoff(
  db: PrismaClient,
  args: CreateAuthHandoffArgs,
): Promise<CreatedAuthHandoff> {
  const code = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + args.ttlSeconds * 1000);
  await db.authHandoff.create({
    data: { codeHash: hashToken(code), userId: args.userId, expiresAt },
  });
  return { code, expiresAt };
}

export async function consumeAuthHandoff(
  db: PrismaClient,
  code: string,
): Promise<{ userId: string }> {
  if (!code) throw new MailOAuthStateError("Invalid or expired sign-in code");
  const codeHash = hashToken(code);
  const row = await db.authHandoff.findUnique({ where: { codeHash } });
  if (!row || row.consumedAt || row.expiresAt.getTime() <= Date.now()) {
    throw new MailOAuthStateError("Invalid or expired sign-in code");
  }
  const consumed = await db.authHandoff.updateMany({
    where: { id: row.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  if (consumed.count !== 1) {
    throw new MailOAuthStateError("Invalid or expired sign-in code");
  }
  return { userId: row.userId };
}
