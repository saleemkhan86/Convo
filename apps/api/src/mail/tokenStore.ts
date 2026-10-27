import { randomUUID } from "node:crypto";
import type { MailConnection, MailProvider, PrismaClient } from "@prisma/client";
import { MailTokenCipher, mailTokenAad, type EncryptedToken } from "./crypto.js";
import {
  MailboxProviderError,
  type MailboxProviderRegistry,
  type TokenSet,
} from "./providers/types.js";

const EXPIRY_SKEW_MS = 60_000;

export interface TokenStoreDeps {
  db: PrismaClient;
  cipher: MailTokenCipher;
  providers: MailboxProviderRegistry;
}

export class MailConnectionNotFoundError extends Error {
  constructor(connectionId: string) {
    super(`Mail connection ${connectionId} not found`);
    this.name = "MailConnectionNotFoundError";
  }
}

export class MailReauthRequiredError extends Error {
  readonly connectionId: string;
  readonly reason: string;

  constructor(connectionId: string, reason: string) {
    super("Mailbox needs to be reconnected");
    this.name = "MailReauthRequiredError";
    this.connectionId = connectionId;
    this.reason = reason;
  }
}

/**
 * Returns a live access token, refreshing and persisting a rotated one when
 * needed. Refresh concurrency is optimistic: every refresh bumps
 * `tokenVersion`, and a request that loses the race re-reads the winner's
 * token instead of overwriting it.
 */
export async function getValidAccessToken(
  deps: TokenStoreDeps,
  connectionId: string,
): Promise<{ accessToken: string; connection: MailConnection }> {
  const connection = await deps.db.mailConnection.findUnique({
    where: { id: connectionId },
  });
  if (!connection) throw new MailConnectionNotFoundError(connectionId);
  if (connection.status === "REVOKED" || connection.status === "NEEDS_REAUTH") {
    throw new MailReauthRequiredError(connectionId, connection.statusReason ?? connection.status);
  }

  const now = Date.now();
  if (
    connection.accessTokenCiphertext &&
    connection.accessTokenIv &&
    connection.accessTokenTag &&
    connection.accessTokenExpiresAt &&
    connection.accessTokenExpiresAt.getTime() > now + EXPIRY_SKEW_MS
  ) {
    return {
      accessToken: decryptField(deps.cipher, connection, "access_token"),
      connection,
    };
  }

  if (
    !connection.refreshTokenCiphertext ||
    !connection.refreshTokenIv ||
    !connection.refreshTokenTag
  ) {
    await markConnectionNeedsReauth(deps.db, connectionId, "missing_refresh_token");
    throw new MailReauthRequiredError(connectionId, "missing_refresh_token");
  }

  const provider = deps.providers[connection.provider];
  if (!provider) {
    throw new MailboxProviderError(`Mailbox provider ${connection.provider} is not configured`, {
      code: "provider_not_configured",
    });
  }

  const refreshToken = decryptField(deps.cipher, connection, "refresh_token");
  let tokens: TokenSet;
  try {
    tokens = await provider.refresh(refreshToken);
  } catch (error) {
    if (error instanceof MailboxProviderError && error.reauthRequired) {
      const reason = error.code ?? "refresh_rejected";
      await markConnectionNeedsReauth(deps.db, connectionId, reason);
      throw new MailReauthRequiredError(connectionId, reason);
    }
    throw error;
  }

  const access = deps.cipher.encrypt(
    tokens.accessToken,
    mailTokenAad(connection.id, connection.provider, "access_token"),
  );
  const rotated = tokens.refreshToken
    ? deps.cipher.encrypt(
        tokens.refreshToken,
        mailTokenAad(connection.id, connection.provider, "refresh_token"),
      )
    : null;

  const updated = await deps.db.mailConnection.updateMany({
    where: { id: connection.id, tokenVersion: connection.tokenVersion },
    data: {
      accessTokenCiphertext: Buffer.from(access.ciphertext),
      accessTokenIv: Buffer.from(access.iv),
      accessTokenTag: Buffer.from(access.tag),
      accessTokenExpiresAt: tokens.expiresAt,
      ...(rotated
        ? {
            refreshTokenCiphertext: Buffer.from(rotated.ciphertext),
            refreshTokenIv: Buffer.from(rotated.iv),
            refreshTokenTag: Buffer.from(rotated.tag),
          }
        : {}),
      tokenKeyVersion: access.keyVersion,
      tokenVersion: { increment: 1 },
      scopes: tokens.scopes,
      status: "CONNECTED",
      statusReason: null,
      lastRefreshedAt: new Date(),
    },
  });

  if (updated.count === 0) {
    // Another request refreshed first. Use its token rather than clobbering it.
    const winner = await deps.db.mailConnection.findUnique({ where: { id: connection.id } });
    if (
      winner?.accessTokenCiphertext &&
      winner.accessTokenIv &&
      winner.accessTokenTag &&
      winner.accessTokenExpiresAt &&
      winner.accessTokenExpiresAt.getTime() > Date.now()
    ) {
      return {
        accessToken: decryptField(deps.cipher, winner, "access_token"),
        connection: winner,
      };
    }
    throw new MailboxProviderError("Concurrent token refresh lost without a usable token", {
      retryable: true,
      code: "token_refresh_race",
    });
  }

  return { accessToken: tokens.accessToken, connection };
}

