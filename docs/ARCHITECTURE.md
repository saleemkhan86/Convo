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

### 3.1 Groups, statuses and media (Phase 4B)

- **Groups are conversations.** `Conversation(type=GROUP)` plus a 1:1
  `GroupProfile` side-car holds the group-only fields (visibility, whoCanSend /
  whoCanEdit, announceOnly, requireApproval, inviteCode). Every existing chats
  route — list, timeline, send, `/ws` fan-out — therefore works for groups
  unchanged, and `ConversationSummary.group` carries the badge data (member
  count, my role, send rights) so clients never need a second round-trip to know
  whether the composer is locked.
- **Join requests are membership states, not a separate table.**
  `ConversationMember.joinState` (`ACTIVE` / `PENDING` / `REJECTED`) encodes
  "waiting for an admin". PUBLIC groups activate on entry; PRIVATE groups park
  the applicant as `PENDING` and notify online admins with
  `group.joinRequest.new`. Approval flips the row to `ACTIVE` and pushes
  `group.joined` to the applicant only.
- **Authority stays server-side.** `assertCanPost` re-reads the group profile on
  every send, so announce-only / admins-only is enforced even if a client is
  patched; membership checks live in `services/groups.ts`, not the routes.
  Roster and invite codes are withheld from non-members, and a non-member
  previewing a PRIVATE group gets a generic 404 (no enumeration oracle).
