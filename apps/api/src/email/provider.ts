/**
 * EmailProvider abstraction (spec §14).
 *
 * All provider credentials stay server-side. Adapters implement sending;
 * inbound processing (IMAP polling / webhook) lands in Phase 4 behind
 * parseEmail/handleWebhook.
 */

export interface OutgoingEmail {
  to: string[];
  cc?: string[];
  bcc?: string[];
  from?: string;
  replyTo?: string;
  subject: string;
  text: string;
  html?: string;
  /** RFC 5322 threading headers preserved end-to-end (spec §15). */
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: EmailAttachmentInput[];
}

export interface EmailAttachmentInput {
  filename: string;
  contentType: string;
  content: Buffer | Uint8Array;
}

export interface ProviderSendResult {
  providerMessageId?: string;
  accepted: string[];
  rejected: string[];
}

export interface ParsedEmail {
  messageId: string;
  inReplyTo?: string;
  references: string[];
  from: string;
  to: string[];
  cc: string[];
  subject?: string;
  text?: string;
  html?: string;
  receivedAt: Date;
  attachments: { filename: string; contentType: string; content: Buffer }[];
}

export interface ProviderWebhookEvent {
  event: string; // "delivered" | "bounce" | "complaint" | ...
  providerMessageId?: string;
  recipient?: string;
  raw: unknown;
}

export interface EmailProvider {
  readonly name: string;
  sendEmail(email: OutgoingEmail): Promise<ProviderSendResult>;
  parseEmail(raw: string | Buffer): Promise<ParsedEmail>;
  handleWebhook(payload: unknown): Promise<ProviderWebhookEvent[]>;
}
