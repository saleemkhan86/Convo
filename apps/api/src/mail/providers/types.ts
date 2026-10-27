/**
 * Provider-neutral mailbox contract. Gmail is the first adapter; Microsoft
 * Graph implements the same surface so sync/send code never branches on
 * vendor outside `providers/`.
 */

export type MailProviderId = "GOOGLE" | "MICROSOFT";

export interface MailAddress {
  address: string;
  name?: string;
}

export interface ProviderProfile {
  providerAccountId: string;
  email: string;
  emailVerified: boolean;
  displayName?: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
  scopes: string[];
  idToken?: string;
}

export interface AuthorizationUrlArgs {
  state: string;
  codeChallenge: string;
  nonce: string;
  redirectUri: string;
}

export interface ExchangeCodeArgs {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

export interface RawAttachmentRef {
  providerAttachmentId: string;
  filename: string;
  mimeType: string;
  sizeBytes?: number;
  /** Gmail inline parts (images referenced by cid:). */
  inline?: boolean;
  contentId?: string;
}

export interface RawMailMessage {
  providerMessageId: string;
  providerThreadId?: string;
  internetMessageId?: string;
  inReplyTo?: string;
  references: string[];
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  subject?: string;
  bodyHtml?: string;
  bodyText?: string;
  snippet?: string;
  sentAt?: Date;
  receivedAt?: Date;
  isRead: boolean;
  isBounce: boolean;
  attachments: RawAttachmentRef[];
}

export interface SyncOptions {
  /** Leading window for the first page of a sync, in days. */
  sinceDays: number;
  pageSize: number;
  /** Provider page token (Gmail pageToken / Graph skipToken). */
  pageToken?: string;
  /** Fetch concurrency ceiling for per-message calls. */
  concurrency: number;
  signal?: AbortSignal;
}

export interface SyncPage {
  messages: RawMailMessage[];
  /** Cursor to persist once this page is committed (historyId / deltaLink). */
  cursor: string;
  /** Set when more pages are available right now. */
  nextPageToken?: string;
}

export interface OutgoingAttachment {
  filename: string;
  mimeType: string;
  content: Uint8Array;
}

export interface OutgoingMail {
  from: MailAddress;
  to: MailAddress[];
  cc?: MailAddress[];
  bcc?: MailAddress[];
  subject: string;
  text: string;
  html?: string;
  /** Full RFC 5322 Message-ID including angle brackets, when pre-assigned. */
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  /** Provider thread to keep the reply in (Gmail threadId). */
  threadId?: string;
  attachments?: OutgoingAttachment[];
  /** Headers that must survive (GmailReferences etc.). */
  headers?: Record<string, string>;
}

export interface RejectedRecipient {
  address: string;
  reason?: string;
}

export interface SendReceipt {
  providerMessageId: string;
  providerThreadId?: string;
  internetMessageId?: string;
  acceptedRecipients: string[];
  rejectedRecipients: RejectedRecipient[];
}

export interface MailboxProvider {
  readonly id: MailProviderId;

  authorizationUrl(args: AuthorizationUrlArgs): string;
  exchangeCode(args: ExchangeCodeArgs): Promise<TokenSet>;
  refresh(refreshToken: string): Promise<TokenSet>;
  revoke(token: string): Promise<void>;
  getProfile(accessToken: string): Promise<ProviderProfile>;

  initialSync(accessToken: string, options: SyncOptions): Promise<SyncPage>;
  /** `cursor` is the provider cursor; expired cursors throw `resetRequired`. */
  incrementalSync(accessToken: string, cursor: string, options: SyncOptions): Promise<SyncPage>;

  send(accessToken: string, message: OutgoingMail): Promise<SendReceipt>;
  fetchAttachment(
    accessToken: string,
    providerMessageId: string,
    providerAttachmentId: string,
  ): Promise<Buffer>;
}

export type MailboxProviderRegistry = Partial<Record<MailProviderId, MailboxProvider>>;

export interface MailboxProviderErrorOptions {
  status?: number;
  code?: string;
  retryable?: boolean;
  /** Token rejected: connection must be re-authorized. */
  reauthRequired?: boolean;
  /** Sync cursor expired: drop it and run a full sync. */
  resetRequired?: boolean;
  cause?: unknown;
}

export class MailboxProviderError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly retryable: boolean;
  readonly reauthRequired: boolean;
  readonly resetRequired: boolean;

  constructor(message: string, options: MailboxProviderErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = "MailboxProviderError";
    this.status = options.status;
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.reauthRequired = options.reauthRequired ?? false;
    this.resetRequired = options.resetRequired ?? false;
  }
}
