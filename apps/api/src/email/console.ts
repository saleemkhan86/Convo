import type {
  EmailProvider,
  OutgoingEmail,
  ParsedEmail,
  ProviderSendResult,
  ProviderWebhookEvent,
} from "./provider.js";

/**
 * Development fallback used when SMTP_HOST is not configured: logs emails
 * instead of sending them. Never selected in production.
 */
export class ConsoleEmailProvider implements EmailProvider {
  readonly name = "console";

  async sendEmail(email: OutgoingEmail): Promise<ProviderSendResult> {
    console.log(
      `[ConsoleEmailProvider] To: ${email.to.join(", ")} | Subject: ${email.subject}\n${email.text}`,
    );
    return { accepted: email.to, rejected: [] };
  }

  async parseEmail(_raw: string | Buffer): Promise<ParsedEmail> {
    throw new Error("parseEmail not implemented for console provider");
  }

  async handleWebhook(_payload: unknown): Promise<ProviderWebhookEvent[]> {
    return [];
  }
}
