import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { PrismaClient } from "@prisma/client";
import type { Config } from "../../config.js";
import { AppError, badRequest } from "../../lib/errors.js";
import {
  beginMailOAuth,
  finishMailOAuth,
  createMailTokenCipher,
  createMailboxProviders,
  isMailboxOAuthConfigured,
} from "../../mail/index.js";
import { consumeAuthHandoff, createAuthHandoff } from "../../mail/oauthState.js";
import type { OAuthClient } from "../../mail/oauthState.js";
import { storeConnectionTokens } from "../../mail/tokenStore.js";
import { issueSession } from "../../services/auth.js";
import { createEmailProvider } from "../../email/index.js";
import { createSmsProvider } from "../../sms/index.js";

const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const googleJWKS = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));

export interface GoogleOAuthDeps {
  db: PrismaClient;
  config: Config;
}

export async function googleOAuthRoutes(
  app: FastifyInstance,
  deps: GoogleOAuthDeps,
): Promise<void> {
  /**
   * GET /auth/google?purpose=SIGN_IN&client=web&redirect_after=/dashboard
   * Initiates Google OAuth with PKCE. Redirects to Google consent screen.
   */
  app.get("/auth/google", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isMailboxOAuthConfigured(deps.config)) {
      throw new AppError(503, "INTERNAL_ERROR", "Google OAuth is not configured");
    }

    const query = request.query as {
      purpose?: string;
      client?: string;
      redirect_after?: string;
    };
    const purpose = query.purpose === "CONNECT" ? "CONNECT" : "SIGN_IN";
    const client: OAuthClient = query.client === "mobile" ? "mobile" : "web";
    const redirectAfter = query.redirect_after;

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
        purpose,
        provider: "GOOGLE",
        client,
        redirectAfter,
      },
    );

    return reply.redirect(result.authorizationUrl);
  });

  /**
   * GET /auth/google/callback?code=...&state=...
   * Handles Google's OAuth callback. Verifies ID token, creates/links identity
   * and connection, issues one-time handoff code.
   */
  app.get("/auth/google/callback", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isMailboxOAuthConfigured(deps.config)) {
      throw new AppError(503, "INTERNAL_ERROR", "Google OAuth is not configured");
    }

    const query = request.query as { code?: string; state?: string; error?: string };
    if (query.error) {
      throw badRequest(`OAuth error: ${query.error}`);
    }
    if (!query.code || !query.state) {
      throw badRequest("Missing code or state parameter");
    }

    const cipher = createMailTokenCipher(deps.config);
    const providers = createMailboxProviders(deps.config);

    const oauthResult = await finishMailOAuth(
      {
        db: deps.db,
        cipher,
        providers,
        stateTtlSeconds: deps.config.MAIL_OAUTH_STATE_TTL_SECONDS,
        redirectUris: { GOOGLE: deps.config.GOOGLE_REDIRECT_URI },
      },
      {
        state: query.state,
        code: query.code,
      },
    );

    // Verify Google ID token to confirm email ownership.
    const idToken = oauthResult.tokens.idToken;
    if (!idToken) {
      throw new AppError(400, "VALIDATION_ERROR", "No ID token in OAuth response");
    }

    let googlePayload: { email?: string; email_verified?: boolean; sub?: string };
    try {
      const { payload } = await jwtVerify(idToken, googleJWKS, {
        issuer: "https://accounts.google.com",
        audience: deps.config.GOOGLE_CLIENT_ID,
      });
      googlePayload = payload as typeof googlePayload;
    } catch (error) {
      throw new AppError(400, "VALIDATION_ERROR", "ID token verification failed");
    }

    if (googlePayload.email !== oauthResult.profile.email) {
      throw new AppError(400, "VALIDATION_ERROR", "ID token email does not match profile");
    }

    // Create or link EmailIdentity and MailConnection.
    const emailIdentity = await deps.db.emailIdentity.upsert({
      where: { email: oauthResult.profile.email },
      create: {
        userId: await findOrCreateUserForOAuth(deps, oauthResult.profile.email),
        email: oauthResult.profile.email,
        verificationMethod: "OAUTH",
      },
      update: {
        verificationMethod: "OAUTH",
      },
    });

    // Store MailConnection with encrypted tokens.
    await storeConnectionTokens(
      { db: deps.db, cipher, providers },
      {
        emailIdentityId: emailIdentity.id,
        provider: oauthResult.provider,
        providerAccountId: oauthResult.profile.providerAccountId,
        emailAddress: oauthResult.profile.email,
        displayName: oauthResult.profile.displayName,
        tokens: oauthResult.tokens,
      },
    );

    // Issue one-time handoff code for the client to exchange for session tokens.
    const userId = emailIdentity.userId;
    const handoff = await createAuthHandoff(deps.db, {
      userId,
      ttlSeconds: deps.config.MAIL_OAUTH_HANDOFF_TTL_SECONDS,
    });

    // Redirect to client with handoff code.
    const redirectUrl = oauthResult.redirectAfter ?? deps.config.APP_URL;
    const separator = redirectUrl.includes("?") ? "&" : "?";
    return reply.redirect(`${redirectUrl}${separator}code=${handoff.code}`);
  });

  /**
   * POST /auth/oauth/exchange
   * Exchanges one-time handoff code for session tokens.
   */
  app.post("/auth/oauth/exchange", async (request: FastifyRequest) => {
    const body = request.body as { code?: string };
    if (!body.code) {
      throw badRequest("Missing code");
    }

    const handoff = await consumeAuthHandoff(deps.db, body.code);
    const userId = handoff.userId;

    // Issue session tokens.
    const session = await issueSession(
      {
        db: deps.db,
        config: deps.config,
        email: createEmailProvider(deps.config),
        sms: createSmsProvider(deps.config),
        jwt: request.server,
      },
      userId,
      {
        ip: request.ip,
        deviceInfo: typeof request.headers["user-agent"] === "string"
          ? request.headers["user-agent"].slice(0, 255)
          : undefined,
      },
    );

    return {
      session: {
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        accessExpiresInSeconds: session.accessExpiresInSeconds,
      },
      userId,
    };
  });
}

/**
 * Creates a new user for OAuth sign-in, or returns the existing user if the
 * email is already linked to an account.
 */
async function findOrCreateUserForOAuth(
  deps: GoogleOAuthDeps,
  email: string,
): Promise<string> {
  // Check if email is already linked to a user.
  const existingEmailIdentity = await deps.db.emailIdentity.findUnique({
    where: { email },
    include: { user: true },
  });
  if (existingEmailIdentity) {
    return existingEmailIdentity.user.id;
  }

  // Create a new user with this email identity.
  try {
    const user = await deps.db.user.create({
      data: {
        emailIdentity: { create: { email, verificationMethod: "OAUTH" } },
      },
    });
    return user.id;
  } catch (err) {
    // Race condition: another request created the user first.
    if (typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code === "P2002") {
      const raced = await deps.db.emailIdentity.findUniqueOrThrow({
        where: { email },
        include: { user: true },
      });
      return raced.user.id;
    }
    throw err;
  }
}
