import { randomUUID } from "node:crypto";
import {
  decodeRfc2047,
  formatAddressList,
  isBounceSender,
  isBounceSubject,
  normalizeMessageId,
  parseAddress,
  parseAddressList,
  parseMessageIdList,
  sanitizeHeaderValue,
  encodeHeaderValue,
} from "./address.js";
import {
  MailboxProviderError,
  type AuthorizationUrlArgs,
  type ExchangeCodeArgs,
  type MailboxProvider,
  type OutgoingMail,
  type ProviderProfile,
  type RawAttachmentRef,
  type RawMailMessage,
  type SendReceipt,
  type SyncOptions,
  type SyncPage,
  type TokenSet,
} from "./types.js";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";
const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1";

/**
 * Both Gmail scopes are Google "restricted" scopes: shipping to users outside
 * a test allowlist requires OAuth verification plus a CASA assessment.
 */
export const GOOGLE_MAIL_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
] as const;

export interface GoogleMailProviderOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Host used for generated RFC 5322 Message-IDs. */
  messageIdDomain: string;
  scopes?: readonly string[];
  fetchImpl?: typeof fetch;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  revokeEndpoint?: string;
  userInfoEndpoint?: string;
  gmailBaseUrl?: string;
  timeoutMs?: number;
}

interface GmailHeader {
  name?: string;
  value?: string;
}

interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailPart[];
}

interface GmailMessage {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

export class GoogleMailProvider implements MailboxProvider {
  readonly id = "GOOGLE" as const;

  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;
  private readonly messageIdDomain: string;
  private readonly scopes: readonly string[];
  private readonly fetchImpl: typeof fetch;
  private readonly authEndpoint: string;
  private readonly tokenEndpoint: string;
  private readonly revokeEndpoint: string;
  private readonly userInfoEndpoint: string;
  private readonly gmailBaseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: GoogleMailProviderOptions) {
    if (!options.clientId || !options.clientSecret) {
      throw new Error("GoogleMailProvider requires a client id and secret");
    }
    if (!options.redirectUri) {
      throw new Error("GoogleMailProvider requires a redirect URI");
    }
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.redirectUri = options.redirectUri;
    this.messageIdDomain = options.messageIdDomain;
    this.scopes = options.scopes ?? GOOGLE_MAIL_SCOPES;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.authEndpoint = options.authorizationEndpoint ?? AUTH_ENDPOINT;
    this.tokenEndpoint = options.tokenEndpoint ?? TOKEN_ENDPOINT;
    this.revokeEndpoint = options.revokeEndpoint ?? REVOKE_ENDPOINT;
    this.userInfoEndpoint = options.userInfoEndpoint ?? USERINFO_ENDPOINT;
    this.gmailBaseUrl = (options.gmailBaseUrl ?? GMAIL_BASE).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  authorizationUrl(args: AuthorizationUrlArgs): string {
    const url = new URL(this.authEndpoint);
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("redirect_uri", args.redirectUri || this.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", this.scopes.join(" "));
    url.searchParams.set("state", args.state);
    url.searchParams.set("code_challenge", args.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("nonce", args.nonce);
    // offline + consent are both required to receive a refresh token on
    // repeat authorizations.
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("include_granted_scopes", "true");
    return url.toString();
  }

  async exchangeCode(args: ExchangeCodeArgs): Promise<TokenSet> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: args.code,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: args.redirectUri || this.redirectUri,
      code_verifier: args.codeVerifier,
    });
    const response = await this.postForm<TokenResponse>(this.tokenEndpoint, body);
    if (response.error || !response.access_token) {
      throw new MailboxProviderError("Google code exchange failed", {
        code: response.error ?? "invalid_response",
        retryable: false,
      });
    }
    return this.toTokenSet(response);
  }

