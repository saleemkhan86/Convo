/**
 * SmsProvider abstraction.
 *
 * Mirrors the EmailProvider seam (src/email/provider.ts): call sites depend on
 * this interface, and a vendor adapter (Twilio/MSG91/etc.) is added by
 * implementing it and returning it from createSmsProvider — no call site
 * changes. Provider credentials stay server-side.
 */

export interface OutgoingSms {
  /** Recipient in E.164, exactly as stored on PhoneIdentity. */
  to: string;
  body: string;
  /**
   * OTP challenge id + requester IP, for the dev log trail. Vendor adapters
   * ignore it; it never leaves the server.
   */
  ref?: { challengeId: string; ip?: string };
}

export interface SmsSendResult {
  providerMessageId?: string;
  accepted: boolean;
}

export interface SmsProvider {
  readonly name: string;
  sendSms(message: OutgoingSms): Promise<SmsSendResult>;
}