- **Statuses are their own entity, media is a shared service.** `Status` +
  `StatusView` implement ephemeral posts with audience privacy; the audience rule
  (`matchesAudience`) runs at fan-out *and* on read, so a `CUSTOM`/`CONTACTS_EXCEPT`
  status is filtered again if the contact book changes after posting. Expiry is
  lazy (filter on read + purge the author's own expired rows on list) rather than
  cron-based, which keeps the deploy story single-process.
- **`MediaStorage` is a seam, like `EmailProvider`.** `local` (files under
  `.data/media`, keys sharded by prefix and validated against traversal) or
  `supabase` (bucket + service-role key, server-side only). Clients receive a
  short-lived JWT scoped to one storage key (`{ media: key }`) instead of
  provider credentials, so `<img>`/`<video>` tags work without headers and a
  leaked URL dies with its TTL. Swapping to S3 later touches one file.

### 3.2 Chat controls, contacts and safety (Phase 5A)

- **Moderation state is per-viewer, on the membership row.** Pin, archive, mute,
  clear, delete-for-me and read state all live on `ConversationMember`
  (`pinned`/`archived`/`mutedUntil`/`clearedAt`/`hidden`/`hiddenAt`). One row per
  member means one user's "delete chat" can never erase history for the peer,
  and it keeps every 5A endpoint to a single indexed update plus a re-summary —
  no new tables per control.
- **Watermarks instead of deletes.** *Clear chat* stores `clearedAt` and every
  read path adds `createdAt > clearedAt`; *delete for me* sets `hidden`, which
  `sendMessage` clears again when new activity arrives. The message rows are
  untouched, so the other side's timeline is byte-identical, and un-archiving or
  a new message restores the chat without any reconstruction. Moving the
  `lastReadAt` watermark with `clearedAt` is what stops a cleared chat from
  showing an unread badge for messages the user just asked to forget.
- **Stars are per-user bookmarks.** `StarredMessage(messageId, userId)` mirrors
  how reactions are stored, so `serializeMessage` answers `starredByMe` from the
  viewer's own rows and `GET /starred` can list across chats newest-star-first —
  while still hiding stars behind a clear-chat watermark.
- **Blocking withholds, it never announces.** `blockedRecipients` runs inside
  `sendMessage`: the message is inserted and the sender gets HTTP 200, but no
  receipt is recorded and nothing is published on `/ws`, so the blocked sender
  sees a permanent single tick. Reporting an unknown number and starting a chat
  with one return the *same* generic 404, so neither path can be used to test
  whether a phone has a Convo account (spec §28–30).
- **Contacts are an owner-private address book.** `Contact(ownerId, phone|email)`
  with best-effort `convoUserId` resolution against **verified, active** identity
  rows only — an address-book typo can never claim somebody else's account.
  `GET /contacts/recent` derives WhatsApp's "message new chat" suggestions from
  membership recency rather than a separate table.
- **Search stays `ILIKE '%q%'`.** Every 5A search path (`?q=` in a chat,
  `GET /search`) is a case-insensitive substring match scoped to rows the caller
  can already see. Full-text or `pg_trgm` needs an index and a migration policy
  on a shared cloud database, and at this data volume a `LIMIT`-bounded scan is
  the cheaper, honest answer (see §8).
- **No new socket events.** These are private, quiet mutations: broadcasting them
  would leak per-viewer state (who archived what) into a fan-out message. Clients
  re-pull the affected list, which also means a control applied on the web shows
  up on the phone on the next fetch without a protocol change.

### 3.3 Chat media messages (Phase 5B)

- **References, never bytes.** A media send uploads first (`POST /media/upload`,
  the 4B path) and then posts the returned `storageKey`. `AttachmentInput`
  carries only the key plus cosmetic metadata; kind, MIME type and size are read
  back from the server's `MediaObject` row, so the client cannot mislabel a
  file, and the row's `ownerId` check means a key harvested from someone else's
  chat is worthless. `Message.type` is derived server-side from the first
  attachment's kind — the wire never trusts a client-claimed media type.
- **Forwarding shares storage.** A forward re-delivers the same `storageKey` as
  a new `Attachment` row in the target chat — no byte copy, which is why 20
  messages into 20 chats stays cheap (capped at 100 deliveries). The trade-off
  is that deleting a forwarded copy never frees the bytes — unreferenced
  objects join the same un-swept backlog as expired status media (§8), which
  is safe because downloads are signed per key anyway.
- **View-once is enforced by payload shape.** `serializeAttachments` nulls
  `mediaUrl` whenever `viewOnce` is set, so *every* read path — timeline, chat
  preview, search, gallery — is URL-less by construction; the only endpoint
  that can mint view-once bytes is `POST /messages/:id/view-once`. The single
  view itself is the unique `ViewOnceView(messageId, userId)` row: the insert
  is the check, and the P2002 race between two devices answers 409 exactly
  like a sequential second open. Clients therefore never "delete after read" —
  they simply never received a URL to begin with.
- **Reply quotes are frozen snapshots.** `replyPreview` (JSON on the message
  row) is taken at send time, so a quote keeps rendering after the original is
  edited, deleted, or hidden behind a clear-chat watermark — and a quote of
  view-once media deliberately drops the storage key, because the quote viewer
  did not earn the single view.
- **One new socket event.** `message.viewOnceOpened` fans out to all members
  (including the opener's other devices) because the *tile state* must change
  everywhere at once; the payload is intentionally URL-free, so the event
  cannot become a side channel around the one-view rule.
- **Mobile streams uploads, web does not.** React Native cannot build the
  multipart bodies the web `FormData` path uses, so mobile uploads via
  expo-file-system's native `File.upload` (a base64 JSON variant exists for
  statuses and stays). The offline outbox remains text-only: staged media lives
  behind a session-scoped object URL, so a media send that fails restores the
  composer tray instead of queueing bytes that could not survive a reload.

### 3.4 Link previews, GIFs and shares (Phase 5B extras)

- **Unfurl is post-send and fail-silent.** `services/unfurl.ts` runs *after*
  the message is delivered, fire-and-forget: a slow or hostile publisher can
  never delay or fail the send, and every failure path just yields no card.
  When it succeeds the JSON column is written and `message.linkPreview`
  fans out to all members — the card appearing later is the design, not a
  race clients must paper over.
- **SSRF is a resolve-then-refuse policy.** The URL comes from user text, so
  the server resolves the hostname itself (`dns.lookup` all records) and
  rejects loopback/private/link-local/CGNAT/benchmarking/multicast/ULA for
  IPv4 *and* IPv6, including `::ffff:`-mapped and 6to4-embedded IPv4 forms.
  Redirects are followed manually (≤3) and every hop re-runs the check, so a
  public URL cannot bounce into the intranet. `AbortSignal.timeout` plus a
  streaming byte cap bound the fetch. Preview images are fetched by the
  client, not the server, so they get the weaker literal-host screen — still
  enough to stop `og:image=http://169.254.169.254/…`.
- **GIFs become owned media, not CDN links.** Clients call `/giphy/search`
  and `/giphy/upload`; `GIPHY_API_KEY` lives only in the API environment and
  even the search response is stripped to our own `GiphyItem` shape. Upload
  downloads the bytes, runs `media.save`, and registers a `MediaObject` owned
  by the caller (`rememberUpload`) — from that point a GIF is exactly a photo
  attachment (same keys, signed URLs, GC, ownership checks). This is also why
  forwarded stickers keep working: nothing references giphy.com.
- **LOCATION/CONTACT are payload messages, not media.** They ride JSON
  columns on `Message` (type derived server-side like every other media
  type) and pass through forwarding by value. A message carries either one,
  never both — enforced in the shared schema *and* the service, because the
  service is also the entry point for future server-generated shares.
  Contact cards are frozen copies of what the sharer already sees, so sharing
  leaks nothing beyond the sharer's own contact book.
- **Auto-download is a client hint.** `User.mediaAutoDownload`
  (`ALWAYS`/`WIFI_ONLY`) surfaces on `Account` and gates only whether the UI
  auto-fetches heavy tiles; the API mints signed URLs regardless, keeping the
  server free of per-network policy.

### 3.5 Privacy and security (Phase 5C)

- **Privacy is resolved from the owner's row, at the edge.** `services/privacy.ts`
  owns the four-way rule (`EVERYONE` / `CONTACTS` / `CONTACTS_EXCEPT` / `NONE`)
  and exposes `fieldVisibleTo` (pure, unit-tested) plus `fieldVisibleToUser`
  (same rule + the contact lookup). Every serializer that can leak a facet —
  `peerOf`, `getUserCard`, presence, receipts — calls it, so no endpoint trusts
  a client claim and hiding stays indistinguishable from empty. A corrupt
  `visibilityExcluded` column reads as "nobody hidden", the narrower exposure of
  the two possible mistakes.
- **Group adds fail quietly.** `mayAddToGroup` drops targets whose
  `groupAddVisibility` forbids it instead of returning an error, because an
  error would turn group creation into a probe for who restricted themselves.
- **Two-step verification is a second login leg.** `AuthResult` became a union:
  the session branch, or `twoFactorRequired` with a one-time token. The PIN is
  scrypt-hashed (`salt:hash`) on `User.twoFactorHash`; the token is a hashed
  `VerificationChallenge` with purpose `TWO_FACTOR` (10 min, 5 attempts, consumed
  on use, looked up by `findFirst` since `codeHash` is not unique) and shares the
  OTP rate limiter. Clients narrow with `"session" in result`.
- **Disappearing messages are stamped, not scheduled.** `Conversation.ephemeralSeconds`
  sets `Message.expiresAt` at send and at forward; removal is lazy (history reads
  filter through `visibleToViewer`), per-conversation on demand, and on a global
  sweep timer. `message.expired` / `conversation.ephemeralChanged` keep clients
  honest without a server-side cron per message. A new 1-1 chat takes the
  **shorter** of the two participants' defaults.
- **Export is a JSON transcript, never a ZIP.** `exportChat` respects
  `deletedAt` and the viewer's `clearedAt`, caps at 25 000 messages, and hands
  out short-lived signed `mediaUrl`s on request (view-once excluded). Keeping the
  archive client-side avoids adding an archive dependency and any server temp
  files to the API.
- **App lock state is a client mirror.** `User.clientSettings.appLock` stores
  `enabled`/`biometric`/`timeoutSeconds` plus a salted SHA-256 PIN digest the web
  client computes in `PrivacySecurity.tsx`; the raw lock PIN never crosses the
  wire. Mobile cannot hash it (React Native has no `SubtleCrypto` and no crypto
  dependency is installed), so the on-device lock screen is deferred — see
  docs/TODO.md.
- **Sessions, devices and the deletion window.** `services/security.ts` lists
  sessions with the bearer's own flagged `current` (from the JWT `sid` claim,
  never a client header), revokes one or all-others, upserts push registrations,
  and runs deletion as a soft two-step: `deletionRequestedAt` + a grace period in
  which sign-in still works and cancels, then `sweepExpiredAccounts` anonymises
  (messages survive with a null sender) and deletes.

