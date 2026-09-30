import type {
  Account,
  AddGroupMembersRequest,
  Attachment,
  AttachmentInput,
  AuthResult,
  BlockedList,
  BlockRequest,
  BlockedUser,
  CallList,
  CallMediaType,
  CallParticipantStateRequest,
  CallSummary,
  Challenge,
  ChatExportDocument,
  ChatLinkList,
  ChatPinList,
  ComposeMailRequest,
  Contact,
  ContactList,
  ConversationList,
  ConversationSummary,
  CreateGroupRequest,
  CreateStatusRequest,
  DeleteAccountResult,
  DeviceInfo,
  ForwardMessagesResult,
  GiphyListResult,
  GlobalSearchResult,
  GroupDetail,
  GroupList,
  IceConfig,
  MailMessagePage,
  MailThreadList,
  Message,
  MessageLocation,
  MessagePage,
  MissedCallCount,
  RecentRecipientList,
  RegisterDeviceRequest,
  ReplyMailRequest,
  ReplyToStatusRequest,
  ReplyToStatusResult,
  ReportRequest,
  ReportResult,
  RevokeOtherSessionsResult,
  SendMailResult,
  SessionAuthResult,
  SessionInfo,
  SessionTokens,
  SharedContact,
  SharedMediaKind,
  StarredMessageList,
  StartCallResponse,
  StatusItem,
  StatusList,
  StatusMuteList,
  StatusViewer,
  TwoFactorStatus,
  UpdateConversationRequest,
  UpdateGroupRequest,
  UpdateProfileRequest,
  UpsertContactRequest,
  UserCard,
  ViewOnceOpenResult,
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

  // ── Security (Phase 5C) ──

  /** Second leg of a two-step-verification login: one-time token + PIN. */
  verifyTwoFactor: (twoFactorToken: string, pin: string) =>
    request<SessionAuthResult>("/auth/2fa/verify", {
      method: "POST",
      body: { twoFactorToken, pin },
    }),
  twoFactorStatus: () => request<TwoFactorStatus>("/me/two-factor", { auth: true }),
  setTwoFactor: (pin: string) =>
    request<TwoFactorStatus>("/me/two-factor", { method: "PUT", body: { pin }, auth: true }),
  disableTwoFactor: () =>
    request<TwoFactorStatus>("/me/two-factor", { method: "DELETE", auth: true }),
  listSessions: () => request<SessionInfo[]>("/me/sessions", { auth: true }),
  revokeSession: (id: string) =>
    request<{ ok: true }>(`/me/sessions/${id}`, { method: "DELETE", auth: true }),
  revokeOtherSessions: () =>
    request<RevokeOtherSessionsResult>("/me/sessions/revoke-others", { method: "POST", body: {}, auth: true }),
  listDevices: () => request<DeviceInfo[]>("/me/devices", { auth: true }),
  registerDevice: (body: RegisterDeviceRequest) =>
    request<DeviceInfo>("/me/devices", { method: "POST", body, auth: true }),
  deleteDevice: (id: string) =>
    request<{ ok: true }>(`/me/devices/${id}`, { method: "DELETE", auth: true }),
  requestAccountDeletion: () =>
    request<DeleteAccountResult>("/me/delete-account", { method: "POST", body: {}, auth: true }),
  cancelAccountDeletion: () =>
    request<{ ok: true }>("/me/delete-account", { method: "DELETE", auth: true }),

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
  listMessages: (
    conversationId: string,
    cursor?: string,
    limit = 50,
    filters: { q?: string; starred?: boolean } = {},
  ) =>
    request<MessagePage>(
      `/conversations/${conversationId}/messages${query({
        cursor,
        limit,
        q: filters.q,
        starred: filters.starred ? "true" : undefined,
      })}`,
      { auth: true },
    ),
  sendMessage: (
    conversationId: string,
    body: {
      clientMessageId: string;
      body?: string;
      replyToId?: string;
      attachments?: AttachmentInput[];
      viewOnce?: boolean;
      location?: MessageLocation;
      contactCard?: SharedContact;
      sticker?: boolean;
    },
  ) =>
    request<Message>(`/conversations/${conversationId}/messages`, { method: "POST", body, auth: true }),
  markRead: (conversationId: string, messageId?: string) =>
    request<{ ok: true }>(`/conversations/${conversationId}/read`, { method: "POST", body: { messageId }, auth: true }),

  editMessage: (messageId: string, body: string) =>
    request<Message>(`/messages/${messageId}`, { method: "PATCH", body: { body }, auth: true }),
  deleteMessage: (messageId: string, scope: "MINE" | "EVERYONE") =>
    request<{ ok: true }>(`/messages/${messageId}`, { method: "DELETE", body: { scope }, auth: true }),
  reactMessage: (messageId: string, emoji: string) =>
    request<Message>(`/messages/${messageId}/reactions`, { method: "PUT", body: { emoji }, auth: true }),
  removeReaction: (messageId: string, emoji: string) =>
    request<Message>(`/messages/${messageId}/reactions${query({ emoji })}`, { method: "DELETE", auth: true }),

  // ── Chat controls (Phase 5A) ──
  updateConversation: (id: string, body: UpdateConversationRequest) =>
    request<ConversationSummary>(`/conversations/${id}`, { method: "PATCH", body, auth: true }),
  listArchived: (cursor?: string, limit = 50) =>
    request<ConversationList>(`/conversations${query({ cursor, limit, archived: "true" })}`, { auth: true }),
  clearConversation: (id: string) =>
    request<ConversationSummary>(`/conversations/${id}/clear`, { method: "POST", body: {}, auth: true }),
  deleteConversation: (id: string) =>
    request<{ ok: true }>(`/conversations/${id}`, { method: "DELETE", auth: true }),
  starMessage: (messageId: string, starred: boolean) =>
    request<Message>(`/messages/${messageId}/star`, { method: "PUT", body: { starred }, auth: true }),
  listStarred: (cursor?: string, limit = 50) =>
    request<StarredMessageList>(`/starred${query({ cursor, limit })}`, { auth: true }),

  // ── Chat media (Phase 5B) ──

  /** Reference the same stored bytes in every destination chat. */
  forwardMessages: (messageIds: string[], conversationIds: string[]) =>
    request<ForwardMessagesResult>("/conversations/forward", {
      method: "POST",
      body: { messageIds, conversationIds },
      auth: true,
    }),
  sharedMedia: (conversationId: string, kind: SharedMediaKind = "ALL", cursor?: string, limit = 50) =>
    request<MessagePage>(
      `/conversations/${conversationId}/media${query({ cursor, limit, kind })}`,
      { auth: true },
    ),
  /** Spend the single view: returns the media URLs exactly once. */
  openViewOnce: (messageId: string) =>
    request<ViewOnceOpenResult>(`/messages/${messageId}/view-once`, { method: "POST", body: {}, auth: true }),

  // ── Group parity (Phase 5E): pins, links tab ──

  /** Pin / unpin for the whole chat; the response is the refreshed message. */
  setMessagePinned: (messageId: string, pinned: boolean) =>
    request<Message>(`/messages/${messageId}/pin`, {
      method: pinned ? "PUT" : "DELETE",
      body: {},
      auth: true,
    }),
  pinnedMessages: (conversationId: string, cursor?: string, limit = 50) =>
    request<ChatPinList>(
      `/conversations/${conversationId}/pins${query({ cursor, limit })}`,
      { auth: true },
    ),
  /** The chat's "Links" tab, straight from the stored scrape cards. */
  chatLinks: (conversationId: string, cursor?: string, limit = 50) =>
    request<ChatLinkList>(
      `/conversations/${conversationId}/links${query({ cursor, limit })}`,
      { auth: true },
    ),

  // ── Calling (Phase 5F) ──

  /** Dial: returns the ringing record plus the ICE config to negotiate with. */
  startCall: (conversationId: string, mediaType: CallMediaType) =>
    request<StartCallResponse>("/calls", {
      method: "POST",
      body: { conversationId, mediaType },
      auth: true,
    }),
  /** The callee needs its own TURN credential — secrets never ride the socket. */
  callIceConfig: () => request<IceConfig>("/calls/ice-config", { auth: true }),
  callHistory: (filters: { conversationId?: string; cursor?: string; limit?: number; missedOnly?: boolean } = {}) =>
    request<CallList>(
      `/calls${query({
        conversationId: filters.conversationId,
        cursor: filters.cursor,
        limit: filters.limit ?? 50,
        missedOnly: filters.missedOnly ? "true" : undefined,
      })}`,
      { auth: true },
    ),
  missedCallCount: () => request<MissedCallCount>("/calls/missed-count", { auth: true }),
  acceptCall: (callId: string) =>
    request<CallSummary>(`/calls/${callId}/accept`, { method: "POST", body: {}, auth: true }),
  declineCall: (callId: string, reason: "DECLINED" | "BUSY") =>
    request<CallSummary>(`/calls/${callId}/decline`, { method: "POST", body: { reason }, auth: true }),
  /** One verb for "I'm done": cancels a ring, declines a call, ends a live one. */
  hangUpCall: (callId: string) =>
    request<CallSummary>(`/calls/${callId}/hang-up`, { method: "POST", body: {}, auth: true }),
  setCallState: (callId: string, body: CallParticipantStateRequest) =>
    request<CallSummary>(`/calls/${callId}/me`, { method: "PATCH", body, auth: true }),

  // ── Privacy + security (Phase 5C) ──

  /** Disappearing-messages timer for a 1-1 chat (0 = off). */
  setEphemeral: (conversationId: string, seconds: number) =>
    request<ConversationSummary>(`/conversations/${conversationId}/ephemeral`, {
      method: "PATCH",
      body: { seconds },
      auth: true,
    }),
  /** The viewer's own transcript as JSON; withMedia signs every attachment. */
  exportChat: (conversationId: string, withMedia: boolean) =>
    request<ChatExportDocument>(
      `/conversations/${conversationId}/export${query({ includeMedia: withMedia ? "true" : undefined })}`,
      { auth: true },
    ),

  // ── GIF picker (Phase 5B extras): server-side proxy, key never reaches us ──
  giphySearch: (q?: string, limit = 12) =>
    request<GiphyListResult>(`/giphy/search${query({ q, limit })}`, { auth: true }),
  /** Downloads the GIF into our own storage; the result is a normal upload. */
  giphyUpload: (giphyId: string) =>
    request<MediaUploadResult>("/giphy/upload", { method: "POST", body: { giphyId }, auth: true }),

  // ── Contacts, safety, search (Phase 5A) ──
  listContacts: () => request<ContactList>("/contacts", { auth: true }),
  recentRecipients: () => request<RecentRecipientList>("/contacts/recent", { auth: true }),
  saveContact: (body: UpsertContactRequest) =>
    request<Contact>("/contacts", { method: "POST", body, auth: true }),
  deleteContact: (id: string) =>
    request<{ ok: true }>(`/contacts/${id}`, { method: "DELETE", auth: true }),
  userCard: (userId: string) => request<UserCard>(`/users/${userId}`, { auth: true }),
  listBlocked: () => request<BlockedList>("/blocks", { auth: true }),
  blockUser: (body: BlockRequest) =>
    request<BlockedUser>("/blocks", { method: "POST", body, auth: true }),
  unblockUser: (userId: string) =>
    request<{ ok: true }>(`/blocks/${userId}`, { method: "DELETE", auth: true }),
  report: (body: ReportRequest) =>
    request<ReportResult>("/reports", { method: "POST", body, auth: true }),
  search: (q: string, limit = 10) =>
    request<GlobalSearchResult>(`/search${query({ q, limit })}`, { auth: true }),

  listMailThreads: (cursor?: string, limit = 50) =>
    request<MailThreadList>(`/mail/threads${query({ cursor, limit })}`, { auth: true }),
  listMailMessages: (threadId: string, cursor?: string, limit = 50) =>
    request<MailMessagePage>(`/mail/threads/${threadId}/messages${query({ cursor, limit })}`, { auth: true }),
  composeMail: (body: ComposeMailRequest) =>
    request<SendMailResult>("/mail/send", { method: "POST", body, auth: true }),
  replyMail: (threadId: string, body: ReplyMailRequest) =>
    request<SendMailResult>(`/mail/threads/${threadId}/reply`, { method: "POST", body, auth: true }),
  markThreadRead: (threadId: string) =>
    request<{ ok: true }>(`/mail/threads/${threadId}/read`, { method: "POST", body: {}, auth: true }),

  // ── Groups (Phase 4B) ──
  createGroup: (body: CreateGroupRequest) =>
    request<GroupDetail>("/groups", { method: "POST", body, auth: true }),
  listGroups: (cursor?: string, limit = 50) =>
    request<GroupList>(`/groups${query({ cursor, limit })}`, { auth: true }),
  group: (id: string) => request<GroupDetail>(`/groups/${id}`, { auth: true }),
  updateGroup: (id: string, body: UpdateGroupRequest) =>
    request<GroupDetail>(`/groups/${id}`, { method: "PATCH", body, auth: true }),
  deleteGroup: (id: string) =>
    request<{ ok: true }>(`/groups/${id}`, { method: "DELETE", auth: true }),
  addGroupMembers: (id: string, phones: string[]) =>
    request<GroupDetail>(`/groups/${id}/members`, { method: "POST", body: { phones }, auth: true }),
  removeGroupMember: (id: string, userId: string) =>
    request<GroupDetail>(`/groups/${id}/members`, { method: "DELETE", body: { userId }, auth: true }),
  leaveGroup: (id: string) =>
    request<{ ok: true }>(`/groups/${id}/leave`, { method: "POST", body: {}, auth: true }),
  promoteMember: (id: string, userId: string) =>
    request<GroupDetail>(`/groups/${id}/admins`, { method: "PUT", body: { userId }, auth: true }),
  demoteMember: (id: string, userId: string) =>
    request<GroupDetail>(`/groups/${id}/admins${query({ userId })}`, { method: "DELETE", auth: true }),
  joinRequests: (id: string) =>
    request<{ requests: GroupDetail["joinRequests"] }>(`/groups/${id}/requests`, { auth: true }),
  approveJoinRequest: (id: string, userId: string) =>
    request<GroupDetail>(`/groups/${id}/requests/approve`, { method: "POST", body: { userId }, auth: true }),
  rejectJoinRequest: (id: string, userId: string) =>
    request<GroupDetail>(`/groups/${id}/requests/reject`, { method: "POST", body: { userId }, auth: true }),
  applyToGroup: (id: string) =>
    request<{ pending: boolean }>(`/groups/${id}/apply`, { method: "POST", body: {}, auth: true }),
  joinByCode: (code: string) =>
    request<GroupDetail>(`/groups/join/${code}`, { auth: true }),
  discoverGroups: (q: string) =>
    request<{ groups: GroupList["groups"] }>(`/groups/discover${query({ q })}`, { auth: true }),
  revokeInvite: (id: string) =>
    request<GroupDetail>(`/groups/${id}/invite/revoke`, { method: "POST", body: {}, auth: true }),

  // ── Status (Phase 4B) ──
  listStatuses: () => request<StatusList>("/statuses", { auth: true }),
  postStatus: (body: CreateStatusRequest) =>
    request<StatusItem>("/statuses", { method: "POST", body, auth: true }),
  deleteStatus: (id: string) =>
    request<{ ok: true }>(`/statuses/${id}`, { method: "DELETE", auth: true }),
  markStatusViewed: (id: string) =>
    request<{ ok: true }>(`/statuses/${id}/viewed`, { method: "POST", body: {}, auth: true }),
  statusViewers: (id: string) =>
    request<{ viewers: StatusViewer[] }>(`/statuses/${id}/viewers`, { auth: true }),

  // ── Status parity (Phase 5D) ──
  replyToStatus: (id: string, body: ReplyToStatusRequest) =>
    request<ReplyToStatusResult>(`/statuses/${id}/reply`, { method: "POST", body, auth: true }),
  listStatusMutes: () => request<StatusMuteList>("/statuses/muted", { auth: true }),
  muteStatusAuthor: (authorId: string) =>
    request<{ ok: true }>(`/statuses/mute/${authorId}`, { method: "PUT", body: {}, auth: true }),
  unmuteStatusAuthor: (authorId: string) =>
    request<{ ok: true }>(`/statuses/mute/${authorId}`, { method: "DELETE", auth: true }),

  uploadMedia: (file: File) => uploadMedia(file),
};

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

export interface MediaUploadResult {
  storageKey: string;
  kind: string;
  mimeType: string;
  sizeBytes: number;
  fileName: string | null;
  downloadUrl: string;
}

async function uploadMedia(file: File): Promise<MediaUploadResult> {
  const session = loadSession();
  const form = new FormData();
  form.append("file", file);
  const doIt = () =>
    fetch(`${API_BASE}/media/upload`, {
      method: "POST",
      headers: session ? { Authorization: `Bearer ${session.accessToken}` } : undefined,
      body: form,
    });
  let res = await doIt();
  if (res.status === 401 && (await tryRefresh())) res = await doIt();
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new ApiRequestError(res.status, "UPLOAD_FAILED", body?.error?.message ?? "Upload failed");
  }
  return (await res.json()) as MediaUploadResult;
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