  async refresh(refreshToken: string): Promise<TokenSet> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });
    const response = await this.postForm<TokenResponse>(this.tokenEndpoint, body, {
      reauthOnInvalidGrant: true,
    });
    if (response.error || !response.access_token) {
      const invalidGrant = response.error === "invalid_grant";
      throw new MailboxProviderError("Google token refresh failed", {
        code: response.error ?? "invalid_response",
        reauthRequired: invalidGrant,
        retryable: false,
      });
    }
    return this.toTokenSet(response);
  }

  async revoke(token: string): Promise<void> {
    const response = await this.request(this.revokeEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    });
    // 400 means the token was already invalid — the desired end state.
    if (!response.ok && response.status !== 400) {
      throw new MailboxProviderError("Google token revocation failed", {
        status: response.status,
        retryable: response.status >= 500 || response.status === 429,
      });
    }
  }

  async getProfile(accessToken: string): Promise<ProviderProfile> {
    const profile = await this.getJson<{
      sub?: string;
      email?: string;
      email_verified?: boolean;
      name?: string;
    }>(this.userInfoEndpoint, accessToken, "Google userinfo");
    if (!profile.sub || !profile.email) {
      throw new MailboxProviderError("Google userinfo did not include an account id or email", {
        code: "invalid_profile",
      });
    }
    return {
      providerAccountId: profile.sub,
      email: profile.email.toLowerCase(),
      emailVerified: profile.email_verified === true,
      displayName: profile.name,
    };
  }

  async initialSync(accessToken: string, options: SyncOptions): Promise<SyncPage> {
    // Capture the mailbox history point before listing. Overlap is harmless
    // because message ids are deduped; a later cursor could miss arrivals.
    const profile = await this.getJson<{ historyId?: string }>(
      `${this.gmailBaseUrl}/users/me/profile`,
      accessToken,
      "Gmail profile",
      options.signal,
    );
    if (!profile.historyId) {
      throw new MailboxProviderError("Gmail profile has no historyId", {
        code: "invalid_profile",
      });
    }

    const params = new URLSearchParams({
      maxResults: String(options.pageSize),
      q: `newer_than:${options.sinceDays}d (in:inbox OR in:sent)`,
    });
    if (options.pageToken) params.set("pageToken", options.pageToken);
    const list = await this.getJson<{
      messages?: { id?: string }[];
      nextPageToken?: string;
    }>(
      `${this.gmailBaseUrl}/users/me/messages?${params.toString()}`,
      accessToken,
      "Gmail message list",
      options.signal,
    );

    const ids = (list.messages ?? [])
      .map((message) => message.id)
      .filter((id): id is string => Boolean(id));
    const fetched = await mapWithConcurrency(ids, options.concurrency, (id) =>
      this.getMessageOrNull(accessToken, id, options.signal),
    );
    const messages = fetched.filter((message): message is RawMailMessage => message !== null);

    return {
      messages,
      cursor: profile.historyId,
      nextPageToken: list.nextPageToken,
    };
  }

  async incrementalSync(
    accessToken: string,
    cursor: string,
    options: SyncOptions,
  ): Promise<SyncPage> {
    const params = new URLSearchParams({
      startHistoryId: cursor,
      historyTypes: "messageAdded",
      maxResults: "500",
    });
    let history: {
      history?: { messagesAdded?: { message?: { id?: string } }[] }[];
      historyId?: string;
    };
    try {
      history = await this.getJson(
        `${this.gmailBaseUrl}/users/me/history?${params.toString()}`,
        accessToken,
        "Gmail history list",
        options.signal,
      );
    } catch (error) {
      if (error instanceof MailboxProviderError && error.status === 404) {
        throw new MailboxProviderError("Gmail history cursor expired; full resync required", {
          status: 404,
          resetRequired: true,
          cause: error,
        });
      }
      throw error;
    }

    const ids = new Set<string>();
    for (const entry of history.history ?? []) {
      for (const added of entry.messagesAdded ?? []) {
        if (added.message?.id) ids.add(added.message.id);
      }
    }
    const messages = (
      await mapWithConcurrency([...ids], options.concurrency, (id) =>
        this.getMessageOrNull(accessToken, id, options.signal),
      )
    ).filter((message): message is RawMailMessage => message !== null);

    return {
      messages,
      cursor: history.historyId ?? cursor,
    };
  }

  async send(accessToken: string, message: OutgoingMail): Promise<SendReceipt> {
    const internetMessageId =
      normalizeMessageId(message.messageId ?? "") ??
      `<${randomUUID()}@${this.messageIdDomain}>`;
    const raw = buildMimeMessage(message, internetMessageId);
    const payload: Record<string, unknown> = {
      raw: Buffer.from(raw).toString("base64url"),
    };
    if (message.threadId) payload.threadId = message.threadId;

    const result = await this.postJson<{ id?: string; threadId?: string }>(
      `${this.gmailBaseUrl}/users/me/messages/send`,
      accessToken,
      payload,
      "Gmail send",
    );
    if (!result.id) {
      throw new MailboxProviderError("Gmail send returned no message id", {
        code: "invalid_response",
      });
    }
    return {
      providerMessageId: result.id,
      providerThreadId: result.threadId,
      internetMessageId,
      acceptedRecipients: [...message.to, ...(message.cc ?? []), ...(message.bcc ?? [])].map(
        (recipient) => recipient.address,
      ),
      rejectedRecipients: [],
    };
  }

  async fetchAttachment(
    accessToken: string,
    providerMessageId: string,
    providerAttachmentId: string,
  ): Promise<Buffer> {
    const data = await this.getJson<{ data?: string; size?: number }>(
      `${this.gmailBaseUrl}/users/me/messages/${encodeURIComponent(providerMessageId)}/attachments/${encodeURIComponent(providerAttachmentId)}`,
      accessToken,
      "Gmail attachment fetch",
    );
    if (!data.data) {
      throw new MailboxProviderError("Gmail attachment had no data", {
        code: "invalid_response",
      });
    }
    return decodeBase64Url(data.data);
  }

  private async getMessage(
    accessToken: string,
    id: string,
    signal?: AbortSignal,
  ): Promise<RawMailMessage> {
    const message = await this.getJson<GmailMessage>(
      `${this.gmailBaseUrl}/users/me/messages/${encodeURIComponent(id)}?format=full`,
      accessToken,
      "Gmail message fetch",
      signal,
    );
    return mapGmailMessage(message, id);
  }

  /** A message deleted between listing and fetching is not a sync failure. */
  private async getMessageOrNull(
    accessToken: string,
    id: string,
    signal?: AbortSignal,
  ): Promise<RawMailMessage | null> {
    try {
      return await this.getMessage(accessToken, id, signal);
    } catch (error) {
      if (error instanceof MailboxProviderError && error.status === 404) return null;
      throw error;
    }
  }

  private toTokenSet(response: TokenResponse): TokenSet {
    const scopes = (response.scope ?? "").split(/\s+/).filter(Boolean);
    return {
      accessToken: response.access_token!,
      refreshToken: response.refresh_token,
      expiresAt: new Date(Date.now() + (response.expires_in ?? 3600) * 1000),
      scopes: scopes.length > 0 ? scopes : [...this.scopes],
      idToken: response.id_token,
    };
  }

  private async postForm<T>(
    url: string,
    body: URLSearchParams,
    options: { reauthOnInvalidGrant?: boolean } = {},
  ): Promise<T> {
    const response = await this.request(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const json = (await safeJson(response)) as T & TokenResponse;
    if (!response.ok) {
      const invalidGrant = json.error === "invalid_grant";
      throw new MailboxProviderError("Google token endpoint rejected the request", {
        status: response.status,
        code: json.error ?? "token_request_failed",
        retryable: response.status === 429 || response.status >= 500,
        reauthRequired: Boolean(options.reauthOnInvalidGrant && invalidGrant),
      });
    }
    return json;
  }

  private async getJson<T>(
    url: string,
    accessToken: string,
    context: string,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.request(
      url,
      { method: "GET", headers: { authorization: `Bearer ${accessToken}` } },
      signal,
    );
    if (!response.ok) throw await this.failure(response, context);
    return (await safeJson(response)) as T;
  }

  private async postJson<T>(
    url: string,
    accessToken: string,
    body: unknown,
    context: string,
  ): Promise<T> {
    const response = await this.request(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw await this.failure(response, context);
    return (await safeJson(response)) as T;
  }

  private async failure(response: Response, context: string): Promise<MailboxProviderError> {
    const body = await safeJson(response).catch(() => ({}));
    const error = (
      body as {
        error?:
          | string
          | { message?: string; status?: string; errors?: { reason?: string }[] };
      }
    ).error;
    const code =
      typeof error === "string" ? error : (error?.status ?? error?.message ?? undefined);
    const reason = typeof error === "object" ? error?.errors?.[0]?.reason : undefined;
    const rateLimited =
      response.status === 429 ||
      response.status >= 500 ||
      /rateLimit|backendError|quota/i.test(reason ?? "");
    return new MailboxProviderError(`${context} failed with status ${response.status}`, {
      status: response.status,
      code: reason ?? code,
      retryable: rateLimited,
      reauthRequired:
        response.status === 401 ||
        (response.status === 403 && !rateLimited),
    });
  }

  private async request(
    url: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (error instanceof MailboxProviderError) throw error;
      throw new MailboxProviderError("Google request failed before a response", {
        retryable: true,
        cause: error,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

async function safeJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function headerValue(headers: GmailHeader[] | undefined, name: string): string | undefined {
  const lower = name.toLowerCase();
  const found = headers?.find((header) => header.name?.toLowerCase() === lower);
  return found?.value;
}

function mapGmailMessage(message: GmailMessage, fallbackId: string): RawMailMessage {
  const payload = message.payload;
  const headers = payload?.headers;
  const text = extractBodyPart(payload, "text/plain");
  const html = extractBodyPart(payload, "text/html");
  const from = parseAddress(decodeRfc2047(headerValue(headers, "from") ?? "")) ?? {
    address: "",
  };
  const subject = decodeRfc2047(headerValue(headers, "subject") ?? "");
  const internalDate = message.internalDate ? Number(message.internalDate) : undefined;
  const receivedAt =
    internalDate && Number.isFinite(internalDate) ? new Date(internalDate) : undefined;
  const dateHeader = headerValue(headers, "date");
  const parsedDate = dateHeader ? new Date(dateHeader) : undefined;
  const sentAt =
    parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate : receivedAt;

  return {
    providerMessageId: message.id ?? fallbackId,
    providerThreadId: message.threadId,
    internetMessageId: normalizeMessageId(headerValue(headers, "message-id") ?? ""),
    inReplyTo: normalizeMessageId(headerValue(headers, "in-reply-to") ?? ""),
    references: parseMessageIdList(headerValue(headers, "references")),
    from,
    to: parseAddressList(headerValue(headers, "to")),
    cc: parseAddressList(headerValue(headers, "cc")),
    bcc: parseAddressList(headerValue(headers, "bcc")),
    subject: subject || undefined,
    bodyHtml: html,
    bodyText: text,
    snippet: message.snippet,
    sentAt,
    receivedAt,
    isRead: !(message.labelIds ?? []).includes("UNREAD"),
    isBounce: from.address
      ? isBounceSender(from.address) || isBounceSubject(subject)
      : isBounceSubject(subject),
    attachments: extractAttachments(payload),
  };
}

function extractBodyPart(part: GmailPart | undefined, mimeType: string): string | undefined {
  if (!part) return undefined;
  if (part.mimeType === mimeType && part.body?.data && !part.body.attachmentId) {
    return decodeBase64Url(part.body.data).toString("utf8");
  }
  for (const child of part.parts ?? []) {
    const found = extractBodyPart(child, mimeType);
    if (found !== undefined) return found;
  }
  return undefined;
}

function extractAttachments(part: GmailPart | undefined): RawAttachmentRef[] {
  if (!part) return [];
  const result: RawAttachmentRef[] = [];
  const walk = (node: GmailPart) => {
    const attachmentId = node.body?.attachmentId;
    if (attachmentId && node.filename) {
      const contentId = headerValue(node.headers, "content-id") ?? undefined;
      const disposition = headerValue(node.headers, "content-disposition") ?? "";
      result.push({
        providerAttachmentId: attachmentId,
        filename: node.filename,
        mimeType: node.mimeType ?? "application/octet-stream",
        sizeBytes: node.body?.size,
        inline: /^\s*inline/i.test(disposition) || Boolean(contentId),
        contentId,
      });
    }
    for (const child of node.parts ?? []) walk(child);
  };
  walk(part);
  return result;
}

export function buildMimeMessage(message: OutgoingMail, messageId: string): string {
  const headers: string[] = [
    `From: ${formatAddressList([message.from])}`,
    `To: ${formatAddressList(message.to)}`,
  ];
  if (message.cc?.length) headers.push(`Cc: ${formatAddressList(message.cc)}`);
  if (message.bcc?.length) headers.push(`Bcc: ${formatAddressList(message.bcc)}`);
  headers.push(`Subject: ${encodeHeaderValue(message.subject)}`);
  headers.push(`Date: ${new Date().toUTCString()}`);
  headers.push(`Message-ID: ${sanitizeHeaderValue(messageId)}`);
  if (message.inReplyTo) headers.push(`In-Reply-To: ${sanitizeHeaderValue(message.inReplyTo)}`);
  if (message.references?.length) {
    headers.push(`References: ${message.references.map(sanitizeHeaderValue).join(" ")}`);
  }
  for (const [name, value] of Object.entries(message.headers ?? {})) {
    if (!/^[A-Za-z0-9-]+$/.test(name)) continue;
    headers.push(`${name}: ${sanitizeHeaderValue(value)}`);
  }
  headers.push("MIME-Version: 1.0");

  const body = buildMimeBody(message);
  return `${headers.join("\r\n")}\r\n${body}\r\n`;
}

function buildMimeBody(message: OutgoingMail): string {
  const alternative = message.html
    ? [
        'Content-Type: multipart/alternative; boundary="convo-alt"',
        "",
        "--convo-alt",
        mimeTextPart("text/plain", message.text),
        "--convo-alt",
        mimeTextPart("text/html", message.html),
        "--convo-alt--",
      ].join("\r\n")
    : mimeTextPart("text/plain", message.text);

  if (!message.attachments?.length) return alternative;

  const parts: string[] = ['Content-Type: multipart/mixed; boundary="convo-mixed"', ""];
  parts.push("--convo-mixed", alternative);
  for (const attachment of message.attachments) {
    const safeName = sanitizeHeaderValue(attachment.filename).replace(/"/g, "'");
    parts.push(
      "--convo-mixed",
      `Content-Type: ${sanitizeHeaderValue(attachment.mimeType)}; name="${safeName}"`,
      `Content-Disposition: attachment; filename="${safeName}"`,
      "Content-Transfer-Encoding: base64",
      "",
      wrapBase64(Buffer.from(attachment.content).toString("base64")),
    );
  }
  parts.push("--convo-mixed--");
  return parts.join("\r\n");
}

function mimeTextPart(contentType: string, content: string): string {
  return [
    `Content-Type: ${contentType}; charset=UTF-8`,
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(Buffer.from(content, "utf8").toString("base64")),
  ].join("\r\n");
}

function wrapBase64(value: string): string {
  const lines: string[] = [];
  for (let i = 0; i < value.length; i += 76) lines.push(value.slice(i, i + 76));
  return lines.join("\r\n");
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}
