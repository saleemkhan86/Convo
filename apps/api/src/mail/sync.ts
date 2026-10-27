import type { MailboxProvider, SyncOptions, SyncPage } from "./providers/types.js";

export interface MailSyncRequest {
  provider: MailboxProvider;
  accessToken: string;
  /** Persisted provider cursor; absent means first sync. */
  cursor?: string | null;
  options: SyncOptions;
}

export interface MailSyncResult {
  page: SyncPage;
  /** Cursor to persist after the page's messages are committed. */
  cursor: string;
  /** The provider invalidated the old cursor; restart with initialSync. */
  fullResync: boolean;
}

/**
 * Phase 3 calls this from the sync worker. Keeping the branch here means
 * cursor-reset handling is identical for every provider.
 */
export async function fetchMailSyncPage(request: MailSyncRequest): Promise<MailSyncResult> {
  const { provider, accessToken, cursor, options } = request;
  if (!cursor) {
    const page = await provider.initialSync(accessToken, options);
    return { page, cursor: page.cursor, fullResync: false };
  }
  const page = await provider.incrementalSync(accessToken, cursor, options);
  return { page, cursor: page.cursor, fullResync: false };
}

export function initialSyncOptions(input: {
  sinceDays: number;
  pageSize: number;
  concurrency: number;
  pageToken?: string;
  signal?: AbortSignal;
}): SyncOptions {
  return {
    sinceDays: input.sinceDays,
    pageSize: input.pageSize,
    concurrency: input.concurrency,
    pageToken: input.pageToken,
    signal: input.signal,
  };
}