### 3.6 Status parity (Phase 5D)

- **A status reply is a message, not a new message type.** `replyToStatus` opens
  (or reuses) the DIRECT chat with the author through the same `openDirectChat`
  helper that starting a chat uses, then calls `sendMessage` with
  `statusReplyToId`. The row gains one marker column, `Message.statusReplyId`
  (`onDelete: SetNull`), and reuses the existing `replyPreview` JSONB snapshot —
  re-signed at read time — for the quote strip. So receipts, edits, deletes,
  forwarding and offline search all work on status replies for free, and no new
  WS event was needed.
- **Replying never probes.** Unknown, expired and not-in-audience statuses all
  answer `404 Status not found` from the same branch, and answering your own
  status is the only distinct error. The audience check reuses `matchesAudience`
  with the author's contact set, so a reply cannot reach a chat the status was
  never visible in.
- **Receipts off means nothing is written.** `Status.shareReadReceipts` is read
  before `markStatusViewed` inserts: with it off there is no `StatusView` row and
  no `status.viewed` push, so there is no data later to leak. The privacy
  promise outranks the viewer's own seen-ring, which stays client-local (the
  client still marks it seen optimistically).
- **Mutes are private state, filtered twice.** `StatusMute(userId, authorId)` is
  keyed by the viewer, emits no socket event (the 5A/5C precedent for per-viewer
  moderation), and is applied both in `listStatuses` and inside `fanOutNewStatus`
  — otherwise a muted author's ring would keep lighting up until the next pull.
  Clients also filter locally and optimistically, and closing the viewer after a
  mute avoids the index shift the filtered feed would otherwise cause.

