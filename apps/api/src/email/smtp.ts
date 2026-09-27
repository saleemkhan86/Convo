import nodemailer, { type Transporter } from "nodemailer";
import type {
  EmailProvider,
  OutgoingEmail,
  ParsedEmail,
  ProviderSendResult,
  ProviderWebhookEvent,
} from "./provider.js";

export interface SmtpProviderConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
}

/**
 * Generic SMTP adapter — works with Mailpit locally and any transactional
 * SMTP relay in production. Additional adapters (Resend, SendGrid, …) can be
 * added by implementing EmailProvider without touching call sites.
 */
export class SmtpProvider implements EmailProvider {
  readonly name = "smtp";
  private transporter: Transporter;
  private readonly defaultFrom: string;

  constructor(config: SmtpProviderConfig) {
    this.defaultFrom = config.from;
    this.transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: config.user ? { user: config.user, pass: config.pass } : undefined,
    });
  }

  async sendEmail(email: OutgoingEmail): Promise<ProviderSendResult> {
    const info = await this.transporter.sendMail({
      from: email.from ?? this.defaultFrom,
      to: email.to.join(", "),
      cc: email.cc?.join(", "),
      bcc: email.bcc?.join(", "),
      replyTo: email.replyTo,
      subject: email.subject,
      text: email.text,
      html: email.html,
      messageId: email.messageId,
      inReplyTo: email.inReplyTo,
      references: email.references?.join(" "),
      attachments: email.attachments?.map((a) => ({
        filename: a.filename,
        contentType: a.contentType,
        content: Buffer.from(a.content),
      })),
    });
    return {
      providerMessageId: info.messageId,
      accepted: (info.accepted ?? []).map(String),
      rejected: (info.rejected ?? []).map(String),
    };
  }

  async parseEmail(_raw: string | Buffer): Promise<ParsedEmail> {
    // Full RFC822 parsing arrives with the inbound gateway in Phase 4
    // (see docs/TODO.md). Kept out of the MVP send path.
    throw new Error("parseEmail not implemented for SMTP adapter yet (Phase 4)");
  }

  async handleWebhook(_payload: unknown): Promise<ProviderWebhookEvent[]> {
    // Generic SMTP has no webhooks; bounce handling comes from the
    // queue worker inspecting SMTP errors (Phase 4).
    return [];
  }
}
