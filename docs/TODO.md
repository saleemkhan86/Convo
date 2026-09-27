# Convo — Deferred Features (TODO)

Tracked against the MVP phasing in spec §35. Phase 1 (architecture, database,
auth, identity model, profile) is implemented; everything below is deferred by
design, not forgotten.

## Phase 2 — Phone Chats
- [ ] WebSocket gateway (`@fastify/websocket`), per-conversation topics
- [ ] One-to-one conversations + messages API (schema ready: `conversations`,
      `conversation_members`, `messages`, `message_receipts`)
- [ ] Offline outbox + idempotent send retries (`clientMessageId` unique per sender)
- [ ] Sent/delivered/read states, unread counts, typing indicator, presence
- [ ] Push notifications (FCM) + web push; `devices` table ready
- [ ] Group chats, reactions, reply/edit/delete/forward
- [ ] Media messages: images, video, documents, voice notes (object storage +
      `attachments` table ready, `scanStatus` column for malware-scan pipeline)

## Phase 3 — Mail (Convo-to-Convo)
- [ ] Mail thread list + conversation timeline UI (chat-style, spec §10, §17)
- [ ] Mail composer with collapsible subject (spec §18)
- [ ] Internal routing: `resolveMailRoute` → realtime delivery for Convo
      email identities, mirrored into `email_messages` with threading headers

## Phase 4 — External email gateway
- [ ] `SmtpProvider.parseEmail` — RFC 822 parsing (mailparser) for inbound
- [ ] Inbound bridge: IMAP polling worker and/or provider inbound-parse
      webhook → map into threads via `References`/`In-Reply-To` (spec §13)
- [ ] Queue-based sending with retry + bounce handling
      (`email_delivery_events` ready)
- [ ] SPF/DKIM/DMARC provisioning for the sending domain
- [ ] Additional provider adapters (Resend/SendGrid/Postmark) behind
      `EmailProvider`
- [ ] Subtle Convo branding footer on outgoing external mail (spec §12)

## Phase 5 — Attachments, search, contacts, settings
- [ ] Object storage (S3-compatible) + expiring private download URLs
- [ ] MIME validation, size limits, malware scanning pipeline
- [ ] Global search across Chats/Mail/Contacts/Groups (spec §20; consider
      Postgres FTS first, dedicated engine later)
- [ ] Contacts sync (explicit permission, secure identity matching) +
      recent-recipient autocomplete (spec §21)
- [ ] Full Settings: privacy (last seen, read receipts, contact discovery),
      notification prefs per conversation/global, storage management,
      active sessions UI with revoke, account recovery flows (spec §34)

## Phase 6 — Platform polish
- [ ] Android: push, background sync, camera/gallery pickers, deep links
      (`convo://` scheme registered), share sheet, tablet layouts
- [ ] Web: keyboard shortcuts, PWA install, notification permissions
- [ ] Multi-device session sync, message history pagination (cursor-based)

## Phase 7 — Hardening & launch
- [ ] Pen-test pass: enumeration, IDOR, rate-limit evasion, abuse flows
- [ ] Sending reputation controls: warm-up limits for new accounts,
      suspicious-activity detection, device/IP throttling (spec §30)
- [ ] Moderation: reports queue, block enforcement across Chats + Mail
- [ ] Load tests for realtime + email workers; alerting
- [ ] CI/CD, staged environments, backups/PITR for Postgres

## Known simplifications to revisit
- [ ] SMS OTP delivery adapter (Twilio/MSG91) — currently dev-logged only
- [ ] Web token storage: evaluate httpOnly-cookie sessions vs localStorage
- [ ] Replace hand-rolled mobile navigation with expo-router when screens grow
- [ ] Account merge/support flow for "identity already on another account"
      (deliberately blocked today; needs a verified-ownership merge protocol)
