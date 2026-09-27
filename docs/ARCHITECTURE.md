# Convo — Architecture & Decision Log

This document records the architecture and the decisions taken before
implementation began, as required by the product spec (§37).

## 1. Product model

One Convo account holds **at most one phone identity** and **at most one email
identity**, both optional. Identities never create separate accounts; the
second identity is *connected* to the existing account only after OTP proof of
ownership (spec §3–5, §32).

```
users ──┬── phone_identities (unique phone, unique userId)   → unlocks Chats
        └── email_identities (unique email, unique userId)   → unlocks Mail
```

Capabilities are derived, never stored: `chats = has phone identity`,
`mail = has email identity` (`capabilitiesOf` in `packages/shared`).

## 2. Monorepo layout

```
apps/api       Fastify + Prisma + PostgreSQL (TypeScript, ESM)
apps/web       Vite + React 19 + Tailwind CSS v4
apps/mobile    Expo SDK 57 (React Native), shares @convo/shared
packages/shared  Zod schemas + API contract types (single source of truth)
```

**Decision: Expo over Kotlin-native or Flutter.** Shared TypeScript with the
web app and the API contracts satisfies the spec's "shared backend models, API
contracts and business logic where practical" with the least duplication.

## 3. Backend

- **Fastify 5** — HTTP API, plugin-based (`@fastify/jwt`, `@fastify/cors`,
  `@fastify/rate-limit`).
- **Prisma + PostgreSQL** — full relational schema in
  `apps/api/prisma/schema.prisma` covering all entities from spec §31,
  including future-phase tables (conversations, messages, email threads,
  delivery events, reports, audit logs) so migrations stay linear.
- **Auth** — OTP-based passwordless login (flows A–D). 6-digit codes,
  SHA-256-hashed at rest, 10-minute TTL, 5 attempts max, 60-second resend
  cooldown, per-route rate limits. Access = short-lived JWT (HS256, 15 min);
  Refresh = opaque 384-bit token, hashed in DB, rotated on every use,
  revocable per session (spec §27 active sessions).
- **Identity linking (flow E)** — `services/identity.ts`. Linking requires a
  verified OTP challenge bound to the signed-in user. Conflicts
  (`IDENTITY_LINKED_TO_ANOTHER_ACCOUNT`) are refused with a non-enumerating
  message; no automatic merging, ever (spec §5). Race-safe via transaction +
  unique constraints.
- **Audit logging** — sensitive operations (`auth.*`, `identity.connect.*`)
  write to `audit_logs` (spec §29).

## 4. Email gateway (spec §13–16)

- `EmailProvider` interface (`apps/api/src/email/provider.ts`):
  `sendEmail`, `parseEmail`, `handleWebhook`. Adapters are swappable;
  credentials only ever live server-side.
- **MVP adapter: generic SMTP via nodemailer** (`SmtpProvider`), validated
  locally against Mailpit (`docker compose up mailpit`, SMTP :1025, UI :8025).
  A `ConsoleEmailProvider` logs instead of sending when SMTP is unconfigured
  (dev only; production requires SMTP_HOST).
- **Routing decision (spec §16)** — `services/mailRouting.ts` resolves a
  recipient: known Convo email identity → `CONVO_INTERNAL`, else
  `EXTERNAL_SMTP`. This resolver is internal-only; no public endpoint exposes
  whether an address belongs to a Convo user (enumeration protection).
- **Threading (spec §15)** — `email_messages` stores `internetMessageId`,
  `inReplyTo`, `references[]`; the SMTP adapter passes these headers through.
- **Inbound bridge** — external replies arrive via IMAP polling or provider
  inbound webhooks in Phase 4 (`parseEmail`/`handleWebhook` slots already
  defined). See docs/TODO.md.
- **Abuse prevention (spec §30)** — `email_send_usage` daily per-user counter
  (`EXTERNAL_EMAIL_DAILY_LIMIT`), queue-based sending, OTP-verified
  identities only.

## 5. Realtime (Phase 2 design)

WebSocket gateway planned on Fastify (`@fastify/websocket`), topic per
conversation; delivery/read receipts via `message_receipts`; client-generated
`clientMessageId` gives idempotent retries (unique per sender) so reconnects
never duplicate messages (spec §22–23).

## 6. Clients

- **Web** — React 19 SPA, React Router, Tailwind v4 design tokens
  (`apps/web/src/styles/globals.css`): iris primary + cyan signal accent,
  class-based dark mode. Token storage in `localStorage` with single-flight
  auto-refresh on 401. Desktop 3-column layout (nav rail / conversation /
  details), collapsing to bottom tabs on mobile browsers (spec §25).
- **Mobile** — Expo (React Native). Tokens in `expo-secure-store`
  (encrypted). Same @convo/shared contracts. State-machine navigation for
  the skeleton; expo-router or react-navigation when screens multiply.
  Android API URL via `EXPO_PUBLIC_API_URL` (emulator default 10.0.2.2).

## 7. Security posture (spec §29–30)

- OTP codes hashed (SHA-256) + timing-safe compare; attempt caps; cooldowns.
- Refresh-token rotation with revocation; JWT lifetime kept short.
- Rate limiting global (300/min) + strict per auth route (5–10/min).
- Zod validation of every request body at the boundary; server-side authority
  for all state.
- `DEV_EXPOSE_OTP` is refused by config loader in production.
- CORS restricted to configured origins. No secrets in client bundles;
  email credentials server-side only.

## 8. Deliberate simplifications (documented per spec §37)

| Decision | Rationale |
|---|---|
| SMS OTP is logged, not sent | No SMS provider chosen yet; interface isolated in `services/challenges.ts#dispatchCode` so a Twilio/MSG91 adapter drops in without flow changes. |
| Web tokens in localStorage, not httpOnly cookies | SPA + mobile parity; revisit with cookie sessions if XSS risk profile demands it. |
| Single-region Postgres, no read replicas | Right-sized for MVP; schema is horizontally shippable later. |
| Mail/Chats lists are empty states in Phase 1 | Messaging features are Phase 2–4 per spec §35. |
