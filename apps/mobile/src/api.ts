import type {
  Account,
  AuthResult,
  Challenge,
  ConversationList,
  ConversationSummary,
  Message,
  MessagePage,
  SessionTokens,
} from "@convo/shared";
import { API_BASE, clearStoredSession, loadStoredSession, storeSession, type StoredSession } from "./storage";

let currentSession: StoredSession | null = null;

export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function hydrateSession(): Promise<StoredSession | null> {
  currentSession = await loadStoredSession();
  return currentSession;
}

let refreshInFlight: Promise<boolean> | null = null;

export async function tryRefresh(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      if (!currentSession) return false;
      try {
        const res = await fetch(`${API_BASE}/auth/refresh`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken: currentSession.refreshToken }),
        });
        if (!res.ok) return false;
        currentSession = await storeSession((await res.json()) as SessionTokens);
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
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.auth && currentSession) headers.Authorization = `Bearer ${currentSession.accessToken}`;

  const doFetch = () =>
    fetch(`${API_BASE}${path}`, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

  let res = await doFetch();
  if (res.status === 401 && opts.auth && (await tryRefresh())) {
    if (currentSession) headers.Authorization = `Bearer ${currentSession.accessToken}`;
    res = await doFetch();
  }

  if (!res.ok) {
    let code = "HTTP_ERROR";
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      code = body.error?.code ?? code;
      message = body.error?.message ?? message;
    } catch {
      // non-JSON error body
    }
    throw new ApiRequestError(res.status, code, message);
  }
  return (await res.json()) as T;
}

export const api = {
  async signInWith(result: AuthResult): Promise<void> {
    currentSession = await storeSession(result.session);
  },
  async signOut(): Promise<void> {
    if (currentSession) {
      try {
        await request("/auth/logout", {
          method: "POST",
          body: { refreshToken: currentSession.refreshToken },
        });
      } catch {
        // best effort
      }
    }
    currentSession = null;
    await clearStoredSession();
  },

  requestPhoneOtp: (phone: string) =>
    request<Challenge>("/auth/phone/request-otp", { method: "POST", body: { phone } }),
  verifyPhoneOtp: (challengeId: string, code: string) =>
    request<AuthResult>("/auth/phone/verify-otp", { method: "POST", body: { challengeId, code } }),
  requestEmailOtp: (email: string) =>
    request<Challenge>("/auth/email/request-otp", { method: "POST", body: { email } }),
  verifyEmailOtp: (challengeId: string, code: string) =>
    request<AuthResult>("/auth/email/verify-otp", { method: "POST", body: { challengeId, code } }),

  me: () => request<Account>("/me", { auth: true }),

  updateProfileMobile: (displayName: string | null) =>
    request<Account>("/me/profile", { method: "PATCH", body: { displayName }, auth: true }),

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

/** Access token for the current in-memory session, or null. */
export function currentAccessToken(): string | null {
  return currentSession?.accessToken ?? null;
}

/**
 * WebSocket URL for the realtime gateway. API_BASE is always absolute on mobile,
 * so http(s) maps directly to ws(s).
 */
export function realtimeUrl(): string {
  const token = currentAccessToken();
  if (!token) return "";
  return `${API_BASE.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(token)}`;
}