### 3.7 Group parity (Phase 5E)

- **Mentions are resolved server-side, from the group's own roster.**
  `services/mentions.ts` matches `@<display name>` (and, for two-word names, the
  first word) against the ACTIVE members of *that* conversation, so the client
  never declares "I mentioned user X" — that would let anyone mint a notification
  for a stranger. The pattern is anchored (`(?<![\w.+-])@…(?![\p{L}\p{N}])`) so
  an email address or an `@handle.inside.a.word` never fires, and `"@Sam"` cannot
  light up a member called "Sammy". Matches are longest-candidate-first and
  de-duplicated, so "@Sammy Khan" is one mention, not two.
- **The unread-mention badge is a watermark query, not a counter.**
  `ConversationSummary.unreadMentions` counts `MessageMention` rows for the
  viewer after `unreadWatermark(lastReadAt, clearedAt)` and excludes their own
  messages. Marking the chat read therefore clears the `@` badge on every device,
  and edits — which rebuild `mentions` but keep the original `createdAt` — cannot
  re-badge a chat that was already read.
- **A pin is shared, a star is not.** `MessagePin` is one row per message
  (unique on `messageId`) with `pinnedById`/`pinnedAt`, and the upsert uses
  `update: {}` so the *first* pin keeps its author and ordering even if a second
  member re-pins. Any member may pin (`requireMembership`, not admin-only) but
  only for a message that isn't deleted. Because the state is shared, fan-out
  uses `fanOutAll` (actor included, unlike `fanOut`), so the actor's other
  devices converge on the same banner, and `GET /conversations/:id/pins` reuses
  the standard `visibleToViewer` filter so a cleared or hidden-for-me message
  never shows up in someone's pin list.
- **The group icon rides the existing media pipeline.** `GroupProfile.avatarStorageKey`
  (uuid, FK-checked against `MediaObject` and owned by the caller) is signed
  per-read through the same `mediaUrl(key)` used by chat attachments, and
  `avatarUrl` in every payload is that short-lived URL — the key never leaves the
  server. Groups that only ever had a plain `avatarUrl` string keep working: the
  key takes precedence, the column is the fallback.
