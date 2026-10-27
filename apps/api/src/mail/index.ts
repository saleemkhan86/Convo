import type { Config } from "../config.js";
import { MailTokenCipher } from "./crypto.js";
import { GoogleMailProvider } from "./providers/google.js";
import type { MailboxProviderRegistry } from "./providers/types.js";

export * from "./crypto.js";
export * from "./oauth.js";
export * from "./oauthState.js";
export * from "./parser.js";
export * from "./providers/types.js";
export * from "./providers/google.js";
export * from "./send.js";
export * from "./sync.js";
export * from "./tokenStore.js";

/** True when at least one mailbox provider has credentials. */
export function isMailboxOAuthConfigured(config: Config): boolean {
  return Boolean(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET);
}

/**
 * Token encryption is optional at boot so existing deployments keep running.
 * Any route that touches a connection must call this and fail closed when the
 * key is absent.
 */
export function createMailTokenCipher(config: Config): MailTokenCipher {
  return MailTokenCipher.fromEnv(config);
}

export function createMailboxProviders(
  config: Config,
  fetchImpl: typeof fetch = fetch,
): MailboxProviderRegistry {
  const providers: MailboxProviderRegistry = {};
  if (config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET) {
    providers.GOOGLE = new GoogleMailProvider({
      clientId: config.GOOGLE_CLIENT_ID,
      clientSecret: config.GOOGLE_CLIENT_SECRET,
      redirectUri: config.GOOGLE_REDIRECT_URI,
      messageIdDomain: config.MAIL_MESSAGE_ID_DOMAIN,
      fetchImpl,
    });
  }
  return providers;
}
