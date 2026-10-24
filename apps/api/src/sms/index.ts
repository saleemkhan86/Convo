import type { Config } from "../config.js";
import { ConsoleSmsProvider } from "./console.js";
import type { SmsProvider } from "./provider.js";
import { UnconfiguredSmsProvider } from "./unconfigured.js";

export type { SmsProvider, OutgoingSms, SmsSendResult } from "./provider.js";

/**
 * No SMS vendor is integrated yet (spec §3 keeps phone sign-up in scope, but the
 * transport was never wired up). Development logs the code, exactly as the
 * inline console.log did before this seam existed; production refuses loudly
 * until an adapter is implemented.
 *
 * To add a vendor: create src/sms/<vendor>.ts implementing SmsProvider, read
 * its credentials from config.ts, and return it here when configured — the same
 * shape as createEmailProvider().
 */
export function createSmsProvider(config: Config): SmsProvider {
  if (config.isProduction) {
    return new UnconfiguredSmsProvider();
  }
  return new ConsoleSmsProvider();
}