- **`whoCanInvite` gates the *link*, not the join.** The setting decides whether
  `summaryOf` puts `inviteCode` in the payload (`mayInvite(role, settings)`), so
  members of an admins-only group have nothing to screenshot or resend, while a
  code already in the wild still redeems normally. Hiding it in the UI instead
  would be a preference, not a control.
- **The Links tab reads stored cards.** `GET /conversations/:id/links` walks the
  `linkPreview` JSONB column the 5B extras unfurler already wrote instead of
  re-scraping, so the tab is one indexed query and can never be used to make the
  server fetch a URL. Rows whose card has no usable `url` are dropped in code,
  keeping the JSON filter portable.
- **Clients keep the parity surface symmetrical.** Web (`ChatsSection.tsx`) and
  mobile (`ChatRoomScreen.tsx`) both render the pin banner + pins sheet, the
  roster-driven `@` typeahead, mention pills, the unread-mention badge, and the
  multi-select forward bar; mobile jumps to a pinned message with
  `View.measure` → `ScrollView.scrollTo` because the new architecture has no
  reliable named scroll.

### 3.8 Calling (Phase 5F)

- **The server never touches media.** Voice/video is peer-to-peer WebRTC; the API
  owns exactly three things — the call *record*, the state machine that decides
  who may answer or hang up, and the signaling relay. That is why calling needs
  no media server, no transcoding and no new infrastructure to ship 1-1 calls,
  and why `Call` rows survive a client that dies mid-ring.
- **The log is written before the socket speaks.** Every transition goes through
  a Prisma `update` (with its `CallEvent` append) and only then fans out frames,
  so a dropped socket can always be reconstructed from the record. Start/end
  transitions are also plain REST (`POST /calls`, `/accept`, `/decline`,
  `/hang-up`) because those must survive retries; only the time-critical path —
  SDP/ICE — rides `/ws`, where a ring never waits on an HTTP round trip. The two
  entry points call the same service functions, so a client may use either.
- **Dialing is idempotent, and busy is decided up front.** A repeated
  `POST /calls` while the caller's own call is live returns that call instead of a
  second row (a lost response must not create two log entries for one dial), and
  a peer who is busy elsewhere is rejected before a row is written — better to
  tell the caller now than to leave an overlay no device will ever answer.
- **Credentials never ride the socket.** `call.incoming` carries no ICE config;
  the callee fetches `GET /calls/ice-config` with its own token. TURN uses
  coturn's time-limited REST credential — `username = "<expiry>:<userId>"`,
  `credential = base64(HMAC-SHA1(TURN_SECRET, username))` — minted server-side,
  so the shared secret never leaves the API and a leaked credential expires on its
  own. Boot fails if `TURN_URLS` is configured without `TURN_SECRET`, because a
  relay nobody can sign into is a silently broken call path.
- **SDP is persisted, ICE candidates are not.** Offers and answers land in
  `CallEvent` for support disputes and reconnect replays; candidates arrive in
  bursts of dozens, and one that lands after the call ended is worthless — so
  `relayCallSignal` checks status *before* relaying, and a terminal call answers
  400 rather than forwarding stale signaling.
- **Expiry is a sweep, not a timer.** `sweepStuckRings` runs on an interval
  (`CALL_SWEEP_SECONDS`) and turns rings older than `CALL_RING_TIMEOUT_SECONDS`
  into `MISSED`. A per-call `setTimeout` would be lost on restart and would leave
  a callee staring at a modal after the caller's tab died.
- **`direction` is derived, never stored.** One row serves both histories:
  `serializeCall(row, viewerId)` computes `OUTGOING`/`INCOMING` and picks the
  callee out of the participants, which is why the terminal `call.ended` frame is
  published once per side rather than once per call.
- **The missed-call badge reuses the read watermark.** `missedCallCount` compares
  each `MISSED` row against that chat's `lastReadAt` (the 5E pattern) instead of a
  counter column, so opening the chat clears the badge on every device, and calls
  the viewer placed (`callerId: { not: userId }`) never count against them.
- **Privacy rules are inherited, not re-invented.** Blocked pairs get the same
  unexplained 403 as 5A (cutting both ways, no hint of which way), a stranger to
  the chat gets the same 404 as any other conversation read, and groups are
  refused outright — 5F is 1-1 only, though `CallParticipant` is already a
  per-member table so group calls add no schema.
