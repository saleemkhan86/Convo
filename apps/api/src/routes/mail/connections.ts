import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { Config } from "../../config.js";
import { AppError, badRequest, notFound, unauthorized } from "../../lib/errors.js";
import { authenticatePreHandler } from "../../plugins/auth.js";
import {
  beginMailOAuth,
  createMailTokenCipher,
  createMailboxProviders,
  isMailboxOAuthConfigured,
} from "../../mail/index.js";
import type { MailboxProviderRegistry } from "../../mail/providers/types.js";
import { getValidAccessToken, markConnectionNeedsReauth, decryptField } from "../../mail/tokenStore.js";
import { fetchMailSyncPage, initialSyncOptions } from "../../mail/sync.js";
import { MailboxProviderError } from "../../mail/providers/types.js";
import type { OAuthClient } from "../../mail/oauthState.js";

export interface ConnectionRoutesDeps {
  db: PrismaClient;
  config: Config;
}

export async function connectionRoutes(
  app: FastifyInstance,
  deps: ConnectionRoutesDeps,
): Promise<void> {
  app.addHook("preHandler", authenticatePreHandler(deps.db));

  /**
   * POST /mail/connections/google/start
   * Initiates an authenticated connect flow for an existing logged-in user.
   */
  app.post("/mail/connections/google/start", async (request: FastifyRequest) => {
    if (!isMailboxOAuthConfigured(deps.config)) {
      throw new AppError(503, "INTERNAL_ERROR", "Google OAuth is not configured");
    }

    const userId = request.currentUser?.id;
    if (!userId) throw unauthorized();

    const body = request.body as { client?: string; redirect_after?: string } | undefined;
    const client: OAuthClient = body?.client === "mobile" ? "mobile" : "web";
    const redirectAfter = body?.redirect_after;

    // Check if user already has a Google connection.
    const existingConnection = await deps.db.mailConnection.findFirst({
      where: {
        emailIdentity: { userId },
        provider: "GOOGLE",
      },
      include: { emailIdentity: true },
    });

    if (existingConnection && existingConnection.status === "CONNECTED") {
      throw badRequest("User already has an active Google connection");
    }

    const cipher = createMailTokenCipher(deps.config);
    const providers = createMailboxProviders(deps.config);

    const result = await beginMailOAuth(
      {
        db: deps.db,
        cipher,
        providers,
        stateTtlSeconds: deps.config.MAIL_OAUTH_STATE_TTL_SECONDS,
        redirectUris: { GOOGLE: deps.config.GOOGLE_REDIRECT_URI },
      },
      {
        purpose: "CONNECT",
        provider: "GOOGLE",
        userId,
        client,
        redirectAfter,
      },
    );

    return {
      authorizationUrl: result.authorizationUrl,
      state: result.state,
      expiresAt: result.expiresAt.toISOString(),
    };
  });

  /**
   * GET /mail/connections
   * Lists all mail connections for the authenticated user.
   */
  app.get("/mail/connections", async (request: FastifyRequest) => {
    const userId = request.currentUser?.id;
    if (!userId) throw unauthorized();

    const connections = await deps.db.mailConnection.findMany({
      where: { emailIdentity: { userId } },
      select: {
        id: true,
        provider: true,
        emailAddress: true,
        displayName: true,
        status: true,
        statusReason: true,
        lastSyncedAt: true,
        createdAt: true,
      },
    });

    return {
      connections: connections.map((conn) => ({
        id: conn.id,
        provider: conn.provider,
        emailAddress: conn.emailAddress,
        displayName: conn.displayName,
        status: conn.status,
        statusReason: conn.statusReason,
        lastSyncedAt: conn.lastSyncedAt?.toISOString() ?? null,
        createdAt: conn.createdAt.toISOString(),
      })),
    };
  });

  /**
   * DELETE /mail/connections/:id
   * Revokes the provider token and deletes the connection.
   */
  app.delete("/mail/connections/:id", async (request: FastifyRequest) => {
    const userId = request.currentUser?.id;
    if (!userId) throw unauthorized();

    const { id } = request.params as { id: string };

    const connection = await deps.db.mailConnection.findFirst({
      where: { id, emailIdentity: { userId } },
    });

    if (!connection) {
      throw notFound("Connection not found");
    }

    // Revoke the token if we have one.
    if (connection.refreshTokenCiphertext && connection.refreshTokenIv && connection.refreshTokenTag) {
      try {
        const cipher = createMailTokenCipher(deps.config);
        const providers = createMailboxProviders(deps.config);
        const provider = providers[connection.provider];
        if (provider) {
          const refreshToken = decryptField(cipher, connection, "refresh_token");
          await provider.revoke(refreshToken);
        }
      } catch (error) {
        // Log but don't fail — we're deleting anyway.
        request.log.warn({ err: error }, "Failed to revoke provider token during disconnect");
      }
    }

    // Mark as revoked and clear tokens.
    await markConnectionNeedsReauth(deps.db, id, "user_disconnected");

    // Delete the connection.
    await deps.db.mailConnection.delete({ where: { id } });

    return { ok: true };
  });

  /**
   * POST /mail/connections/:id/sync
   * Triggers a manual incremental sync for the connection.
   */
  app.post("/mail/connections/:id/sync", async (request: FastifyRequest) => {
    const userId = request.currentUser?.id;
    if (!userId) throw unauthorized();

    const { id } = request.params as { id: string };

    const connection = await deps.db.mailConnection.findFirst({
      where: { id, emailIdentity: { userId } },
    });

    if (!connection) {
      throw notFound("Connection not found");
    }

    if (connection.status !== "CONNECTED") {
      throw badRequest(`Connection is not active (status: ${connection.status})`);
    }

    const cipher = createMailTokenCipher(deps.config);
    const providers = createMailboxProviders(deps.config);

    try {
      const { accessToken } = await getValidAccessToken(
        { db: deps.db, cipher, providers },
        connection.id,
      );

      const provider = providers[connection.provider];
      if (!provider) {
        throw new AppError(503, "INTERNAL_ERROR", `Provider ${connection.provider} not configured`);
      }

      const syncOptions = initialSyncOptions({
        sinceDays: deps.config.MAIL_SYNC_INITIAL_DAYS,
        pageSize: deps.config.MAIL_SYNC_PAGE_SIZE,
        concurrency: deps.config.MAIL_SYNC_CONCURRENCY,
      });

      const result = await fetchMailSyncPage({
        provider,
        accessToken,
        cursor: connection.syncCursor,
        options: syncOptions,
      });

      // Update connection with new cursor and sync timestamp.
      await deps.db.mailConnection.update({
        where: { id: connection.id },
        data: {
          syncCursor: result.cursor,
          syncCursorAt: new Date(),
          lastSyncedAt: new Date(),
          initialSyncDone: true,
          lastSyncError: null,
        },
      });

      // TODO: Process synced messages (Phase 3.2)

      return {
        connectionId: connection.id,
        syncedCount: result.page.messages.length,
        cursor: result.cursor,
        nextCursor: result.page.nextPageToken ?? null,
      };
    } catch (error) {
      if (error instanceof MailboxProviderError) {
        if (error.reauthRequired) {
          await markConnectionNeedsReauth(deps.db, connection.id, error.code ?? "reauth_required");
          throw new AppError(401, "UNAUTHORIZED", "Connection needs re-authorization");
        }
        if (error.resetRequired) {
          // Cursor expired; clear it so next sync is a full resync.
          await deps.db.mailConnection.update({
            where: { id: connection.id },
            data: { syncCursor: null, syncCursorAt: null, lastSyncError: error.message },
          });
          throw badRequest("Sync cursor expired; next sync will be a full resync");
        }
      }
      throw error;
    }
  });
}
