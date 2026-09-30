# Convo API Reference (v1.0 — Phase 5F: voice & video calling — WebRTC signaling, call log, ICE configs)

Base URL: `http://localhost:4000` (web dev proxy: `/api`).

All request/response bodies are JSON. Errors share one shape:

```json
{ "error": { "code": "OTP_INVALID", "message": "Incorrect code", "details": null } }
```

Error codes: `VALIDATION_ERROR` (400), `UNAUTHORIZED` (401), `FORBIDDEN` (403),
`NOT_FOUND` (404), `CONFLICT` (409), `RATE_LIMITED` (429), `OTP_INVALID`,
`OTP_EXPIRED`, `OTP_ATTEMPTS_EXCEEDED`, `CHALLENGE_NOT_FOUND`,
`IDENTITY_ALREADY_LINKED_TO_THIS_ACCOUNT`, `IDENTITY_LINKED_TO_ANOTHER_ACCOUNT`,
`INTERNAL_ERROR` (500).

## Objects

### Account

```json
{
  "id": "clx...",
  "displayName": "Alice Verma",
  "avatarUrl": null,
  "bio": null,
  "phone": { "phone": "+919800000001", "verifiedAt": "2026-09-26T12:00:00.000Z" },
  "email": { "email": "alice@example.com", "verifiedAt": "2026-09-26T12:00:00.000Z" },
  "capabilities": { "chats": true, "mail": true },
  "presenceVisibility": "EVERYONE",
  "mediaAutoDownload": "ALWAYS",
  "createdAt": "2026-09-26T12:00:00.000Z"
}
```

`phone`/`email` are `null` until the identity is connected and verified.
`capabilities.chats` requires a phone identity; `capabilities.mail` requires an
email identity. `presenceVisibility` is `EVERYONE` | `CONTACTS` | `NONE` and
controls who may read your last-seen timestamp (spec §34).
`mediaAutoDownload` is `ALWAYS` | `WIFI_ONLY` — a client-side hint: with
`WIFI_ONLY` the UI defers heavy video/voice downloads until the device is on
Wi-Fi; the server always returns signed URLs either way.

### Challenge

```json
{ "challengeId": "clx...", "expiresInSeconds": 600, "devOtp": "123456" }
```

`devOtp` is present **only** when the server runs with `DEV_EXPOSE_OTP=true`.

### SessionTokens

```json
{ "accessToken": "jwt...", "refreshToken": "opaque...", "accessExpiresInSeconds": 900 }
```

## Health

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | – | Liveness probe. |

## Authentication (flows A–D, spec §33)

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/auth/phone/request-otp` | `{ phone: "+919800000001" }` | `Challenge` |
| POST | `/auth/phone/verify-otp` | `{ challengeId, code }` | `AuthResult` |
| POST | `/auth/email/request-otp` | `{ email: "you@example.com" }` | `Challenge` |
| POST | `/auth/email/verify-otp` | `{ challengeId, code }` | `AuthResult` |
| POST | `/auth/refresh` | `{ refreshToken }` | `SessionTokens` |
| POST | `/auth/logout` | `{ refreshToken }` | `{ ok: true }` |
| POST | `/auth/2fa/verify` | `{ twoFactorToken, pin }` | session branch of `AuthResult` |

`AuthResult` is a union: either
`{ session: SessionTokens, account: Account, isNewAccount: boolean }` or, when
the account has a login PIN, `{ twoFactorRequired: true, twoFactorToken, expiresInSeconds }`
(see [Two-step verification at login](#privacy--security-phase-5c-spec-34)).
Clients store a session only from the first branch — `SessionAuthResult` is the
exported type for it.

Semantics:
- `request-otp` creates or restores — the same endpoint serves new signups and
  existing logins; an account is created on first successful verification.
- Phone numbers must be E.164 (`+` prefix). Emails are normalized to lowercase.
- Rate limits: request-otp 5/min/IP, verify-otp 10/min/IP, plus per-target
  resend cooldown (60s) and per-challenge attempt cap (5).
- `refresh` rotates: the presented refresh token is revoked and replaced.

Authenticated requests use `Authorization: Bearer <accessToken>`.

## Identity linking (flow E, spec §4–5)

Requires a valid access token. Connects a second identity to the CURRENT
account. Never creates or merges accounts.

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/identities/email/request-otp` | `{ email }` | `Challenge` |
| POST | `/identities/email/verify-otp` | `{ challengeId, code }` | `Account` |
| POST | `/identities/phone/request-otp` | `{ phone }` | `Challenge` |
| POST | `/identities/phone/verify-otp` | `{ challengeId, code }` | `Account` |

Conflict rules:
- Target already linked to **this** account → 409 `IDENTITY_ALREADY_LINKED_TO_THIS_ACCOUNT`.
- Account already has a different identity of that type → 409 (one of each max).
- Target linked to **another** account → 409 `IDENTITY_LINKED_TO_ANOTHER_ACCOUNT`
  with a non-enumerating message. The user must sign in to that account first;
  no automatic merge exists by design.

## Profile

| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| GET | `/me` | ✓ | – | `Account` |
| PATCH | `/me/profile` | ✓ | `{ displayName?, avatarUrl?, bio?, presenceVisibility?, mediaAutoDownload? }` (null clears the first three; `mediaAutoDownload` is `ALWAYS`\|`WIFI_ONLY`) plus the Phase 5C privacy fields below | `Account` |

Phase 5C privacy fields on `PATCH /me/profile` (all optional; the account
always echoes the stored result):

| Field | Shape | Notes |
|---|---|---|
| `avatarVisibility` / `aboutVisibility` / `onlineVisibility` | `EVERYONE` \| `CONTACTS` \| `CONTACTS_EXCEPT` \| `NONE` | per-field profile privacy |
| `visibilityExcluded` | `string[]` of userIds (max 500) | who is hidden under `CONTACTS_EXCEPT` |
| `groupAddVisibility` | `EVERYONE` \| `CONTACTS` \| `NOBODY` | who may add you to a group |
| `readReceiptsEnabled` | boolean | off hides blue ticks both ways |
| `defaultEphemeralSeconds` | int 0…90 days | default timer for new 1-1 chats |
| `appLock` | `{ enabled, biometric, timeoutSeconds, pinHash, salt }` \| null | mirror of the client's own lock; the web app hashes its PIN locally, so the raw lock PIN never reaches the server |

## Chats (Phase 2, spec §9/§22/§23)

Requires a valid access token **and** a connected phone identity
(`capabilities.chats`). Requests from an account without a phone identity return
403 with "Connect a phone number to start using Chats".

Sending always goes over HTTP so the client can retry safely: the client-generated
`clientMessageId` (a UUID) makes a retry return the original message instead of
creating a duplicate. The WebSocket is downstream-only (plus typing/read signals),
so a dropped connection can never duplicate or lose a message.

### Objects

