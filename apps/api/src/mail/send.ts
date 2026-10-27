import {
  MailboxProviderError,
  type MailboxProvider,
  type OutgoingMail,
  type SendReceipt,
} from "./providers/types.js";

export interface MailSendRequest {
  provider: MailboxProvider;
  accessToken: string;
  message: OutgoingMail;
}

export async function sendMailWithProvider(request: MailSendRequest): Promise<SendReceipt> {
  return request.provider.send(request.accessToken, request.message);
}

export function isRetryableSendError(error: unknown): boolean {
  return error instanceof MailboxProviderError && error.retryable && !error.reauthRequired;
}

/** Exponential backoff with jitter for the send outbox. */
export function retryDelayMs(
  attempt: number,
  options: { baseMs?: number; capMs?: number; random?: () => number } = {},
): number {
  const base = options.baseMs ?? 1_000;
  const cap = options.capMs ?? 60_000;
  const random = options.random ?? Math.random;
  const exponential = Math.min(cap, base * 2 ** Math.max(0, attempt));
  return Math.round(exponential * (0.5 + random() * 0.5));
}
