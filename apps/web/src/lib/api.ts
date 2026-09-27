import type {
  Account,
  AuthResult,
  Challenge,
  ConversationList,
  ConversationSummary,
  Message,
  MessagePage,
  SessionTokens,
  UpdateProfileRequest,
} from "@convo/shared";

const API_BASE = import.meta.env.VITE_API_URL ?? "/api";

interface StoredSession extends SessionTokens {
  expiresAt: number;
}

const STORAGE_KEY = "convo.session";

export function loadSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredSession) : null;
  } catch {
    return null;
  }
}

export function saveSession(tokens: SessionTokens): StoredSession {
  const stored: StoredSession = {
    ...tokens,
    expiresAt: Date.now() + tokens.accessExpiresInSeconds * 1000,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  return stored;
}

export function clearSession(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

let refreshInFlight: Promise<boolean> | null = null;

export async function tryRefresh(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const session = loadSession();
      if (!session) return false;
      try {
        const res = await fetch(`${API_BASE}/auth/refresh`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken: session.refreshToken }),
        });
        if (!res.ok) return false;
        saveSession((await res.json()) as SessionTokens);
        return true;
      } catch {
        return false;
      }
    })().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

async function request<T>(
  path: string,
  opts: { method?: string; body?: unknown; auth?: boolean } = {},
): Promise<T> {
  const session = loadSession();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.auth && session) headers.Authorization = `Bearer ${session.accessToken}`;

  const doFetch = () =>
    fetch(`${API_BASE}${path}`, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

  let res = await doFetch();
  if (res.status === 401 && opts.auth && (await tryRefresh())) {
    const refreshed = loadSession();
    if (refreshed) headers.Authorization = `Bearer ${refreshed.accessToken}`;
    res = await doFetch();
  }

  if (!res.ok) {
    let code = "HTTP_ERROR";
    let message = `Request failed (${res.status})`;
    let details: unknown;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string; details?: unknown } };
      code = body.error?.code ?? code;
      message = body.error?.message ?? message;
      details = body.error?.details;
    } catch {
      // non-JSON error body
    }
    throw new ApiRequestError(res.status, code, message, details);
  }
  return (await res.json()) as T;
}

export const api = {
  requestPhoneOtp: (phone: string) =>
    request<Challenge>("/auth/phone/request-otp", { method: "POST", body: { phone } }),
  verifyPhoneOtp: (challengeId: string, code: string) =>
    request<AuthResult>("/auth/phone/verify-otp", { method: "POST", body: { challengeId, code } }),
  requestEmailOtp: (email: string) =>
    request<Challenge>("/auth/email/request-otp", { method: "POST", body: { email } }),
  verifyEmailOtp: (challengeId: string, code: string) =>
    request<AuthResult>("/auth/email/verify-otp", { method: "POST", body: { challengeId, code } }),
  logout: (refreshToken: string) =>
    request<{ ok: true }>("/auth/logout", { method: "POST", body: { refreshToken } }),

  me: () => request<Account>("/me", { auth: true }),
  updateProfile: (patch: UpdateProfileRequest) =>
    request<Account>("/me/profile", { method: "PATCH", body: patch, auth: true }),

  connectEmailRequest: (email: string) =>
    request<Challenge>("/identities/email/request-otp", { method: "POST", body: { email }, auth: true }),
  connectEmailVerify: (challengeId: string, code: string) =>
    request<Account>("/identities/email/verify-otp", { method: "POST", body: { challengeId, code }, auth: true }),
  connectPhoneRequest: (phone: string) =>
    request<Challenge>("/identities/phone/request-otp", { method: "POST", body: { phone }, auth: true }),
  connectPhoneVerify: (challengeId: string, code: string) =>
    request<Account>("/identities/phone/verify-otp", { method: "POST", body: { challengeId, code }, auth: true }),

  startConversation: (phone: string) =>
    request<ConversationSummary>("/conversations/start", { method: "POST", body: { phone }, auth: true }),
  listConversations: (cursor?: string, limit = 50) =>
    request<ConversationList>(`/conversations${query({ cursor, limit })}`, { auth: true }),
  listMessages: (conversationId: string, cursor?: string, limit = 50) =>
    request<MessagePage>(`/conversations/${conversationId}/messages${query({ cursor, limit })}`, { auth: true }),
  sendMessage: (conversationId: string, body: { clientMessageId: string; body: string; replyToId?: string }) =>
    request<Message>(`/conversations/${conversationId}/messages`, { method: "POST", body, auth: true }),
  markRead: (conversationId: string, messageId?: string) =>
    request<{ ok: true }>(`/conversations/${conversationId}/read`, { method: "POST", body: { messageId }, auth: true }),
};

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

/** Absolute access token for the current session, or null. */
export function currentAccessToken(): string | null {
  return loadSession()?.accessToken ?? null;
}

/**
 * WebSocket URL for the realtime gateway, derived from API_BASE so it works
 * through the Vite dev proxy (relative "/api") and in production (absolute).
 */
export function realtimeUrl(): string {
  const token = currentAccessToken();
  if (!token) return "";
  const path = `/ws?token=${encodeURIComponent(token)}`;
  if (API_BASE.startsWith("http")) {
    return API_BASE.replace(/^http/, "ws") + path;
  }
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const base = API_BASE.replace(/^\//, "");
  return `${proto}//${window.location.host}/${base}${path}`;
}
