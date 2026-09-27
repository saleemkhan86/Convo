# Convo API Reference (v0.1 — Phase 1)

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

## Planned (later phases)

Conversation/message endpoints (Phase 2), mail threads + composer endpoints
(Phase 3), external email gateway webhooks/queue (Phase 4), attachments,
search, contacts (Phase 5). Contracts will live in `packages/shared` as they
ship.