- **Mobile degrades instead of crashing.** `react-native-webrtc` is a native
  module, so `src/webrtc.ts` lazy-`require`s it inside a try/catch: Expo Go keeps
  running and the UI says "needs a development build" rather than white-screening
  at import. The call engine is a module store (`useSyncExternalStore`) with the
  overlay mounted in `App.tsx`, because the app has no provider tree and a ring
  has to be able to interrupt whatever screen is on top.
- **Background ringing is deliberately not here yet.** A call arriving at a
  closed app needs FCM/APNs, which is 5G; the state machine, the missed-call row
  and the sweep already model it correctly for when the transport lands.

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
  Phase 5A adds the chat-control menu (pin/archive/mute/clear/delete), the
  in-chat search bar, and the starred / contacts / blocked / contact-info /
  report dialogs — all of them re-pull rather than subscribe to new events.
- **Mobile** — Expo (React Native). Tokens in `expo-secure-store`
  (encrypted). Same @convo/shared contracts. State-machine navigation for
  the skeleton; expo-router or react-navigation when screens multiply.
  Android API URL via `EXPO_PUBLIC_API_URL` (emulator default 10.0.2.2).
  Phase 4B adds `GroupInfoScreen`, `GroupDirectoryScreen`, `StatusScreen` and
  native media through `expo-image-picker` (base64 straight to
  `POST /media/upload`, since RN cannot stream multipart from the camera roll)
  and `expo-video` for status playback — both stay Expo-Go compatible.
  `resolveMediaUrl` in `src/api.ts` rebases signed media URLs onto the API
  origin, because a device reaches the dev API through the LAN address rather
  than the `localhost` the server stamped into the URL.
  Phase 5A adds `ContactsScreen`, `StarredScreen`, `SearchScreen` and
  `UserCardScreen`, plus `src/components/ChatControls.tsx`, which owns the
  bottom-sheet chat menu (pin/archive/mute/clear/delete/report), the confirm
  sheet and the reusable `Sheet` primitive. Long-press is the mobile equivalent
  of the web context menu, and both clients share one action type so the
  mapping to `PATCH /conversations/:id` lives in exactly one place.
  Phase 5C adds the privacy + security panels on both clients
  (`apps/web/src/components/PrivacySecurity.tsx`,
  `apps/mobile/src/components/PrivacySecurity.tsx`): per-field visibility
  pickers with the contact exception list, group-add and read-receipt rules,
  the default disappearing timer, app lock (web only), the 2FA PIN, sessions,
  devices and the deletion window. The login forms grew a PIN step that appears
  only on the `twoFactorRequired` branch, and the chat menus gained a
  disappearing-timer picker plus export.

## 7. Security posture (spec §29–30)

- OTP codes hashed (SHA-256) + timing-safe compare; attempt caps; cooldowns.
- Login PINs scrypt-hashed with a per-account salt and compared
  timing-safe; the 2FA exchange token is hashed, attempt-capped and shares the
  OTP rate limiter.
- Refresh-token rotation with revocation; JWT lifetime kept short.
- Rate limiting global (300/min) + strict per auth route (5–10/min).
- Zod validation of every request body at the boundary; server-side authority
  for all state.
- `DEV_EXPOSE_OTP` is refused by config loader in production.
- CORS restricted to configured origins. No secrets in client bundles;
  email credentials server-side only.
- Call signaling is relayed only between the two participants of the call
  (`requireCall` checks membership before anything is forwarded), SDP is capped
  at 256 KiB per frame, and TURN credentials are per-user HMACs that expire
  (`TURN_CREDENTIAL_TTL_SECONDS`) — the relay's shared secret never reaches a
  client.

## 8. Deliberate simplifications (documented per spec §37)

