import { describe, expect, it } from "vitest";
import type { MailConnection, PrismaClient } from "@prisma/client";
import {
  MailTokenCipher,
  mailTokenAad,
  type EncryptedToken,
} from "../src/mail/crypto";
import {
  MailReauthRequiredError,
  getValidAccessToken,
  type TokenStoreDeps,
} from "../src/mail/tokenStore";
import {
  MailboxProviderError,
  type MailboxProvider,
  type TokenSet,
} from "../src/mail/providers/types";

const KEY = Buffer.alloc(32, 5).toString("base64");

function connection(overrides: Partial<MailConnection> = {}): MailConnection {
  return {
    id: "conn_1",
    emailIdentityId: "identity_1",
    provider: "GOOGLE",
    providerAccountId: "google-sub",
    emailAddress: "alice@example.com",
    displayName: null,
    scopes: [],
    accessTokenCiphertext: null,
    accessTokenIv: null,
    accessTokenTag: null,
    accessTokenExpiresAt: null,
    refreshTokenCiphertext: null,
    refreshTokenIv: null,
    refreshTokenTag: null,
    tokenKeyVersion: 1,
    tokenVersion: 4,
    status: "CONNECTED",
    statusReason: null,
    lastRefreshedAt: null,
    lastSyncedAt: null,
    lastSyncError: null,
    syncCursor: null,
    syncCursorAt: null,
    initialSyncDone: false,
    watchExpiresAt: null,
    subscriptionId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function envelope(
  cipher: MailTokenCipher,
  value: string,
  field: "access_token" | "refresh_token",
  connectionId = "conn_1",
) {
  const encrypted = cipher.encrypt(value, mailTokenAad(connectionId, "GOOGLE", field));
  return {
    [`${field === "access_token" ? "accessToken" : "refreshToken"}Ciphertext`]:
      encrypted.ciphertext,
    [`${field === "access_token" ? "accessToken" : "refreshToken"}Iv`]: encrypted.iv,
    [`${field === "access_token" ? "accessToken" : "refreshToken"}Tag`]: encrypted.tag,
  };
}

interface UpdateArgs {
  where: { id: string; tokenVersion?: number };
  data: Record<string, unknown>;
}

function fakeDb(row: MailConnection | null) {
  const updates: UpdateArgs[] = [];
  const db = {
    mailConnection: {
      findUnique: async () => row,
      updateMany: async (args: UpdateArgs) => {
        updates.push(args);
        return { count: 1 };
      },
    },
  };
  return { db: db as unknown as PrismaClient, updates };
}

function providerWith(refresh: () => Promise<TokenSet>): MailboxProvider {
  return { refresh } as unknown as MailboxProvider;
}

describe("getValidAccessToken", () => {
  it("returns a cached access token without refreshing", async () => {
    const cipher = MailTokenCipher.fromOptions({ key: KEY, keyVersion: 1 });
    const row = connection({
      accessTokenExpiresAt: new Date(Date.now() + 10 * 60_000),
      ...envelope(cipher, "cached-token", "access_token"),
    });
    const { db } = fakeDb(row);
    let refreshed = false;

    const result = await getValidAccessToken(
      {
        db,
        cipher,
        providers: {
          GOOGLE: providerWith(async () => {
            refreshed = true;
            throw new Error("should not refresh");
          }),
        },
      },
      row.id,
    );

    expect(result.accessToken).toBe("cached-token");
    expect(refreshed).toBe(false);
  });

  it("refreshes an expired token and persists encrypted rotated tokens", async () => {
    const cipher = MailTokenCipher.fromOptions({ key: KEY, keyVersion: 1 });
    const row = connection({
      accessTokenExpiresAt: new Date(Date.now() - 60_000),
      ...envelope(cipher, "expired-token", "access_token"),
      ...envelope(cipher, "refresh-token", "refresh_token"),
    });
    const { db, updates } = fakeDb(row);
    const expiresAt = new Date(Date.now() + 3600_000);

    const result = await getValidAccessToken(
      {
        db,
        cipher,
        providers: {
          GOOGLE: providerWith(async () => ({
            accessToken: "fresh-token",
            refreshToken: "rotated-refresh",
            expiresAt,
            scopes: ["scope-a"],
          })),
        },
      },
      row.id,
    );

    expect(result.accessToken).toBe("fresh-token");
    const update = updates[0]!;
    expect(update.where).toEqual({ id: "conn_1", tokenVersion: 4 });
    expect(update.data.tokenVersion).toEqual({ increment: 1 });
    expect(update.data.accessTokenExpiresAt).toBe(expiresAt);
    expect(update.data.scopes).toEqual(["scope-a"]);

    const storedAccess: EncryptedToken = {
      ciphertext: update.data.accessTokenCiphertext as Uint8Array,
      iv: update.data.accessTokenIv as Uint8Array,
      tag: update.data.accessTokenTag as Uint8Array,
      keyVersion: update.data.tokenKeyVersion as number,
    };
    expect(
      cipher.decrypt(storedAccess, mailTokenAad("conn_1", "GOOGLE", "access_token")),
    ).toBe("fresh-token");

    const storedRefresh: EncryptedToken = {
      ciphertext: update.data.refreshTokenCiphertext as Uint8Array,
      iv: update.data.refreshTokenIv as Uint8Array,
      tag: update.data.refreshTokenTag as Uint8Array,
      keyVersion: update.data.tokenKeyVersion as number,
    };
    expect(
      cipher.decrypt(storedRefresh, mailTokenAad("conn_1", "GOOGLE", "refresh_token")),
    ).toBe("rotated-refresh");
  });

  it("marks the connection NEEDS_REAUTH when the provider rejects the grant", async () => {
    const cipher = MailTokenCipher.fromOptions({ key: KEY, keyVersion: 1 });
    const row = connection({
      accessTokenExpiresAt: new Date(Date.now() - 60_000),
      ...envelope(cipher, "expired-token", "access_token"),
      ...envelope(cipher, "refresh-token", "refresh_token"),
    });
    const { db, updates } = fakeDb(row);
    const deps: TokenStoreDeps = {
      db,
      cipher,
      providers: {
        GOOGLE: providerWith(async () => {
          throw new MailboxProviderError("invalid_grant", {
            code: "invalid_grant",
            reauthRequired: true,
          });
        }),
      },
    };

    await expect(getValidAccessToken(deps, row.id)).rejects.toBeInstanceOf(
      MailReauthRequiredError,
    );
    expect(updates[0]?.data).toMatchObject({
      status: "NEEDS_REAUTH",
      statusReason: "invalid_grant",
      refreshTokenCiphertext: null,
    });
  });

  it("refuses a connection that is already flagged", async () => {
    const cipher = MailTokenCipher.fromOptions({ key: KEY, keyVersion: 1 });
    const row = connection({ status: "NEEDS_REAUTH", statusReason: "revoked" });
    const { db } = fakeDb(row);

    await expect(
      getValidAccessToken({ db, cipher, providers: {} }, row.id),
    ).rejects.toBeInstanceOf(MailReauthRequiredError);
  });
});
