# Convo API Reference (v0.3 — Phase 3: Mail)

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
  "createdAt": "2026-09-26T12:00:00.000Z"
}
```

`phone`/`email` are `null` until the identity is connected and verified.
`capabilities.chats` requires a phone identity; `capabilities.mail` requires an
email identity.

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

`AuthResult = { session: SessionTokens, account: Account, isNewAccount: boolean }`.

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
| PATCH | `/me/profile` | ✓ | `{ displayName?, avatarUrl?, bio? }` (null clears) | `Account` |

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
// ConversationPeer
{ "userId": "clx...", "displayName": "Alice", "avatarUrl": null, "phone": "+919800000001" }

// Message
{
  "id": "clx...", "conversationId": "clx...", "senderId": "clx...",
  "clientMessageId": "uuid", "type": "TEXT", "body": "Hi",
  "replyToId": null, "editedAt": null, "deletedAt": null,
  "createdAt": "2026-09-26T12:00:00.000Z"
}

// ConversationSummary
{
  "id": "clx...", "type": "DIRECT", "title": null,
  "peer": { /* ConversationPeer */ }, "lastMessage": { /* Message */ },
  "unreadCount": 2, "pinned": false, "archived": false, "mutedUntil": null,
  "lastReadAt": "2026-09-26T12:00:00.000Z",
  "lastMessageAt": "2026-09-26T12:05:00.000Z"
}
```

### REST endpoints

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| POST | `/conversations/start` | `{ phone }` (E.164) | `ConversationSummary` |
| GET | `/conversations` | `?cursor?&limit=50` (1–100) | `{ conversations: [...], nextCursor }` |
| GET | `/conversations/:id/messages` | `?cursor?&limit=50` | `{ messages: [...], nextCursor }` (oldest-first page) |
| POST | `/conversations/:id/messages` | `{ clientMessageId, body, replyToId? }` | `Message` |
| POST | `/conversations/:id/read` | `{ messageId? }` (defaults to latest) | `{ ok: true }` |

Semantics:
- `start` is idempotent — starting with the same peer returns the existing DIRECT
  conversation. Unknown/inactive/self/blocked targets all return a single
  non-enumerating 404 "No Convo account found for that phone number".
- Message `body` is trimmed, 1–4096 chars. `clientMessageId` must be a UUID and is
  unique per sender; reusing one in a different conversation returns 400.
- Pagination cursors are opaque; pass `nextCursor` back as `cursor` for the next page.
- Rate limits: `start` 30/min, send message 120/min.

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

Server → client:

| `type` | Payload |
|---|---|
| `ready` | `{ userId }` |
| `pong` | – |
| `message.new` | `{ message }` — fanned out to the conversation's other members. |
| `message.read` | `{ conversationId, userId, readAt }` |
| `typing` | `{ conversationId, userId, isTyping }` |
| `presence` | `{ userId, online }` — emitted on online-state transitions for watched users. |
| `mail.new` | `{ thread, message }` — a new mail landed in the recipient's own mailbox (see Mail below). |

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

## Planned (later phases)

External email gateway — SMTP send + IMAP/webhook ingest draining the `QUEUED`
recipients (Phase 4), attachments, search, contacts, groups (Phase 5).
Contracts live in `packages/shared` as they ship.