| Decision | Rationale |
|---|---|
| SMS OTP is logged, not sent | No SMS provider chosen yet; interface isolated in `services/challenges.ts#dispatchCode` so a Twilio/MSG91 adapter drops in without flow changes. |
| Web tokens in localStorage, not httpOnly cookies | SPA + mobile parity; revisit with cookie sessions if XSS risk profile demands it. |
| Single-region Postgres, no read replicas | Right-sized for MVP; schema is horizontally shippable later. |
| Mail/Chats lists are empty states in Phase 1 | Messaging features are Phase 2–4 per spec §35. |
| Status/media expire lazily, not on a schedule | No cron runner in a single-process deploy; reads filter `expiresAt` and each author purges their own expired rows. Stored bytes of *other* people's expired statuses are not swept yet — a janitor job belongs with the Phase 5 scan pipeline. |
| Group settings are a fixed five-field profile | Mirrors the WhatsApp feature set the spec asks for (who can send/edit, announce-only, approval, visibility). Free-form permissions/roles would need a policy table with no product requirement yet. |
| Rejected join requests keep a `REJECTED` membership row | Prevents the same account from re-submitting through a leaked link without an admin ever seeing it; the row is hidden from the roster by `leftAt`. |
| Media download tokens share the API JWT secret | One signing key keeps the auth surface small, and the payload is `{ media: key }` with no `sub`, so it cannot authenticate anything but that one file. Move to a dedicated key/audience if media URLs ever outlive the 6h TTL default. |
| 5A search is `ILIKE` substring, not FTS/`pg_trgm` | No index build or extension on the shared cloud Postgres, and search is bounded to the caller's own rows plus a `LIMIT`. Revisit with a GIN index once message volume makes scans slow. |
| 5A controls emit no socket events | Per-viewer moderation state (archive, mute, hide-for-me) is private; broadcasting it would leak state about someone else's chat list. Re-pulling on focus is correct and cheaper. |
| 5D status replies reuse `replyPreview` instead of a second quote column | The strip, its media re-signing, its survival past deletion and every message-side feature already work on that snapshot; one nullable `statusReplyId` adds only the "Status reply" label. A dedicated reply table would duplicate all of it. |
| 5D receipts-off records no view at all | `shareReadReceipts: false` is a promise about data that does not exist; writing the row and hiding it in the API would keep the leak one bug away. The viewer's seen-ring becomes client-local as the cost. |
| 5D muting is a `(userId, authorId)` row, filtered on read and on fan-out | Mute is one-way and private (WhatsApp does not tell the author), so no event and no reverse lookup; filtering the push as well stops a muted ring from lighting up between pulls. |
| App lock is enforced client-side only (web) | The server stores just the mirror (`enabled`/`biometric`/`timeout` + a salted digest the page computed), so it can neither verify the PIN nor be the thing that unlocks the app — a lock screen is inherently local. Mobile is deferred: React Native has no `SubtleCrypto` and adding a crypto dependency + native biometrics is a development-build change, not an Expo-Go one. |
| Contact resolution only matches verified, active identities | A saved (unverified) address must never resolve to someone else's account, and a deactivated account should not linger in the book as if reachable. |
| No media garbage collection | `Attachment` rows reference shared `MediaObject` keys (re-sends and forwards never copy bytes), so deleting a message cannot safely delete the file. A reachability sweep belongs with the same janitor job as expired status bytes. |
| 5F calling is mesh 1-1 only, with no SFU | A `Call` is bound to a DIRECT conversation and signaling is relayed between exactly two participants. An SFU (mediasoup/LiveKit) is real infrastructure with a different deployment story, and the spec's parity target is 1-1 calls; group calling is 5G, where `CallParticipant` already gives the roster. |
| 5F rings only while the app is open | Background ringing needs FCM/APNs, which is 5G. The record does not: the sweep turns an unanswered ring into `MISSED`, so the history and the badge are correct without a push channel. |
| 5F media on mobile needs a development build | `react-native-webrtc` is a native module, so it is `require`d lazily inside a try/catch (`src/webrtc.ts`): Expo Go keeps running and the call UI states the limitation instead of crashing at import. A hard dependency at the top of the module would white-screen every Expo-Go session. |
| TURN is configured, not deployed | The credential-minting path is shipped and unit-tested, but no coturn server runs in the dev stack, so two peers on different NATs cannot connect yet. Without `TURN_URLS` the config is STUN-only, which still connects a browser and an emulator on one LAN. |
