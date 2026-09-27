import type { Config } from "../config.js";
import { ConsoleEmailProvider } from "./console.js";
import type { EmailProvider } from "./provider.js";
import { SmtpProvider } from "./smtp.js";

export type { EmailProvider, OutgoingEmail, ParsedEmail, ProviderSendResult } from "./provider.js";

export function createEmailProvider(config: Config): EmailProvider {
  if (!config.SMTP_HOST) {
    if (config.isProduction) {
      throw new Error("SMTP_HOST is required in production");
    }
    return new ConsoleEmailProvider();
  }
  return new SmtpProvider({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    user: config.SMTP_USER,
    pass: config.SMTP_PASS,
    from: config.MAIL_FROM,
  });
}