```jsonc
// ConversationPeer — `lastSeenAt` is populated only when the peer's
// presenceVisibility permits the viewer (EVERYONE always; CONTACTS only if the
// peer has saved the viewer; NONE never).
{ "userId": "clx...", "displayName": "Alice", "avatarUrl": null, "phone": "+919800000001", "lastSeenAt": "2026-09-29T10:30:00.000Z" }

// MessageReaction — per-emoji tally with a per-viewer own-reaction flag
{ "emoji": "👍", "count": 2, "reactedByMe": true }

// Message
{
  "id": "clx...", "conversationId": "clx...", "senderId": "clx...",
  "clientMessageId": "uuid", "type": "TEXT", "body": "Hi",
  "replyToId": null, "editedAt": null, "deletedAt": null,
  "reactions": [ /* MessageReaction */ ],
  "deliveryStatus": "READ",  // SENT | DELIVERED | READ — only on your OWN messages, else null
  "starredByMe": false,      // per-viewer bookmark (Phase 5A)
  "mentions": ["clx..."],    // roster ids resolved server-side (Phase 5E)
  "mentionedMe": false,      // the caller is one of them (per-viewer)
  "pinned": null,            // { userId, displayName, pinnedAt } — shared, 5E
  "createdAt": "2026-09-26T12:00:00.000Z"
}

// ConversationSummary
{
  "id": "clx...", "type": "DIRECT", "title": null,
  "peer": { /* ConversationPeer */ }, "lastMessage": { /* Message */ },
  "unreadCount": 2, "unreadMentions": 0,   // mentions past the read watermark (5E)
  "pinned": false, "archived": false, "mutedUntil": null,
  "lastReadAt": "2026-09-26T12:00:00.000Z",
  "lastMessageAt": "2026-09-26T12:05:00.000Z"
}
```

`pinned`, `archived` and `mutedUntil` are the Phase 5A per-viewer chat controls;
`group` (member count, `myRole`, announce-only, who can send) is populated only
for `GROUP` conversations.

A message deleted **for everyone** keeps its row but clears `body` and sets
`deletedAt` (clients render "Message deleted"). A message deleted **for me**
adds a `MessageHidden` row so it simply disappears from that one viewer's
timelines and previews while remaining for everyone else.

### REST endpoints

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| POST | `/conversations/start` | `{ phone }` (E.164) | `ConversationSummary` |
| GET | `/conversations` | `?cursor?&limit=50` (1–100) | `{ conversations: [...], nextCursor }` |
| GET | `/conversations/:id/messages` | `?cursor?&limit=50` | `{ messages: [...], nextCursor }` (oldest-first page) |
| POST | `/conversations/:id/messages` | `{ clientMessageId, body?, replyToId?, attachments?, viewOnce? }` | `Message` |
| POST | `/conversations/:id/read` | `{ messageId? }` (defaults to latest) | `{ ok: true }` |
| PATCH | `/messages/:id` | `{ body }` (trimmed, 1–4096) | `Message` (sender only; 403 otherwise) |
| DELETE | `/messages/:id` | `{ scope?: "EVERYONE" \| "MINE" }` (default `EVERYONE`) | `{ ok: true }` |
| PUT | `/messages/:id/reactions` | `{ emoji }` (1–16 chars) | `Message` |
| DELETE | `/messages/:id/reactions` | `?emoji=<emoji>` | `Message` |
| PUT | `/messages/:id/pin` | `{}` | `Message` (pinned for **everyone**, 5E) |
| DELETE | `/messages/:id/pin` | – | `Message` (`pinned: null`, 5E) |
| GET | `/conversations/:id/pins` | `?cursor?&limit=50` | `{ pins: ChatPin[], nextCursor }` (newest pin first, 5E) |
| GET | `/conversations/:id/links` | `?cursor?&limit=50` | `{ links: ChatLinkItem[], nextCursor }` (gallery Links tab, 5E) |

Semantics:
- `start` is idempotent — starting with the same peer returns the existing DIRECT
  conversation. Unknown/inactive/self/blocked targets all return a single
  non-enumerating 404 "No Convo account found for that phone number".
- Message `body` is trimmed, 1–4096 chars. Since Phase 5B a send may instead (or
  additionally) carry `attachments` and `viewOnce` — see "Chat media" below — so
  `body` alone is optional, but body and attachments cannot *both* be empty.
  `clientMessageId` must be a UUID and is
  unique per sender; reusing one in a different conversation returns 400.
- Pagination cursors are opaque; pass `nextCursor` back as `cursor` for the next page.
- Rate limits: `start` 30/min, send message 120/min.
- **Chat options (Phase 4A):** editing and delete-for-everyone are restricted to
  the sender (403 otherwise); delete-for-me is allowed for any member and only
  hides the message for that viewer. Reactions are idempotent upserts keyed by
  (message, user, emoji) — `PUT` adds, `DELETE` removes. `deliveryStatus` reflects
  the furthest receipt across recipients and appears only on your own messages.
- **Chat controls (Phase 5A):** pin / archive / mute / clear / delete-for-me,
  stars, in-chat search and the contacts + safety endpoints live in their own
  section further down.
- **Pins (Phase 5E)** are *shared* state, unlike a 5A star: one `MessagePin` row
  per message, visible to the whole chat. Any active member may pin
  (`PUT`/`DELETE /messages/:id/pin`), a deleted message cannot be pinned, and
  re-pinning an already-pinned message keeps the original author and timestamp.
  `GET /conversations/:id/pins` pages newest pin first and applies the same
  hiding rules as the timeline, so a message cleared or hidden "for me" is absent.
- **@mentions (Phase 5E)** are resolved **server-side** when a group message is
  stored: the body is matched against that group's active roster and the winning
  ids land in `MessageMention`. A client never sends mention ids, so nobody can
  forge a notification into someone else's chat. Reads answer with
  `mentions: string[]` and the per-viewer `mentionedMe` flag, and each
  `ConversationSummary` carries `unreadMentions` — mentions newer than the
  viewer's `lastReadAt`/`clearChat` watermark.
- **The Links tab (Phase 5E)** is served from the `linkPreview` cards already
  stored at send time (`GET /conversations/:id/links`); the server never
  re-fetches the pages, so the tab cannot be used to probe a URL.

### WebSocket — `GET /ws?token=<accessToken>`

Browsers cannot set headers on a WebSocket handshake, so the JWT is passed as a
query param. On an invalid/expired token or a non-active user the server closes
with code **4401**; the client should refresh its access token and reconnect. On
success the server sends `{ "type": "ready", "userId": "clx..." }`.

All frames are JSON. Client → server:

| `type` | Payload | Purpose |
|---|---|---|
| `ping` | – | Keepalive; server replies `pong`. |
| `watch` | `{ userIds: string[] }` (1–100) | Subscribe to presence for these users. |
| `typing` | `{ conversationId, isTyping }` | Forwarded to the peer(s) of that conversation. |
| `read` | `{ conversationId, messageId? }` | Marks read (same as the REST endpoint) and fans out `message.read`. |
| `call.*` | see **Calling (Phase 5F)** below | Ring control and WebRTC signaling (`accept` / `reject` / `cancel` / `hangUp` / `signal` / `state`) — time-critical, so it never waits on HTTP. |

Server → client:

| `type` | Payload |
|---|---|
| `ready` | `{ userId }` |
| `pong` | – |
| `message.new` | `{ message }` — fanned out to the conversation's other members. |
| `message.read` | `{ conversationId, userId, readAt }` |
| `typing` | `{ conversationId, userId, isTyping }` |
| `presence` | `{ userId, online, lastSeenAt? }` — emitted on online-state transitions for watched users. |
| `message.edited` | `{ conversationId, messageId, body, editedAt }` — to the other members. |
| `message.deleted` | `{ conversationId, messageId, scope, userId? }` — `scope=EVERYONE` fans to other members; `scope=MINE` targets only the acting user (so their other devices hide it). |
| `message.reacted` | `{ conversationId, messageId, reactions }` — viewer-agnostic tally (`{ emoji, count }`), synced to **all** members. |
| `message.delivered` | `{ conversationId, messageIds, userId, deliveredAt }` — to the sender when a recipient was online at send time. |
| `message.viewOnceOpened` | `{ conversationId, messageId, userId, viewedAt }` — a member burned their single view of view-once media; fanned out to **all** members (including the opener's other devices) so every client can flip the tile to "Opened". |
| `message.linkPreview` | `{ conversationId, messageId, preview }` — the async link scrape for a TEXT message finished; published to **all** members (sender included) so the OG card appears after the bubble. Failures are silent: no event, no card. |
| `message.pin` | `{ conversationId, messageId, pin }` — a message was pinned or unpinned for **everyone** (5E); `pin: null` means unpin. Fanned out to all members *including the actor's other devices*, since a pin is shared state. |
| `mail.new` | `{ thread, message }` — a new mail landed in the recipient's own mailbox (see Mail below). |
| `group.changed` | `{ conversationId }` — membership, role, or settings changed; every active member is told so clients re-pull the group and its list. |
| `group.joinRequest.new` | `{ conversationId, conversationName, user }` — **admins only**: someone asked to join a private group. |
| `group.joined` | `{ conversationId, conversationName }` — **applicant only**: an admin approved their join request. |
| `status.new` | `{ status }` — a status the viewer is allowed to see was posted (fan-out already applied the audience rule; payloads are viewer-neutral). |
| `status.viewed` | `{ statusId, viewer }` — **author only**: one of their statuses was watched. |
| `call.*` | Voice/video calling — the ring, the exits, and the SDP/ICE relay. Payloads in **Calling (Phase 5F)** below; every frame is aimed at the two members of one 1-1 chat, and `call.ended` is serialized per viewer. |

Scaling note: the hub is a single-process `InMemoryHub`. The `RealtimeHub`
interface is the seam where a Redis pub/sub adapter drops in for multi-instance
deployments.

## Mail (Phase 3, spec §10/§11/§15/§17/§18)

Requires a valid access token **and** a connected email identity
(`capabilities.mail`). Requests from an account without an email identity return
403 with "Connect an email address to start using Mail".

Mail uses **real email semantics**: every account owns its own copy of a thread
and its messages. A conversation between two Convo users is two `EmailThread`
rows (one per owner), tied together by a shared `threadKey` and by RFC 5322
headers (`internetMessageId`, `inReplyTo`, `references`). Sending a message to a
Convo user mirrors an `INBOUND` copy into their mailbox and pushes `mail.new`
over their socket; the sender keeps an `OUTBOUND` copy. As with Chats, sends go
over HTTP and are made **idempotent** by a client-generated `clientSendId`
(UUID), so a retry returns the original instead of duplicating.

External (non-Convo) addresses are accepted and stored as `QUEUED`
(`route: EXTERNAL_SMTP`) for the Phase 4 gateway to drain. The composer **never**
learns whether a recipient was routed internally or externally — the request
shape is identical for both, which avoids a user-enumeration oracle.

### Objects

```jsonc
// MailParticipant
{ "address": "alice@example.com", "displayName": "Alice", "convoUserId": "clx...", "isExternal": false }

// MailMessage
{
  "id": "clx...", "threadId": "clx...", "direction": "INBOUND", "status": "DELIVERED",
  "fromAddress": "alice@example.com", "toAddresses": ["bob@example.com"],
  "subject": "Hello", "bodyText": "Hi",
  "internetMessageId": "<uuid@convo.local>", "inReplyTo": null, "references": [],
  "convoMessageId": "clx...", "createdAt": "…", "sentAt": "…", "receivedAt": "…"
}

// MailThreadSummary
{
  "id": "clx...", "subject": "Hello",
  "participants": [ /* MailParticipant */ ], "lastMessage": { /* MailMessage */ },
  "unreadCount": 1, "lastActivityAt": "…", "lastReadAt": null
}
```

`direction` is `INBOUND` | `OUTBOUND`. `status` is `QUEUED` | `SENDING` | `SENT` |
`DELIVERED` | `BOUNCED` | `FAILED`. `subject`/`bodyText`/timestamps may be null.

### REST endpoints

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| GET | `/mail/threads` | `?cursor?&limit=50` (1–100) | `{ threads: [...], nextCursor }` |
| GET | `/mail/threads/:id/messages` | `?cursor?&limit=50` | `{ messages: [...], nextCursor }` (oldest-first page) |
| POST | `/mail/send` | `{ clientSendId, to: string[], subject?, body }` | `{ thread, message }` |
| POST | `/mail/threads/:id/reply` | `{ clientSendId, body }` | `{ thread, message }` |
| POST | `/mail/threads/:id/read` | `{}` | `{ ok: true }` |

Semantics:
- `:id` is the caller's **own** thread id; accessing a thread you don't own returns
  a generic 404 (no enumeration). All reads/writes are owner-scoped.
- `to` is 1–25 addresses; `body` is trimmed, 1–65536 chars; `subject` is optional,
  trimmed, ≤998 chars. `clientSendId` must be a UUID and is unique per owner.
- `send` resolves and dedupes recipients (lowercased, self excluded); if the only
  address is yourself it returns 400 "Choose at least one recipient other than
  yourself".
- `reply` threads off the most recent message carrying a Message-ID: it sets
  `inReplyTo` to that `internetMessageId` and appends it to `references`, and
  reifies the subject to `Re: …` (idempotent — an existing `Re:` prefix is kept).
- `read` sets the thread's `lastReadAt` watermark; `unreadCount` counts `INBOUND`
  messages received after it.
- Rate limits: `send` 30/min, `reply` 60/min.

### Realtime delivery

Each recipient receives `{ type: "mail.new", thread, message }` on their socket,
where `thread` and `message` are that recipient's **own** copies (their thread id
differs from the sender's). Fan-out is per-recipient, so a send to several Convo
users publishes one event per online recipient.

## Groups (Phase 4B, spec §9)

Groups are `Conversation(type=GROUP)` rows with a 1:1 `GroupProfile` side-car, so
they reuse the whole chats pipeline: `GET /conversations` lists them,
`GET/POST /conversations/:id/messages` read and write their timeline, and
`/ws` fans out to every active member. All group endpoints require a phone
identity (403 otherwise) and a valid access token.

Roles are `ADMIN` | `MEMBER`. Membership is `joinState`: `ACTIVE`, `PENDING`
(an unresolved join request), or `REJECTED` (declined; stored with `leftAt` set
so it never appears in the roster).

**Entry rules (WhatsApp-style):**
- **PUBLIC** — anyone with the invite link or a discovery hit joins immediately.
- **PRIVATE** — entry requires an admin action: an admin adds the number
  directly, or approves a join request. A request from a private group's invite
  link also waits for approval (`requireApproval`, or whenever the account has
  no prior membership row). Declining leaves a `REJECTED` row, so the person is
  not silently re-asked on the next link use.
- Non-members may **preview** a PUBLIC group (name, about, member count) and
  never see the roster or invite code; previewing a PRIVATE group returns a
  generic 404 (no enumeration oracle).

### Objects

```jsonc
// GroupSettings
{ "visibility": "PUBLIC", "whoCanSend": "ALL", "whoCanEdit": "ADMINS",
  "whoCanInvite": "ALL",         // who may read/share the invite code (5E)
  "announceOnly": false, "requireApproval": false }

// GroupSummary
{
  "conversationId": "clx...", "name": "Design crew", "avatarUrl": null,
  "about": "Weekly sync", "memberCount": 12, "settings": { /* GroupSettings */ },
  "myRole": "ADMIN",            // null for non-members
  "inviteCode": "a1b2c3d4e5",   // admins only; null for everyone else
  "createdAt": "…"
}

// GroupMember
{ "userId": "clx...", "displayName": "Sam", "avatarUrl": null,
  "phone": "+919800000002", "role": "MEMBER", "joinState": "ACTIVE", "joinedAt": "…" }

// GroupDetail = GroupSummary + { members: GroupMember[], joinRequests: GroupMember[] }
// `joinRequests` is always empty unless the caller is an ADMIN.
```

`summaryOf` counts only `ACTIVE`, non-left members. `inviteCode` is revealed to
admins only, and `inviteRevokedAt` invalidates every previously shared link.

### REST endpoints

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| POST | `/groups` | `{ name, about?, avatarUrl?, avatarStorageKey?, visibility="PRIVATE", phones?: E.164[] }` | `GroupDetail` |
| GET | `/groups` | `?cursor?&limit=50` | `{ groups: GroupSummary[], nextCursor }` |
| GET | `/groups/discover` | `?q=<1–50>&limit=20` (1–50) | `{ groups: GroupSummary[] }` — PUBLIC only |
| GET | `/groups/join/:code` | – | `GroupDetail` (redeems an invite link) |
| GET | `/groups/:id` | – | `GroupDetail` |
| PATCH | `/groups/:id` | `{ name?, about?, avatarUrl?, avatarStorageKey?: string \| null, settings?: Partial<GroupSettings> }` | `GroupDetail` |
| DELETE | `/groups/:id` | – | `{ ok: true }` |
| POST | `/groups/:id/members` | `{ phones: E.164[] }` (1–25) | `GroupDetail` |
| DELETE | `/groups/:id/members` | `{ userId }` | `GroupDetail` |
| POST | `/groups/:id/leave` | `{}` | `{ ok: true }` |
| PUT | `/groups/:id/admins` | `{ userId }` | `GroupDetail` |
| DELETE | `/groups/:id/admins` | `?userId=` | `GroupDetail` |
| GET | `/groups/:id/requests` | – | `{ requests: GroupMember[] }` |
| POST | `/groups/:id/requests/approve` | `{ userId }` | `GroupDetail` |
| POST | `/groups/:id/requests/reject` | `{ userId }` | `GroupDetail` |
| POST | `/groups/:id/apply` | `{}` | `{ pending: boolean }` |
| POST | `/groups/:id/invite/revoke` | `{}` | `GroupDetail` |

Semantics:
- `POST /groups` makes the creator the first `ADMIN`. `:id` is always the
  group's **conversation id**, so a client can open a group with the same code
  path it uses for 1:1 chats.
- Settings gates: `announceOnly` or `whoCanSend=ADMINS` restrict posting to
  admins (`assertCanPost` runs inside `sendMessage`, so the REST send path is
  gated, not just the UI). `whoCanEdit=ALL` lets members change name/about/
  avatar; `settings` themselves are admin-only, and `visibility` changes are
  admin-only regardless.
- **Group icon (Phase 5E):** `avatarStorageKey` is an uploaded media key (see
  `POST /media/upload`), validated to belong to the caller, and it takes
  precedence over the plain `avatarUrl` string. `GroupSummary.avatarUrl` is then
  a freshly signed, short-lived download URL on every read — the key itself is
  never returned. Sending `avatarStorageKey: null` removes the icon.
- **Invite-link permission (Phase 5E):** `whoCanInvite=ADMINS` hides
  `inviteCode` from ordinary members in every group payload, so a member's
  clients have nothing to share. Joining by code is unaffected: an existing code
  still works for whoever holds it.
- **Mentions in groups (Phase 5E):** a group send resolves `@name` against the
  active roster server-side, writes one `MessageMention` row per member named,
  and pushes `message.new` with `mentionedMe` set for the people tagged. Edits
  re-resolve without changing `createdAt`, so re-mentioning cannot re-badge a
  chat the viewer already read.
- `apply` on a PUBLIC group activates instantly (`pending: false`) and announces
  the join; on a PRIVATE group it creates a `PENDING` row and pushes
  `group.joinRequest.new` to every online admin. Approval pushes `group.joined`
  to the applicant and `group.changed` to the rest.
- Membership changes write `SYSTEM` messages into the timeline ("X added Y",
  "X joined the group", "X is now an admin"), fanned out as `message.new` with
  `senderId: null` — clients render them as a centred grey pill.
- Adding members: PRIVATE groups are admin-only, PUBLIC groups let any member
  add. Re-adding someone who left resets them to `MEMBER`.
- Promote/demote/remove all require an active admin. Demoting the last admin is
  rejected ("A group needs at least one admin"); an admin cannot remove
  themselves (leave instead), and leaving the group with nobody active in it
  deletes the conversation. `DELETE /groups/:id` is admin-only.
- Rate limits: create 20/min, add members 60/min, apply 30/min. Groups cap at
  1024 active members.

## Status + media (Phase 4B, spec §9/§24)

Ephemeral posts — text, photo, video, or link — that expire on a user-chosen
lifetime (default 24h, max 168h). Media bytes never travel through the status
call: the client uploads first, then references the returned key.

### Objects

```jsonc
// StatusItem
{
  "id": "clx...",
  "author": { "userId": "clx...", "displayName": "Sam", "avatarUrl": null },
  "kind": "IMAGE",                 // TEXT | IMAGE | VIDEO | URL
  "text": "caption or link",       // caption / body / URL
  "mediaUrl": "http://…/media/ab12.jpg?token=…",  // IMAGE|VIDEO only; expiring
  "visibility": "CONTACTS",        // EVERYONE | CONTACTS | CUSTOM | CONTACTS_EXCEPT
  "createdAt": "…", "expiresAt": "…",
  "viewCount": 4,                  // author only, else null
  "hasViews": true,                // author only, else null
  "shareReadReceipts": true,       // author's own 5D switch; readable by viewers
  "seenByMe": false,               // viewer only
  "isMine": false
}

// StatusViewer
{ "userId": "clx...", "displayName": "Rai", "avatarUrl": null, "viewedAt": "…" }

// StatusMute (GET /statuses/muted) — private to the caller, never sent to the author
{ "userId": "clx...", "displayName": "Rai", "avatarUrl": null, "mutedAt": "…" }
```

`GET /statuses` returns `{ mine, others }`, each newest-first. `mine` is the
caller's own live statuses; `others` are other accounts' live statuses that the
caller passes the author's audience rule for. Statuses whose author the caller
muted are left out entirely. `viewCount`/`hasViews` are only populated on the
author's own items so view totals are not leaked to viewers.

### REST endpoints

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| POST | `/media/upload` | multipart **or** `{ data: base64, mimeType, fileName? }` | `{ storageKey, kind, mimeType, sizeBytes, fileName, downloadUrl }` |
| GET | `/media/:key?token=<jwt>` | – | raw bytes (`content-type` from storage) |
| POST | `/statuses` | `{ kind, text?, storageKey?, mimeType?, durationHours=24, visibility="EVERYONE", userIds?[], shareReadReceipts=true }` | `StatusItem` |
| GET | `/statuses` | – | `{ mine: StatusItem[], others: StatusItem[] }` |
| POST | `/statuses/:id/viewed` | `{}` | `{ ok: true }` |
| GET | `/statuses/:id/viewers` | – | `{ viewers: StatusViewer[] }` (author only) |
| POST | `/statuses/:id/reply` | `{ clientMessageId, body }` | `{ conversationId, message: Message }` |
| GET | `/statuses/muted` | – | `{ items: StatusMute[] }` |
| PUT | `/statuses/mute/:authorId` | `{}` | `{ ok: true }` |
| DELETE | `/statuses/mute/:authorId` | `{}` | `{ ok: true }` |
| DELETE | `/statuses/:id` | – | `{ ok: true }` |

Semantics:
- Uploads are authenticated, MIME-allowlisted (images, video, audio, PDF, and
  common documents), size-capped by `MEDIA_MAX_UPLOAD_BYTES`, and rejected when
  empty. The JSON/base64 variant exists because React Native cannot stream
  multipart bodies from the camera roll.
- Downloads are served through a **short-lived JWT bound to one storage key**
  (`{ media: key }`, `MEDIA_URL_TTL_SECONDS`, default 6h). The token is not an
  access token — it authenticates the file, nothing else — so plain
  `<img>`/`<video>`/`expo-image` tags work without headers. A token presented
  against a different key returns 403.
- Provider is pluggable: `MEDIA_STORAGE_PROVIDER=local` writes under
  `.data/media` (sharded by key prefix, keys validated against path traversal);
  `=supabase` uses Supabase Storage with the **service-role key held only
  server-side** in `apps/api/.env`. Clients never receive provider credentials.
- `POST /statuses` validates per kind: TEXT/URL require `text`, URL must parse
  as `http(s)`, IMAGE/VIDEO require a `storageKey`. `userIds` is the allow-list
  for `CUSTOM` (must be non-empty) and the block-list for `CONTACTS_EXCEPT`.
- Audience is enforced **server-side on read** (`matchesAudience`) as well as at
  fan-out, and an author always sees their own status. Contacts mean either
  direction of the `Contact` book.
- Expiry is lazy: listing purges the caller's own expired rows, and reads filter
  `expiresAt >= now`, so a status stops resolving the moment it ages out.
  `POST /statuses/:id/viewed` is idempotent (one `StatusView` per account) and
  pushes `status.viewed` to the author.
- **Replies (5D)**: `POST /statuses/:id/reply` is a normal 1-1 message, not a
  new message type. It opens (or reuses) the DIRECT chat with the author through
  the same `openDirectChat` path as starting a chat, then sends through
  `sendMessage` with the status as its quote. The message carries
  `statusReplyId` (the marker clients label the strip "Status reply") plus the
  existing `replyPreview` snapshot, which is re-signed at read time and survives
  the status being deleted or expiring. You cannot answer your own status, and
  an unknown, expired or not-for-you status all answer `404 Status not found` —
  replying never probes who posted what. Rate limit: 60/min.
- **Read receipts (5D)**: `shareReadReceipts` is stored per status. When it is
  off, `POST /statuses/:id/viewed` records nothing at all — no `StatusView` row
  and no `status.viewed` push — so there is no data to reveal later. The promise
  beats the viewer's own seen-ring, which stays client-local.
- **Muting (5D)**: `StatusMute` is keyed `(userId, authorId)` and is private to
  the caller; the author is never told and no WS event is emitted. Muted authors
  are filtered both on pull (`GET /statuses`) and at fan-out, so their posts
  never light the ring live either. Muting your own account is rejected; muting
  an unknown or non-active account answers like an unknown status.
- Rate limit: 30 status posts/min.

## Chat controls, contacts and safety (Phase 5A, spec §9/§10/§28)

Every control here is **per-viewer**: it is stored on the caller's
`ConversationMember` row (or a row keyed by the caller), so pinning, muting,
clearing or deleting a chat never changes what anyone else sees.

### Objects

```jsonc
// Contact — private to its owner; `convoUserId` is set only when the saved
// phone/email matched a verified, active Convo account.
{ "id": "clx...", "displayName": "Sam Riley", "phone": "+447700900123", "email": null,
  "avatarUrl": null, "source": "MANUAL", "convoUserId": "clx...",
  "createdAt": "2026-09-29T10:00:00.000Z" }        // source: MANUAL | SYNCED | RECENT

// RecentRecipient — "message new chat" autocomplete
{ "userId": "clx...", "displayName": "Sam", "avatarUrl": null, "phone": "+447700900123",
  "conversationId": "clx...", "lastMessageAt": "2026-09-29T10:00:00.000Z" }

// BlockedUser
{ "userId": "clx...", "displayName": "Sam", "avatarUrl": null, "phone": "+447700900123",
  "blockedAt": "2026-09-29T10:00:00.000Z" }

// UserCard — the contact-info sheet; hidden fields are null, never an error
{ "userId": "clx...", "displayName": "Sam", "avatarUrl": null, "bio": "hi",
  "phone": "+447700900123", "lastSeenAt": null, "blockedByMe": false,
  "sharedConversationId": "clx..." }

// StarredMessage — GET /starred item
{ "message": { /* Message */ }, "conversationId": "clx...", "conversationName": "Sam" }

// GlobalSearchResult — one term across the caller's own data
{ "query": "invoice", "contacts": [ /* Contact */ ],
  "conversations": [ /* ConversationSummary */ ],
  "messages": [ { "message": { /* Message */ }, "conversationId": "clx...", "conversationName": "Sam" } ],
  "groups": [ /* GroupSummary */ ] }
```

### REST endpoints

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| PATCH | `/conversations/:id` | `{ pinned? , archived?, muteHours? }` (≥1 key; `muteHours` 0–8760) | `ConversationSummary` |
| POST | `/conversations/:id/clear` | — | `ConversationSummary` |
| DELETE | `/conversations/:id` | — (delete **for me**) | `{ ok: true }` |
| PUT | `/messages/:id/star` | `{ starred? }` (default `true`) | `Message` |
| GET | `/starred` | `?cursor?&limit=50` | `{ items: [...], nextCursor }` |
| GET | `/conversations?archived=true` | cursor + `archived` | archived chats only |
| GET | `/conversations/:id/messages?q=&starred=true` | cursor + filters | filtered page |
| GET | `/contacts` | — | `{ contacts: [...] }` |
| GET | `/contacts/recent` | — (fixed 20) | `{ recipients: [...] }` |
| POST | `/contacts` | `{ id?, displayName, phone? \| email?, avatarUrl? }` | `Contact` |
| DELETE | `/contacts/:id` | — | `{ ok: true }` |
| GET | `/users/:id` | — | `UserCard` |
| GET | `/blocks` | — | `{ blocked: [...] }` |
| POST | `/blocks` | `{ userId }` **or** `{ phone }` (E.164) | `BlockedUser` |
| DELETE | `/blocks/:userId` | — | `{ ok: true }` |
| POST | `/reports` | `{ targetType: "USER"\|"MESSAGE"\|"CONVERSATION", targetId, reason, details?, blockAfterReport? }` | `{ id, blocked }` |
| GET | `/search?q=&limit=10` | `q` 1–100 chars, `limit` 1–30 | `GlobalSearchResult` |

Report reasons: `SPAM`, `ABUSE`, `HARASSMENT`, `FRAUD`, `VIOLENT`,
`IMPERSONATION`, `OTHER`.

Semantics:
- **Mute** follows WhatsApp's presets — `muteHours` 8 / 168 / 8760, and `0`
  clears `mutedUntil`. The server stores a deadline, so a muted chat still
  receives messages; only client-side notification sound is suppressed.
- **Archive** moves the chat out of `GET /conversations` and into
  `?archived=true`. Archiving also un-hides the row (an archive is a folder you
  can open, not a deletion).
- **Clear chat** sets a `clearedAt` watermark: older messages stop appearing in
  this viewer's timelines, previews and unread counts, and `lastReadAt` moves
  with it so the old backlog cannot stay unread. Rows are untouched for others.
- **Delete chat (for me)** marks the membership `hidden` and watermarks it. The
  chat disappears from the list and comes back by itself as soon as new activity
  arrives (`sendMessage` un-hides it).
- **Star** is a per-user bookmark (`StarredMessage`), so a starred message is
  private to the starer; `starredByMe` rides on every serialized `Message` and
  `GET /starred` lists them newest-star first across all chats. Stars on
  messages behind a clear-chat watermark are kept but not listed. Starring a
  message deleted for everyone returns 400.
- **In-chat search** (`?q=`) and `?starred=true` filter the same visible timeline
  and page like the normal history cursor; matching is case-insensitive
  `ILIKE '%q%'` on `body`, so there is no ranking or index dependency yet.
- **Contacts** upsert on (owner, phone) or (owner, email): posting an address the
  owner already saved updates that row instead of duplicating it. Emails are
  stored lower-cased. `convoUserId` resolution only matches *verified, active*
  identity rows.
- **Blocking is non-revealing.** A blocked sender's `POST /messages` still
  returns 200 and the row is stored, but no delivery receipt is recorded and
  nothing is fanned out over the socket — the sender sees a permanent single
  tick and is never told. Blocking by an unknown or deactivated phone answers
  with the same generic 404 as `/conversations/start`, so neither endpoint can
  probe whether a number has an account.
- **Reports** require the target to be visible to the reporter (member of the
  chat, active account), so the endpoint cannot be used to probe ids.
  `blockAfterReport` additionally blocks the accountable account — the message
  sender, or the peer of a direct chat (a group has no single accountable
  member, so nothing is blocked).
- **UserCard** reveals a phone only when the viewer saved that person as a
  contact, shares a chat with them, or the target sets
  `presenceVisibility: EVERYONE`; last-seen keeps following the target's own
  visibility rule.
- **Global search** only ever covers rows the caller already has access to
  (their address book, their active+visible memberships, message bodies in those
  chats, and public groups). Results are capped at `limit` per section.
- Rate limits: `POST /blocks` 30/min, `POST /reports` 10/min.
- **No new WebSocket events.** 5A changes are quiet, per-viewer state, so
  clients re-pull the affected list after a control call instead of the server
  broadcasting. `conversation.updated` and friends stay as in 4A/4B.

## Chat media messages (Phase 5B, spec §9/§24)

Photo, video, document and voice **messages** in Chats, reusing the
`POST /media/upload` + `GET /media/:key` paths built for statuses (see above).
Media is never inlined in a send: the client uploads first, then references the
returned key.

### Objects

```jsonc
// Attachment — as the client sees it on a Message
{
  "id": "clx...", "kind": "IMAGE", "mimeType": "image/jpeg",
  "fileName": "sunset.jpg",              // display label, docs especially
  "sizeBytes": 812_345, "width": 3024, "height": 4032, "durationMs": null,
  "mediaUrl": "http://…/media/ab12.jpg?token=…"  // expiring; NULL for view-once
}

// ReplyPreview — snapshot frozen when the reply was sent (outlives the original)
{ "messageId": "clx...", "senderId": "clx...", "senderName": "Sam",
  "type": "IMAGE", "body": null, "kind": "IMAGE", "fileName": null, "mediaUrl": null }

// ForwardedFrom — WhatsApp's "Forwarded" label
{ "userId": "clx...", "displayName": "Sam" }
```

`Message` gained `attachments: Attachment[]`, `viewOnce`, `viewOnceOpened`,
`forwardedFrom` and `replyPreview` (all defaulted in `@convo/shared`). The
message `type` is **derived server-side from the first attachment's kind**
(`IMAGE`/`VIDEO`/`DOCUMENT`/`VOICE`, else `TEXT`) — clients never set it.
5B extras added `linkPreview`, `location` and `contactCard` (all nullable
JSON columns, defaulted to `null`) and the `STICKER`/`LOCATION`/`CONTACT`
types (see below).

### REST endpoints

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| POST | `/conversations/:id/messages` | `{ clientMessageId, body?, replyToId?, attachments?: AttachmentInput[], viewOnce?, location?, contactCard?, sticker? }` | `Message` |
| POST | `/conversations/forward` | `{ messageIds: 1–20, conversationIds: 1–20 }` | `{ created: Message[] }` |
| GET | `/conversations/:id/media` | `?kind=ALL\|IMAGE\|VIDEO\|DOCUMENT\|VOICE&cursor&limit` | `{ messages, nextCursor }` (newest first) |
| POST | `/messages/:id/view-once` | — | `{ attachments }` — signed URLs, **exactly once per viewer** |
| GET | `/giphy/search` | `?q=&limit=1–25` | `{ enabled, items: { id, title, previewUrl, width, height }[] }` |
| POST | `/giphy/upload` | `{ giphyId }` | same shape as `POST /media/upload` |

`AttachmentInput` is a reference, not a description:
`{ storageKey, fileName?, width?, height?, durationMs? }` — at most 10 per
message. Kind, MIME type and size are read back from the server's own
`MediaObject` row, so a client cannot mislabel a file or attach somebody else's
media key.

Semantics:
- **Uploads bind to the uploader.** Every accepted object gets a `MediaObject`
  row owned by the account that uploaded it; `sendMessage` only accepts keys
  this account owns, so a key harvested from someone else's message fails with
  400 `Unknown media key` instead of leaking bytes.
- **Empty-send rule.** A message needs a `body`, `attachments`, or both —
  `viewOnce` additionally requires media, and photo/video kinds only.
- **View-once media is URL-less everywhere.** Timeline, preview, search and
  gallery payloads carry its attachments with `mediaUrl: null`; the only way to
  get bytes is `POST /messages/:id/view-once`, which inserts the
  `ViewOnceView(messageId, userId)` row and mints fresh signed URLs for that
  one viewer. A second open — including two devices racing — answers
  **409 "This message was already viewed"** (the unique index is the real
  guard), and the sender's own message row reports `viewOnceOpened: true`.
- **Forwarding by reference.** `POST /conversations/forward` re-delivers the
  source messages (same storage keys, no byte copies) into each target chat the
  caller may post in, stamped with `forwardedFrom`. The cap is 20 messages ×
  20 chats with at most **100 deliveries** per request; source messages must be
  visible, not deleted, and not view-once (the single view is the original
  recipient's promise). Forwards are server-created rows with generated
  `clientMessageId`s — there is no idempotency key, so a retried forward can
  duplicate; clients keep the sheet busy until the response lands. The endpoint
  always took a `messageIds` array; **Phase 5E** wired the multi-select picker in
  both clients (long-press / bubble action → "Select messages" → Forward), so
  several messages cross in one request.
- **Reply quotes outlive the original.** `replyPreview` is a JSON snapshot
  (sender name, snippet, media kind, file name) taken at send time, so a reply
  still shows its quote after the quoted message is edited, deleted, or cleared
  away. Quoting view-once media keeps the text/kind but drops the storage key.
- **A status reply is a quoted message, not a new type (5D).** `Message` gains
  only `statusReply: { statusId } | null`, projected from `statusReplyId`
  (`onDelete: SetNull`, so deleting the status leaves the message and its
  snapshot intact). Clients render it as the same reply strip with a "Status
  reply · …" label; delivery, receipts and edits all work unchanged.
- Rate limit: forward 30/min. Upload rules (MIME allowlist,
  `MEDIA_MAX_UPLOAD_BYTES`, per-key JWT downloads) are the 4B ones.

### Link previews, GIFs, location & contacts (Phase 5B extras)

- **Link previews are strictly best-effort and always post-send.** A TEXT
  message whose body contains an http(s) URL kicks off a fire-and-forget
  scrape (`services/unfurl.ts`) after delivery: first URL wins, redirects are
  followed manually (max 3, each hop re-validated), the page is byte-capped
  (`LINK_PREVIEW_MAX_BYTES`) and deadline-bound (`LINK_UNFURL_TIMEOUT_MS`).
  The SSRF guard resolves the hostname itself and refuses loopback, private,
  link-local, CGNAT, benchmarking, multicast and unique-local space — IPv4 and
  IPv6, including IPv4-mapped and 6to4-embedded forms — so a chat link can
  never make the server hit `169.254.169.254` or an intranet host. Preview
  *image* URLs are loaded by clients, not the server, so they are at least
  screened for obvious internal hosts. Any failure → no preview, no error,
  the message already sent. On success the JSON lands on
  `Message.linkPreview` and every member gets `message.linkPreview`.
- **GIF/sticker search proxies Giphy; the key never leaves the server.**
  `GET /giphy/search` forwards to `api.giphy.com` (rating pg-13) with
  `GIPHY_API_KEY` from `.env`; with no key configured it answers
  `{ enabled: false, items: [] }` and pickers hide themselves. Picking a GIF
  calls `POST /giphy/upload`, which downloads the bytes (≤15 MB, content-type
  must be `image/gif`), stores them through the normal media provider and
  returns a regular owned `storageKey` — chats never reference giphy CDN URLs.
- **Stickers.** `sticker: true` with an IMAGE attachment types the message
  `STICKER`; clients render it edge-to-edge without a bubble.
- **Location & contact shares** are JSON-payload messages: `location`
  (`{ latitude, longitude, name?, address? }`) → type `LOCATION`, `contactCard`
  (`{ displayName, phone?, email?, avatarUrl?, userId? }`) → type `CONTACT`.
  A message carries one or the other, never both (schema refine + service
  guard), and both ride through forwarding like attachments. Contact cards
  only ever contain what the sharer already sees (their own contact entry).
- **Media auto-download** (`ALWAYS` | `WIFI_ONLY`, default `ALWAYS`) is a
  pure client hint on `Account` / `PATCH /me/profile`; the API always mints
  signed URLs, and both clients gate heavy tiles on Wi-Fi when set.

## Privacy + security (Phase 5C, spec §34)

### Two-step verification at login

An account with a login PIN no longer hands out a session from the OTP step.
`POST /auth/{phone,email}/verify-otp` answers one of two shapes (`AuthResult` is
a discriminated union — clients must narrow on the `session` key):

```jsonc
{ "session": {…}, "account": {…}, "isNewAccount": false }          // no PIN set
{ "twoFactorRequired": true, "twoFactorToken": "…", "expiresInSeconds": 600 }  // PIN set
```

The second leg is `POST /auth/2fa/verify` with `{ twoFactorToken, pin }`, which
returns the normal session shape. Details:

- The PIN is stored as scrypt `salt:hash` hex (`User.twoFactorHash`), never as
  plaintext, and never logged. `PUT /me/two-factor` sets or replaces it;
  `DELETE /me/two-factor` removes it.
- The one-time token is random, stored only as a SHA-256 hash on a
  `VerificationChallenge` with purpose `TWO_FACTOR`, TTL 10 minutes and 5
  attempts, and is consumed on first success.
- Both OTP-verify routes and the 2FA route share the `OTP_VERIFY_LIMIT` rate
  limiter, so brute-forcing a PIN is rate-limited the same way as a code.
- A failed or expired second factor returns 401/429 and says nothing about
  whether the account exists (same non-revealing wording as the OTP flow).

### Profile privacy enforcement

`avatarVisibility`, `aboutVisibility`, `onlineVisibility` (+
`visibilityExcluded`), `groupAddVisibility` and `readReceiptsEnabled` are
resolved from the **owner's** row at every serialization boundary — `peerOf`
in the chat list, `getUserCard`, presence broadcast, and receipts. A client
claim is never trusted. Two rules are deliberate:

- Being hidden is indistinguishable from having nothing to show (no "this
  profile is private" oracle).
- `groupAddVisibility` skips disallowed targets **silently** instead of
  erroring, so group creation can't be used to probe who restricted themselves.

### Disappearing messages

| Method | Path | Auth | Body / Query | Returns |
|---|---|---|---|---|
| PATCH | `/conversations/:id/ephemeral` | ✓ | `{ seconds }` — only `0`, `86400`, `604800`, `7776000` | `ConversationSummary` |
| GET | `/conversations/:id/export` | ✓ | `?includeMedia=true` (optional) | `ChatExportDocument` |

`Conversation.ephemeralSeconds` stamps `Message.expiresAt` at send **and** at
forward. Expired rows are removed lazily (on history read), by a
per-conversation sweep, and by the `EPHEMERAL_SWEEP_SECONDS` interval timer;
members get `message.expired`, and a timer change broadcasts
`conversation.ephemeralChanged`. When both participants set a default, the
**shorter** timer wins on a new 1-1 chat.

### Chat export

`GET /conversations/:id/export` answers the transcript as JSON (up to 25 000
messages, `deletedAt` and per-viewer `clearedAt` respected). With
`includeMedia=true` each attachment carries a short-lived signed `mediaUrl`;
view-once media is never included. The API does not build a ZIP — clients fetch
the URLs and bundle their own archive (web downloads the JSON, mobile writes it
to app storage).

### Sessions, devices and deletion

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/me/two-factor` | ✓ | `{ enabled }` |
| PUT / DELETE | `/me/two-factor` | ✓ | set/replace PIN (`{ pin }`, 6 digits) / clear it |
| GET | `/me/sessions` | ✓ | active sessions; the bearer's own row is flagged `current` |
| DELETE | `/me/sessions/:id` | ✓ | revoke one |
| POST | `/me/sessions/revoke-others` | ✓ | `{ revoked }`, keeps the current session |
| GET / POST | `/me/devices` | ✓ | list / upsert a push registration |
| DELETE | `/me/devices/:id` | ✓ | unlink |
| POST | `/me/delete-account` | ✓ | 5/hour. Starts the grace window; returns `{ deletionScheduledAt, graceDays }` |
| DELETE | `/me/delete-account` | ✓ | back out while the window runs |

`POST /me/delete-account` only stamps `User.deletionRequestedAt`; sign-in keeps
working through the grace window (`ACCOUNT_DELETION_GRACE_DAYS`, default 30) and
the `DELETION_SWEEP_SECONDS` timer anonymises then deletes accounts past it —
messages survive with a null sender, exactly like a deleted contact's bubbles.

## Calling (Phase 5F)

Voice and video over **self-hosted WebRTC**. Media is peer-to-peer: the API
never carries a byte of audio or video. What it does own is the call *record*
(so a missed call survives in history), the state machine that decides who may
answer or hang up, and the signaling relay that shuttles SDP/ICE between exactly
the two members of a 1-1 chat.

Calls live inside 1-1 chats, so they inherit Chats' identity rule (a phone
identity, `capabilities.chats` — `requireChats` is what makes the conversation
exist in the first place); there is no separate capability gate on these
endpoints. A `GROUP` conversation answers `POST /calls` with 400 — calling is 1-1
only in 5F.

### Objects

#### `CallSummary`

```json
{
  "id": "clx...",
  "conversationId": "clx...",
  "mediaType": "VOICE",              // VOICE | VIDEO
  "status": "RINGING",               // RINGING | CONNECTED | ENDED | MISSED | DECLINED | CANCELED | BUSY | FAILED
  "direction": "INCOMING",           // per-viewer: OUTGOING when you placed it
  "caller": { "userId": "clx...", "displayName": "Sammy Khan", "avatarUrl": null },
  "callee": { "userId": "clx...", "displayName": null, "avatarUrl": null },
  "createdAt": "2026-09-29T10:00:00.000Z",
  "connectedAt": null,               // set when media actually starts
  "endedAt": null,
  "durationSeconds": null,           // connectedAt → endedAt; null until it ends
  "endReason": null                  // HANG_UP | DECLINED | MISSED | BUSY | CANCELED | DISCONNECTED | FAILED
}
```

`direction` and `status` are the same row seen from each side: a call the
callee walked away from is `DECLINED` for both, but `OUTGOING` for the caller
and `INCOMING` for the callee. `endReason` is stored once (`Call.declineReason`)
and read by both.

#### `IceConfig`

```json
{
  "iceServers": [
    { "urls": "stun:stun.l.google.com:19302" },
    {
      "urls": ["turn:relay.example.com:3478?transport=udp"],
      "username": "1790000000:clx...",
      "credential": "base64(HMAC-SHA1(TURN_SECRET, username))"
    }
  ],
  "ttlSeconds": 3600
}
```

coturn's time-limited REST credential: `username` is `expiry:userId` and
`credential` is the HMAC of that string, so **the shared secret itself is never
sent** and a leaked credential dies on its own. With `TURN_URLS` empty the
config carries STUN only, which still connects two peers on the same LAN.

### REST endpoints

| Method | Path | Body / query | Returns |
|---|---|---|---|
| POST | `/calls` | `{ conversationId, mediaType? }` | `{ call, ice }` — starts the ring and hands the caller its ICE config |
| GET | `/calls/ice-config` | – | `IceConfig` (the callee fetches its **own**; credentials never ride the socket) |
| GET | `/calls` | `?conversationId?&direction=INCOMING&missedOnly=true&cursor?&limit=50` | `{ items: CallSummary[], nextCursor }` — the call log, newest first |
| GET | `/calls/missed-count` | – | `{ count }` — unseen missed calls |
| POST | `/calls/:id/accept` | – | `CallSummary` (`CONNECTED`) |
| POST | `/calls/:id/decline` | `{ reason? }` (`DECLINED` \| `BUSY`) | `CallSummary` |
| POST | `/calls/:id/hang-up` | – | `CallSummary` |
| PATCH | `/calls/:id/me` | `{ muted?, cameraOff? }` (at least one) | `CallSummary` |

`POST /calls` is rate-limited (20/min). Notes on the state machine:

- **Dialing is idempotent.** Retrying `POST /calls` while *your own* call on that
  chat is still `RINGING`/`CONNECTED` returns that call instead of writing a
  second row — a client that loses the response must not create two log entries
  for one dial.
- **Busy is answered before the ring.** If the peer is live in another call,
  `POST /calls` returns 409 "They're already on a call"; the caller learns it
  here rather than staring at an overlay no device will ever answer.
- **Blocking cuts both ways** and is never explained: 403 "Calls are not
  available in this chat" (5A's rule). A stranger who is not a member of the
  chat gets 404, never a hint that the conversation exists.
- **`POST /calls/:id/hang-up` is one verb for "I'm done"** whichever side of the
  machine the client is on: it cancels a ring the caller placed (`CANCELED`),
  declines an incoming ring (`DECLINED`), or ends a live call (`ENDED` /
  `HANG_UP`). A call that already finished answers with its record unchanged and
  writes nothing.
- **Missed-call badge is a watermark**, not a counter: a `MISSED` row counts
  until the chat's own `lastReadAt` passes it (the 5E precedent), so opening the
  chat clears the badge on every device, and calls you placed never count.

### WebSocket frames

Signaling is time-critical, so it rides the authenticated `/ws` socket instead of
HTTP. Client → server (all need `callId`):

| `type` | Payload | Purpose |
|---|---|---|
| `call.accept` | – | The invitee answers. Same transition as `POST /calls/:id/accept`. |
| `call.reject` | `reason?` (`DECLINED` default) | Turn the ring down, or report busy. |
| `call.cancel` | – | The caller stops ringing before anyone answers. |
| `call.hangUp` | – | Either side ends it. |
| `call.signal` | `{ payload }` — `{kind:"offer"\|"answer", sdp}` or `{kind:"ice", candidate, sdpMid?, sdpMLineIndex?}` | The WebRTC handshake, relayed verbatim to the peer. |
| `call.state` | `{ muted?, cameraOff? }` | Mic/camera state, recorded for the log. |

Server → client:

| `type` | Payload |
|---|---|
| `call.incoming` | `{ call }` — a ring for you, serialized from **your** side (`direction: INCOMING`) |
| `call.accepted` | `{ callId, conversationId, acceptedBy, acceptedAt }` — the caller's devices stop ringing and start negotiating |
| `call.rejected` / `call.busy` | `{ callId, conversationId, by }` — the two non-answers stay distinct, because "busy" is not "they rejected me" |
| `call.canceled` | `{ callId, conversationId, by }` — the caller hung up mid-ring |
| `call.hangUp` | `{ callId, conversationId, by }` — a live call was ended |
| `call.signal` | `{ callId, conversationId, from, payload }` — SDP/ICE from the peer |
| `call.ended` | `{ call }` — the terminal frame, sent to **both** sides with each side's own `direction` |

An invalid transition (already answered, call over, not a participant) is
rejected on the socket and simply ignored: the client's next `call.ended` frame
or REST read is the authoritative view.

- **SDP is persisted, ICE is not.** Offers and answers land in `CallEvent` for
  disputes and reconnect replays; candidates arrive in bursts of dozens and a
  candidate that lands after the call is over is dropped, which is why the status
  check happens before the relay.
- **Nothing expires by timer.** A ring nobody answered becomes `MISSED` through
  a sweep (`CALL_SWEEP_SECONDS`, default 15) that reaps calls older than
  `CALL_RING_TIMEOUT_SECONDS` — so an API restart mid-ring still expires it, and
  a caller who closed the tab doesn't leave a live modal on the callee's phone
  forever.
- **No secrets on the socket.** `call.incoming` carries no ICE config; the
  callee calls `GET /calls/ice-config` with its own token.

### Configuration

`STUN_URLS`, `TURN_URLS`, `TURN_SECRET`, `TURN_CREDENTIAL_TTL_SECONDS`,
`CALL_RING_TIMEOUT_SECONDS`, `CALL_SWEEP_SECONDS` — all server-side, in
`apps/api/.env`. Boot refuses to start with `TURN_URLS` set but no `TURN_SECRET`,
since a relay nobody can mint credentials for is a broken call path.

Group calls and background/push ringing are **not** in 5F: the schema already
carries a per-call participant roster, and incoming-call notifications arrive in
5G. On mobile, media needs a development build (`react-native-webrtc`); in Expo
Go the dial buttons explain that instead of pretending to ring.

## Planned (later phases)

Phases 5A–5F are complete: chat controls and contacts, media messages, link
previews and shares, privacy + security, status parity, the group-parity set
(@mentions with unread badges, shared pins, the Links tab, group icon upload,
multi-select forward and the invite-link permission), and 1-1 voice/video calling
with a server-side call log. Still open across **5G** (see
`docs/FEATURE-PARITY.md`):

- **5G — Notifications**: notification centre, FCM + web push, per-chat sound and
  quiet mode, incoming-call alerts, mention notifications.
- **5G — Group calls**: the `CallParticipant` roster is already per-member, so
  the schema needs no new table; the state machine and UI do.

Deferred beyond Phase 5: the external email gateway (SMTP send + IMAP/webhook
ingest draining `QUEUED` recipients), device contacts sync, and upgrading the
`ILIKE` search paths to indexed full-text once message volume justifies it.
Contracts live in `packages/shared` as they ship.