export interface StoreConnectionTokensArgs {
  emailIdentityId: string;
  provider: MailProvider;
  providerAccountId: string;
  emailAddress: string;
  displayName?: string;
  tokens: TokenSet;
}

/**
 * Persists a fresh authorization. Reconnecting the same identity updates the
 * existing row (its id is part of every AAD, so it must not change).
 */
export async function storeConnectionTokens(
  deps: TokenStoreDeps,
  args: StoreConnectionTokensArgs,
): Promise<MailConnection> {
  const existing = await deps.db.mailConnection.findUnique({
    where: { emailIdentityId: args.emailIdentityId },
  });
  const connectionId = existing?.id ?? randomUUID();
  const access = deps.cipher.encrypt(
    args.tokens.accessToken,
    mailTokenAad(connectionId, args.provider, "access_token"),
  );
  const refresh = args.tokens.refreshToken
    ? deps.cipher.encrypt(
        args.tokens.refreshToken,
        mailTokenAad(connectionId, args.provider, "refresh_token"),
      )
    : null;

  const accountChanged =
    existing !== null &&
    (existing.provider !== args.provider ||
      existing.providerAccountId !== args.providerAccountId);

  const shared = {
    provider: args.provider,
    providerAccountId: args.providerAccountId,
    emailAddress: args.emailAddress,
    displayName: args.displayName ?? null,
    scopes: args.tokens.scopes,
    accessTokenCiphertext: Buffer.from(access.ciphertext),
    accessTokenIv: Buffer.from(access.iv),
    accessTokenTag: Buffer.from(access.tag),
    accessTokenExpiresAt: args.tokens.expiresAt,
    tokenKeyVersion: access.keyVersion,
    tokenVersion: { increment: 1 },
    status: "CONNECTED" as const,
    statusReason: null,
    lastRefreshedAt: new Date(),
    lastSyncError: null,
    ...(accountChanged
      ? {
          syncCursor: null,
          syncCursorAt: null,
          initialSyncDone: false,
          lastSyncedAt: null,
        }
      : {}),
  };

  return deps.db.mailConnection.upsert({
    where: { emailIdentityId: args.emailIdentityId },
    create: {
      id: connectionId,
      emailIdentityId: args.emailIdentityId,
      ...shared,
      // `create` cannot use an atomic increment on a new row.
      tokenVersion: 0,
      ...(refresh
        ? {
            refreshTokenCiphertext: Buffer.from(refresh.ciphertext),
            refreshTokenIv: Buffer.from(refresh.iv),
            refreshTokenTag: Buffer.from(refresh.tag),
          }
        : {}),
    },
    update: {
      ...shared,
      ...(refresh
        ? {
            refreshTokenCiphertext: Buffer.from(refresh.ciphertext),
            refreshTokenIv: Buffer.from(refresh.iv),
            refreshTokenTag: Buffer.from(refresh.tag),
          }
        : {}),
    },
  });
}

export async function markConnectionNeedsReauth(
  db: PrismaClient,
  connectionId: string,
  reason: string,
): Promise<void> {
  await db.mailConnection.updateMany({
    where: { id: connectionId },
    data: {
      status: "NEEDS_REAUTH",
      statusReason: reason.slice(0, 255),
      // Tokens are useless once rejected; drop the ciphertext.
      accessTokenCiphertext: null,
      accessTokenIv: null,
      accessTokenTag: null,
      accessTokenExpiresAt: null,
      refreshTokenCiphertext: null,
      refreshTokenIv: null,
      refreshTokenTag: null,
    },
  });
}

export function decryptField(
  cipher: MailTokenCipher,
  connection: MailConnection,
  field: "access_token" | "refresh_token",
): string {
  const prefix = field === "access_token" ? "accessToken" : "refreshToken";
  const ciphertext =
    field === "access_token" ? connection.accessTokenCiphertext : connection.refreshTokenCiphertext;
  const iv = field === "access_token" ? connection.accessTokenIv : connection.refreshTokenIv;
  const tag = field === "access_token" ? connection.accessTokenTag : connection.refreshTokenTag;
  if (!ciphertext || !iv || !tag) {
    throw new MailReauthRequiredError(connection.id, `missing_${prefix}`);
  }
  const envelope: EncryptedToken = {
    ciphertext,
    iv,
    tag,
    keyVersion: connection.tokenKeyVersion,
  };
  return cipher.decrypt(
    envelope,
    mailTokenAad(connection.id, connection.provider, field),
  );
}
