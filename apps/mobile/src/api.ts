import type {
  Account,
  AttachmentInput,
  AuthResult,
  BlockedList,
  BlockRequest,
  BlockedUser,
  Challenge,
  ChatExportDocument,
  ChatLinkList,
  ChatPinList,
  CallList,
  CallMediaType,
  CallParticipantStateRequest,
  CallSummary,
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
  ReplyToStatusRequest,
  ReplyToStatusResult,
  ReplyMailRequest,
  ReportRequest,
  ReportResult,
  RevokeOtherSessionsResult,
  SendMailResult,
  SessionAuthResult,
  SessionInfo,
  SessionTokens,
  SharedContact,
  SharedMediaKind,
  StartCallResponse,
  StarredMessageList,
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

/** Mirrors the API's POST /media/upload response. */
export interface MediaUploadResult {
  storageKey: string;
  kind: "IMAGE" | "VIDEO" | "VOICE" | "DOCUMENT" | "OTHER";
  mimeType: string;
  sizeBytes: number;
  fileName: string | null;
  downloadUrl: string;
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
  async signInWith(result: SessionAuthResult): Promise<void> {
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
  updateProfile: (patch: UpdateProfileRequest) =>
    request<Account>("/me/profile", { method: "PATCH", body: patch, auth: true }),

  // ── Security (Phase 5C) ──

  /** Second leg of a two-step-verification login: one-time token + PIN. */
  verifyTwoFactor: (twoFactorToken: string, pin: string) =>
    request<SessionAuthResult>("/auth/2fa/verify", { method: "POST", body: { twoFactorToken, pin } }),
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
  ) => request<Message>(`/conversations/${conversationId}/messages`, { method: "POST", body, auth: true }),
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

  // ── Chat media (Phase 5B) ──
  forwardMessages: (messageIds: string[], conversationIds: string[]) =>
    request<ForwardMessagesResult>("/conversations/forward", {
      method: "POST",
      body: { messageIds, conversationIds },
      auth: true,
    }),
  sharedMedia: (conversationId: string, kind: SharedMediaKind = "ALL", cursor?: string, limit = 50) =>
    request<MessagePage>(`/conversations/${conversationId}/media${query({ cursor, limit, kind })}`, { auth: true }),
  openViewOnce: (messageId: string) =>
    request<ViewOnceOpenResult>(`/messages/${messageId}/view-once`, { method: "POST", body: {}, auth: true }),

  // ── GIF picker (Phase 5B extras) ──
  giphySearch: (q?: string, limit = 12) =>
    request<GiphyListResult>(`/giphy/search${query({ q, limit })}`, { auth: true }),
  giphyUpload: (giphyId: string) =>
    request<MediaUploadResult>("/giphy/upload", { method: "POST", body: { giphyId }, auth: true }),

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
  setEphemeral: (conversationId: string, seconds: number) =>
    request<ConversationSummary>(`/conversations/${conversationId}/ephemeral`, {
      method: "PATCH",
      body: { seconds },
      auth: true,
    }),
  exportChat: (conversationId: string, withMedia: boolean) =>
    request<ChatExportDocument>(
      `/conversations/${conversationId}/export${query({ includeMedia: withMedia ? "true" : undefined })}`,
      { auth: true },
    ),

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

  /** Base64 upload — React Native can't stream multipart camera assets. */
  uploadMediaBase64: (body: { data: string; mimeType: string; fileName?: string }) =>
    request<MediaUploadResult>("/media/upload", { method: "POST", body, auth: true }),

  // ── Group parity (Phase 5E) ──
  setMessagePinned: (messageId: string, pinned: boolean) =>
    request<Message>(`/messages/${messageId}/pin`, {
      method: pinned ? "PUT" : "DELETE",
      body: {},
      auth: true,
    }),
  pinnedMessages: (conversationId: string, cursor?: string, limit = 50) =>
    request<ChatPinList>(`/conversations/${conversationId}/pins${query({ cursor, limit })}`, { auth: true }),
  chatLinks: (conversationId: string, cursor?: string, limit = 50) =>
    request<ChatLinkList>(`/conversations/${conversationId}/links${query({ cursor, limit })}`, { auth: true }),

  // ── Calling (Phase 5F) ──
  /** Dial: returns the ringing record plus the ICE config to negotiate with. */
  startCall: (conversationId: string, mediaType: CallMediaType) =>
    request<StartCallResponse>("/calls", { method: "POST", body: { conversationId, mediaType }, auth: true }),
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
 * Server media URLs are built from APP_URL, which points at localhost in dev —
 * unreachable from a device/emulator. Rebase them onto the API host the app
 * actually talks to, keeping the signed token query intact.
 */
export function resolveMediaUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const media = new URL(url);
    if (media.hostname !== "localhost" && media.hostname !== "127.0.0.1") return url;
    const base = new URL(API_BASE);
    return `${base.origin}${media.pathname}${media.search}`;
  } catch {
    return url;
  }
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
