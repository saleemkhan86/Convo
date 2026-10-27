import type { MailProvider, PrismaClient } from "@prisma/client";
import { MailTokenCipher } from "./crypto.js";
import { consumeOAuthState, createOAuthState, type OAuthClient } from "./oauthState.js";
import {
  MailboxProviderError,
  type MailboxProviderRegistry,
  type MailProviderId,
  type ProviderProfile,
  type TokenSet,
} from "./providers/types.js";

export interface MailOAuthDeps {
  db: PrismaClient;
  cipher: MailTokenCipher;
  providers: MailboxProviderRegistry;
  stateTtlSeconds: number;
  /** Per-provider callback URL registered in the developer console. */
  redirectUris: Partial<Record<MailProviderId, string>>;
}

export interface BeginMailOAuthArgs {
  purpose: "SIGN_IN" | "CONNECT";
  provider: MailProvider;
  userId?: string;
  client?: OAuthClient;
  redirectAfter?: string;
}

export interface BeginMailOAuthResult {
  authorizationUrl: string;
  state: string;
  expiresAt: Date;
}

export async function beginMailOAuth(
  deps: MailOAuthDeps,
  args: BeginMailOAuthArgs,
): Promise<BeginMailOAuthResult> {
  const provider = deps.providers[args.provider];
  if (!provider) {
    throw new MailboxProviderError(`Mailbox provider ${args.provider} is not configured`, {
      code: "provider_not_configured",
    });
  }

  const state = await createOAuthState(
    { db: deps.db, cipher: deps.cipher },
    {
      purpose: args.purpose,
      provider: args.provider,
      userId: args.userId,
      client: args.client ?? "web",
      redirectAfter: args.redirectAfter,
      ttlSeconds: deps.stateTtlSeconds,
    },
  );

  const authorizationUrl = provider.authorizationUrl({
    state: state.state,
    codeChallenge: state.codeChallenge,
    nonce: state.nonce,
    redirectUri: deps.redirectUris[provider.id] ?? "",
  });

  return {
    authorizationUrl,
    state: state.state,
    expiresAt: state.expiresAt,
  };
}

export interface FinishMailOAuthArgs {
  state: string;
  code: string;
}

export interface FinishMailOAuthResult {
  provider: MailProvider;
  purpose: "SIGN_IN" | "CONNECT";
  userId: string | null;
  client: string;
  redirectAfter: string | null;
  tokens: TokenSet;
  profile: ProviderProfile;
}

export class MailOAuthAccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailOAuthAccountError";
  }
}

/**
 * Validates the callback, exchanges the code server-side, and loads the
 * provider profile. Token persistence and identity binding happen above this
 * layer, where the account rules live.
 */
export async function finishMailOAuth(
  deps: MailOAuthDeps,
  args: FinishMailOAuthArgs,
): Promise<FinishMailOAuthResult> {
  const state = await consumeOAuthState({ db: deps.db, cipher: deps.cipher }, args.state);
  const provider = deps.providers[state.provider];
  if (!provider) {
    throw new MailboxProviderError(`Mailbox provider ${state.provider} is not configured`, {
      code: "provider_not_configured",
    });
  }

  const tokens = await provider.exchangeCode({
    code: args.code,
    codeVerifier: state.codeVerifier,
    redirectUri: deps.redirectUris[provider.id] ?? "",
  });
  const profile = await provider.getProfile(tokens.accessToken);
  if (!profile.emailVerified) {
    throw new MailOAuthAccountError("The provider has not verified this email address");
  }

  return {
    provider: state.provider,
    purpose: state.purpose,
    userId: state.userId,
    client: state.client,
    redirectAfter: state.redirectAfter,
    tokens,
    profile,
  };
}
