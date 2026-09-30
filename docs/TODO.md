# Convo — Deferred Features (TODO)

Tracked against the MVP phasing in spec §35. Phases 1–3 core (architecture,
database, auth, identity model, profile, realtime 1-1 Chats and Convo-to-Convo
Mail on web + mobile) are implemented, plus **Phase 4A — chat options** (edit,
delete, reactions, receipt ticks, last seen), **Phase 4B — groups + status**
(public/private groups with admin-approved joins and WhatsApp-parity settings;
ephemeral text/photo/video/link statuses on top of the new media pipeline) and
**Phase 5A — chat controls, contacts, safety and search** (pin/archive/mute/
clear/delete-for-me, starred messages, address book + recent-recipient
autocomplete, block/unblock, reporting, in-chat and global search, contact-info
card) and **Phase 5B — chat media** (photo/video/document/voice messages,
view-once, forwarding, in-chat gallery, plus the extras: link previews, GIF
picker, stickers, location + contact-card share, media auto-download on web +
mobile) and **Phase 5C — privacy + security** (per-field profile visibility with
"my contacts except…", group-add and read-receipt rules, disappearing messages,
chat export, two-step verification PIN, active-sessions and linked-devices
management, and the account-deletion grace window) and **Phase 5D — status
parity** (replies that open a chat with the author, the author-side read-receipt
switch, muting an author's updates, and pause/seek in the viewer) and
**Phase 5E — group parity** (server-resolved @mentions with an unread badge,
shared pins with a banner and sheet, the Links tab, group icon upload, the
invite-link permission and multi-select forward) and **Phase 5F — calling**
(self-hosted WebRTC voice + video for 1-1 chats: call record and state machine,
signaling on the `/ws` gateway, minted TURN credentials, call overlay on web +
mobile, call history with missed-call badge). Phase 5 is now the WhatsApp-parity
push — see `docs/FEATURE-PARITY.md`
for the gap matrix and the remaining sub-phase (5G). Per
the re-scoped plan,
the former "Phase 4 external email gateway" moved to **Phase 6**; everything
below that is not checked is deferred by design, not forgotten.

> Testing posture: the build is being finished first, so **integration tests for
> 4A, 4B and Phase 5 sub-phases are deliberately deferred to the end-of-build
> test pass**. Today's verification is `pnpm -r lint` (tsc on api/web/mobile),
> `prisma migrate status`, and unit tests only. Mobile UI is type-checked but
> not exercised — Expo screens need an emulator/device.

## Phase 2 — Phone Chats
- [x] WebSocket gateway (`@fastify/websocket`), downstream fan-out via `RealtimeHub`
- [x] One-to-one conversations + messages API (`conversations`,
      `conversation_members`, `messages`; cursor pagination)
- [x] Offline outbox + idempotent send retries (`clientMessageId` unique per sender)
      — web persists to `localStorage`; mobile outbox is in-memory (see below)
- [x] Read states, unread counts, typing indicator, presence
- [x] Sent/delivered/read **receipt ticks per message** (`message_receipts`,
      Phase 4A) — surfaced as `Message.deliveryStatus` on your own messages
- [ ] Push notifications (FCM) + web push; `devices` table ready
- [x] Reply/edit/delete + reactions (Phase 4A: `PATCH`/`DELETE /messages/:id`,
      `PUT`/`DELETE /messages/:id/reactions`, `MessageHidden` for delete-for-me)
- [x] Pin / archive / mute / clear / delete-chat-for-me and starred messages
      (Phase 5A — per-viewer `ConversationMember` state + `StarredMessage`)
- [x] Forward (Phase 5B: `POST /conversations/forward`, by-reference copies
      stamped `forwardedFrom`; multi-select picker still open)
- [x] Group chats (Phase 4B: public/private entry, admin approval, roles,
      settings, invite links, discovery, system messages — see below)
- [x] Media messages: images, video, documents, voice notes (Phase 5B: chat
      `Attachment` rows on the reused `/media/upload` + `/media/:key` path,
      view-once, gallery — see Phase 5B below)
- [ ] Persist the mobile outbox across app restarts (needs AsyncStorage or a
      SecureStore chunking scheme; kept out of Phase 2 to stay Expo-Go runnable)
- [ ] Scale `RealtimeHub` beyond single-process `InMemoryHub` (Redis pub/sub
      adapter behind the existing interface)

## Phase 3 — Mail (Convo-to-Convo)
- [x] Per-owner mailbox model: `EmailThread`/`EmailMessage` carry `ownerId`,
      tied across mailboxes by a shared `threadKey`
- [x] Internal routing: `resolveMailRoute` → mirrored `INBOUND` copies with RFC
      5322 threading headers (`internetMessageId`/`inReplyTo`/`references`),
      realtime `mail.new` fan-out per recipient
- [x] Idempotent send (`clientSendId` UUID unique per owner) + reply threading
      with `Re:` subject reification
- [x] External recipients accepted and stored `QUEUED` (`EXTERNAL_SMTP`) for the
      Phase 4 gateway; route is never exposed to the client (anti-enumeration)
- [x] Shared contracts (`packages/shared/src/mail.ts`) + `mail.new` WS event
- [x] REST API: `GET /mail/threads`, `GET /mail/threads/:id/messages`,
      `POST /mail/send`, `POST /mail/threads/:id/reply`, `POST /mail/threads/:id/read`
- [x] Web Mail UI: thread list + chat-style timeline + collapsible-subject composer
- [x] Mobile Mail screens: thread list, composer, and reply timeline (Expo)
- [x] Owner-scoped unread watermark (`lastReadAt`) + unread counts
- [ ] External SMTP/IMAP delivery + inbound parsing — **Phase 6**
- [ ] Mail search folded into `GET /search` — **Phase 5G**
- [ ] Mail attachments, labels/folders — Phase 6

## Phase 4A — Chat options (WhatsApp/Telegram parity) ✅
- [x] Schema: `MessageHidden` (delete-for-me), `User.lastSeenAt` +
      `presenceVisibility` (`EVERYONE`/`CONTACTS`/`NONE`); reactions/receipts/
      `editedAt`/`deletedAt`/`replyToId` already existed
- [x] Shared: reaction aggregates (`reactedByMe`), `deliveryStatus`, peer
      `lastSeenAt`, edit/delete/react request schemas, `PresenceVisibility`
- [x] WS events: `message.edited` / `message.deleted` / `message.reacted` /
      `message.delivered`, presence transitions
- [x] API: edit (sender-only), delete for-everyone (clears body) / for-me
      (`MessageHidden`), reaction upsert/remove with aggregation, per-message
      receipt recording (delivered on fan-out, read on `markRead`), last-seen
      persisted on disconnect and privacy-gated in every read path
- [x] Web UI: hover actions (react/reply/edit/delete), emoji quick-react + chips,
      receipt ticks, reply quote, "edited" marker, online / last-seen subtitle
- [x] Mobile UI: long-press action sheet, reaction chips, ticks, reply/edit,
      delete-scope sheet, last-seen subtitle (no new native deps)
- [~] Integration tests (`chatOptions.test.ts`) written + docs — **not executed
      yet**; deferred to the end-of-build test pass (they truncate the shared
      dev database)

## Phase 4B — Groups + Status ✅
- [x] Schema: `GroupProfile` side-car on `Conversation(type=GROUP)` (visibility,
      whoCanSend/whoCanEdit, announceOnly, requireApproval, inviteCode +
      inviteRevokedAt), `ConversationMember.joinState`
      (ACTIVE/PENDING/REJECTED) for join requests, `Status` + `StatusView`
      (migration `20260929180000_add_phase4b_groups_statuses`, deployed)
- [x] Shared: group summary/detail/member + settings schemas and request
      bodies, status item/viewer + create-request schemas (per-kind validation,
      1–168h lifetime), `group.*` / `status.*` WS events
- [x] API: create/list/get/update/delete groups, add-by-phone, remove,
      promote/demote, leave (empty group is deleted), invite-code join, join
      requests (apply → admin approve/reject), discovery of PUBLIC groups,
      invite-link revocation; membership gates live in the service layer, and
      `assertCanPost` enforces announce-only / admins-only sends server-side
- [x] API: pluggable `MediaStorage` (local `.data/media` or Supabase Storage with
      the service-role key kept server-side), authenticated MIME/size-capped
      uploads (multipart **and** base64 JSON for React Native), downloads
      through a short-lived JWT bound to one storage key
- [x] API: statuses (text/photo/video/URL) with 24h default lifetime, audience
      privacy (EVERYONE / CONTACTS / CUSTOM / CONTACTS_EXCEPT) enforced on both
      fan-out and read, lazy expiry, idempotent view tracking, viewers list
      (author-only), system messages fanned into group timelines
- [x] WS: `group.changed`, `group.joinRequest.new` (admins), `group.joined`
      (applicant), `status.new` (audience-filtered), `status.viewed` (author)
- [x] Web UI: group header/panel (settings, roster, requests, invite link,
      exit/delete), group directory dialog (create / join by code / discover),
      SYSTEM-message pills, per-sender labels, admin-only composer lock, Status
      section (rail, viewer with progress + auto-advance, composer with media
      picker + audience + duration, "Viewed by")
- [x] Mobile UI: `GroupInfoScreen`, `GroupDirectoryScreen`, `StatusScreen`
      (expo-image-picker + expo-video), group rows + chat-room group wiring, new
      `groupInfo` / `groupDirectory` routes
- [x] Unit tests: status audience rules, media mime/classification + local
      storage round-trip and traversal guard, group/status request contracts
- [ ] Integration tests for groups, statuses, and media upload/download —
      deferred to the end-of-build test pass

## Phase 5A — Chat controls, contacts, safety + search ✅
- [x] Schema: per-viewer controls on `ConversationMember` (`pinned`, `archived`,
      `mutedUntil`, `clearedAt`, `hidden`, `hiddenAt`) and `StarredMessage`
      (messageId, userId) (migration
      `20260929210000_add_phase5a_chat_controls`, deployed)
- [x] Shared: `updateConversationRequestSchema` (pin/archive/`muteHours`
      0–8760), `starMessageRequestSchema`, `archived` on the chat-list query,
      `q`/`starred` on the history query, `starredByMe` on `Message`, starred +
      contact/recipient/block/report/user-card/global-search contracts
- [x] API: `PATCH`/`DELETE /conversations/:id`, `POST /conversations/:id/clear`,
      `PUT /messages/:id/star`, `GET /starred`; contacts CRUD +
      `GET /contacts/recent`, `GET /users/:id`, block/unblock + blocked list,
      `POST /reports` (with `blockAfterReport`), `GET /search`; in-chat search
      and starred filtering
- [x] Safety semantics: blocking withholds delivery and fan-out while still
      returning 200 (permanent single tick); unknown/blocked numbers answer the
      same generic 404 as chat start; report targets must be visible to the
      reporter; contact→account resolution only against verified active
      identities
- [x] Web UI: chat-action menu (pin/archive/mute presets/clear/delete/report),
      archive view, in-chat search bar, star + starred dialog, contacts dialog
      with add/edit, blocked list, contact-info dialog, report dialog, new-chat
      autocomplete over recents + saved contacts
- [x] Mobile UI: `ChatControls` sheets shared by the chat list and the room
      (long-press on web == long-press here), archived toggle in the list header,
      in-chat search, and new `ContactsScreen` / `StarredScreen` /
      `SearchScreen` / `UserCardScreen` routes
- [x] Unit tests: chat-control + contact contracts (34) and `serializeMessage`
      star/receipt aggregation (5)
- [ ] No new socket events by design — clients re-pull; revisit if control
      changes need to appear live on a second device
- [ ] Integration tests for controls, contacts, blocking and search — deferred
      to the end-of-build test pass

## Phase 5B — Chat media + extras ✅
- [x] Image/video/document/voice messages in chats: upload-then-reference with
      ownership-bound `MediaObject` keys, server-derived `MessageType`, bubbles
      + players on web (`ChatMedia.tsx`) and mobile (`components/ChatMedia.tsx`)
- [x] Voice messages (MediaRecorder on web, expo-audio recorder/player on
      mobile; RN uploads stream via expo-file-system multipart `File.upload`)
- [x] View-once photo/video: URL-less in every payload, one signed-mint per
      viewer via `POST /messages/:id/view-once`, 409 + `message.viewOnceOpened`
- [x] Forward by reference + `forwardedFrom` label; reply quotes freeze a
      `replyPreview` snapshot that outlives edit/delete/clear
- [x] In-chat media gallery: kind-tabbed `GET /conversations/:id/media` grid
      (web dialog + mobile sheet)
- [x] 5B extras — link previews: post-send, fail-silent unfurl with an SSRF
      policy that resolves then refuses private/loopback/metadata ranges (v4 +
      mapped/6to4 v6), re-validated on redirects, capped by
      `LINK_UNFURL_TIMEOUT_MS` / `LINK_PREVIEW_MAX_BYTES`; delivered via the
      new `message.linkPreview` socket event and rendered on web + mobile
- [x] 5B extras — GIF picker + stickers: server-side Giphy proxy
      (`GET /giphy/search`, `POST /giphy/upload`; `GIPHY_API_KEY` never leaves
      the API, `{enabled:false}` without it) — downloads re-mint as owned
      `MediaObject`s, `sticker:true` + IMAGE ⇒ `STICKER` type, transparent
      bubbles on both clients
- [x] 5B extras — location + contact-card shares: `LOCATION`/`CONTACT` payload
      messages (JSON, server-derived type, either-or refined in the send
      schema and re-checked in the service), forward passes them by value,
      Google-Maps / `tel:`/`mailto:` cards on web + mobile, mobile
      `expo-location` pin picker (permission → last-known → live fix)
- [x] 5B extras — media auto-download: `Account.mediaAutoDownload`
      (`ALWAYS`/`WIFI_ONLY`) is a pure client hint — web defers via the
      Object-url gate, mobile via `expo-network` (`useMediaAutoAllowed` +
      tap-to-download tiles); settings UI on both
- [x] Unit tests: unfurl parser + SSRF guard (14), Giphy proxy (9),
      extras contracts in shared (13)
- [x] Docs: API.md endpoints/events, ARCHITECTURE.md §3.4, `.env.example`
      keys, FEATURE-PARITY.md flipped
- [x] Multi-select forward, `@mentions`, gallery links tab — landed in **5E**
- [ ] Malware/`scanStatus` pipeline + orphaned-media sweeper (forwards share
      storage keys, so bytes are only ever freed by a reachability sweep)
- [ ] Integration tests for media + extras — deferred to the end-of-build
      test pass

## Phase 5D — Status parity ✅
- [x] Schema: `Message.statusReplyId` (+ index, `onDelete: SetNull`),
      `Status.shareReadReceipts`, `StatusMute(userId, authorId)` (migration
      `20260930160000_add_phase5d_status_parity`, deployed)
- [x] Shared: `statusReply` on `Message`, `POST /statuses/:id/reply` request and
      result schemas, `StatusMute` + list schema, `shareReadReceipts` on the
      status item and create request (both default-safe)
- [x] API: `replyToStatus` opens or reuses the 1-1 chat with the author and sends
      the reply there with the status as its `replyPreview` quote; audience,
      expiry and self-reply are enforced server-side and answer indistinguishably
- [x] API: mute/unmute/list mutes — filtered on the pull *and* inside
      `status.new` fan-out, so a muted author never lights the ring
- [x] API: receipts-off records no `StatusView` row and pushes nothing, so there
      is no data to reveal later
- [x] Web UI: reply bar in the status viewer, mute toggle + muted-authors
      dialog, "Show who viewed it" in the composer, pause/play + hold-to-pause +
      tap-a-segment seek, "Status reply" quote label in chat bubbles
- [x] Mobile UI: the same reply/mute/receipts/pause-seek set in
      `StatusScreen.tsx` (expo-video player driven through a controls ref) and
      the reply label in `chatUtils.replyQuoteLabel`
- [x] Unit tests: `test/statusParity.test.ts` (20 — mute filtering on pull and
      push, receipts-off never records, reply guards and non-leaky 404s, mute
      target validation, 5D contracts) + `statusReply` serialization in
      `chatControls.test.ts`; shared `accountSchema.appLock` given a default so a
      payload without the key parses like its 5C siblings
- [ ] Integration tests for replies, muting and receipts — deferred to the
      end-of-build test pass
- [ ] Status reply threads surfaced in the author's status view (tap a status →
      see its replies) — **5G** polish

## Phase 5E — Group parity ✅
- [x] Schema: `GroupProfile.avatarStorageKey` + `whoCanInvite`,
      `MessageMention(messageId, userId)` (unique pair, `(userId, createdAt)`
      index, cascade), `MessagePin(messageId)` (unique — one shared pin per
      message) in migrations `20260930190000_add_phase5e_group_parity` and
      `20261001000000_add_phase5e_message_pins` (both deployed)
- [x] Shared: `whoCanInvite` on `GroupSettings` (defaults to `ALL`, so old
      payloads parse), `Message.mentions` / `mentionedMe` / `pinned`,
      `ConversationSummary.unreadMentions`, `ChatPin`/`ChatPinList`,
      `ChatLinkItem`/`ChatLinkList`, the `message.pin` WS event, and
      `avatarStorageKey` on the group create/patch requests
- [x] API: `services/mentions.ts` resolves `@name` against the group's ACTIVE
      roster with a boundary-anchored, longest-name-first match — clients never
      send mention ids, so notifications cannot be forged into another chat
- [x] API: `unreadMentions` counted against the viewer's
      `lastReadAt`/`clearChat` watermark; `editMessage` re-resolves mentions
      without touching `createdAt`, so an edit cannot re-badge a read chat
- [x] API: `PUT`/`DELETE /messages/:id/pin` (any member, not the sender-only
      rule), `GET /conversations/:id/pins`, and the `message.pin` fan-out via
      `fanOutAll` so the actor's own other devices converge
- [x] API: `GET /conversations/:id/links` serves the gallery Links tab from the
      `linkPreview` cards stored at send time — no re-fetch, no SSRF oracle
- [x] API: `mayInvite` hides `inviteCode` from members when
      `whoCanInvite=ADMINS`; `avatarOf` signs the uploaded icon per read and
      falls back to the legacy `avatarUrl`; uploads are ownership-checked
      (`assertOwnsMedia`)
- [x] Web UI: pinned-message banner + pins dialog with jump/unpin, mention
      typeahead (roster only), mention pills and `@` unread badge in the chat
      list, multi-select forward bar, Links gallery tab, and group icon upload /
      removal, description editing and the invite-permission toggle in the group
      panel
- [x] Mobile UI: the same set in `ChatRoomScreen.tsx` (`View.measure` jump,
      long-press Pin/Select, pins sheet, typeahead above the composer),
      `ChatsScreen.tsx` mention badge, `GroupInfoScreen.tsx` icon + description +
      `whoCanInvite`, the Links tab in `MediaGallerySheet`, and a description
      field when creating a group
- [x] Unit tests: `apps/api/test/groupParity.test.ts` (21 — mention boundary
      rules incl. emails and `@Sam`/`@Sammy`, invite permission per role, signed
      vs legacy icon, pin upsert/unpin/non-member rejection + fan-out, pin
      paging) and `packages/shared/test/groupParity.test.ts` (18 — 5E contract
      defaults so pre-5E payloads still parse, pin/link list schemas,
      `message.pin` event, `whoCanInvite` + `avatarStorageKey` request rules)
- [ ] Integration tests for mentions, pins, the links tab and group icon
      uploads — deferred to the end-of-build test pass
- [ ] Mention notifications (push + in-app notification centre) — **5G**

## Phase 5F — Calling ✅ (self-hosted WebRTC, 1-1)
- [x] Schema: `Call` (conversation, caller, `mediaType`, `status`,
      `connectedAt`/`endedAt`/`declineReason`) + `CallParticipant` (unique
      `(callId, userId)`, `answered`/`muted`/`cameraOff`/`joinedAt`/`leftAt`) +
      append-only `CallEvent`, with `CallMediaType` / `CallStatus` /
      `CallEndReason` enums, in migration
      `20261001120000_add_phase5f_calls` (deployed)
- [x] Shared: `packages/shared/src/calls.ts` — `CallSummary` (with the
      per-viewer `direction`), `CallList`, `ListCallsQuery` (limit capped at
      100), `MissedCallCount`, `StartCallRequest/Response`, `IceConfig` +
      `IceServer`, `CallSignalPayload` (SDP ≤ 256 KiB, one ICE candidate),
      `CallParticipantStateRequest`, and the `call.*` client/server socket
      unions — payloads are opaque JSON so a WebRTC upgrade needs no protocol
      release
- [x] API: `services/calls.ts` owns the record, the state machine and the relay:
      idempotent `startCall` (a retry returns the live call instead of a second
      row), peer-busy 409 before the row is written, block → 403 and
      non-member → 404 (5A's rules), `accept`/`decline` (DECLINED vs BUSY kept
      distinct), one `hangUpCall` verb that cancels a ring, declines an incoming
      one, or ends a live call, and is idempotent once finished
- [x] API: `buildIceConfig` mints coturn's time-limited REST credential
      (`"<expiry>:<userId>"` + `base64(HMAC-SHA1(TURN_SECRET, username))`) so the
      shared secret never leaves the server; boot rejects `TURN_URLS` without a
      `TURN_SECRET`
- [x] API: signaling relayed on the existing `/ws` gateway (`call.accept` /
      `reject` / `cancel` / `hangUp` / `signal` / `state`); SDP is written to
      `CallEvent`, ICE candidates are not, and a terminal call drops signaling
      with 400 instead of relaying stale offer/answer
- [x] API: `sweepStuckRings` on `CALL_SWEEP_SECONDS` turns unanswered rings into
      `MISSED` after `CALL_RING_TIMEOUT_SECONDS` — a restart mid-ring still
      expires, and a callee never stares at a dead caller's modal
- [x] API: `GET /calls` (cursor-paged call log), `GET /calls/missed-count`
      (measured against each chat's `lastReadAt` watermark, caller's own calls
      excluded), `GET /calls/ice-config`, `PATCH /calls/:id/me`
- [x] Web UI: `lib/calls.tsx` (peer connection, ICE queue until
      `setRemoteDescription`, caller waits for `call.accepted` before
      `createOffer`), `CallOverlay.tsx` (remote + self video, mute / camera /
      end, incoming modal with Decline + Accept), `CallsSection.tsx` (All/Missed
      log with missed badge and call-back dial), and the 📞/📹 header buttons on a
      1-1 chat
- [x] Mobile UI: `src/webrtc.ts` lazy-`require`s `react-native-webrtc` so Expo Go
      still boots (media needs `npx expo run:android|ios` or an `eas` development
      build), `src/calls.ts` module store (no provider tree, so a ring can
      interrupt any screen), `components/CallOverlay.tsx` mounted from `App.tsx`,
      `screens/CallsScreen.tsx` with All/Missed + call-back dials, the two header
      dial buttons in `ChatRoomScreen.tsx`, mic/camera permission strings and
      Android audio permissions in `app.json`
- [x] Unit tests: `apps/api/test/calls.test.ts` (36 — env parsing, the coturn
      HMAC incl. "the secret never appears in the payload", viewer-relative
      serialization, every permission and transition of the state machine with
      the frames each side is told about, SDP-vs-ICE persistence, cursor paging,
      the missed watermark and the ring sweep) and
      `packages/shared/test/calls.test.ts` (24 — status/end-reason enums, query
      coercion + the limit reject, SDP size bounds, ICE defaults, socket frames a
      client may not send)
- [ ] Integration tests for the call lifecycle + signaling — deferred to the
      end-of-build test pass
- [ ] TURN relay deployed (config + credential minting are shipped; only a real
      coturn server is needed to cross NAT)
- [ ] Incoming-call push so a closed app can ring (FCM/APNs) — **5G**
- [ ] Group calls — the per-member `CallParticipant` roster is already the right
      shape; the state machine and the UI are not — **5G**

## Phase 5G — Notifications, push and chat polish
The last sub-phase of the WhatsApp-parity push (`docs/FEATURE-PARITY.md`):
- [ ] Notification centre API over the existing `notifications` table + unread
      badges (in-app, no push yet)
- [ ] Push transport: FCM for Android and web push (`devices` table ready),
      respecting the 5A per-chat mute before anything is sent
- [ ] **Incoming-call push** so a closed app can ring, and the answer/hang-up
      path from the notification (`Call` rows and `call.incoming` already exist)
- [ ] **Group calls** on the existing `CallParticipant` roster
- [ ] Notification prefs: per-conversation + global, custom sounds and quiet mode
      (spec §34)
- [ ] Mention notifications (the `MessageMention` rows are the source) — carried
      from 5E
- [ ] Chat folders / pinned-chat sections
- [ ] Chat wallpaper / bubble theme
- [ ] Mail search folded into `GET /search`
- [ ] Per-contact media + links strip in the chat-info sheet
- [ ] Mobile app lock / biometric screen lock (`expo-local-authentication` needs a
      development build) — carried from 5C
- [ ] Account recovery flows and storage management (spec §34)

## Phase 6 — External email gateway (deferred from the original Phase 4)
- [ ] `SmtpProvider.parseEmail` — RFC 822 parsing (mailparser) for inbound
- [ ] Inbound bridge: IMAP polling worker and/or provider inbound-parse
      webhook → map into threads via `References`/`In-Reply-To` (spec §13)
- [ ] Queue-based sending with retry + bounce handling
      (`email_delivery_events` ready)
- [ ] SPF/DKIM/DMARC provisioning for the sending domain
- [ ] Additional provider adapters (Resend/SendGrid/Postmark) behind
      `EmailProvider`
- [ ] Subtle Convo branding footer on outgoing external mail (spec §12)

## Phase 5 — Attachments, settings, remaining search
- [x] Object storage + expiring private download URLs (delivered in Phase 4B for
      statuses; Supabase service-role key stays server-side)
- [ ] MIME validation, size limits, malware scanning pipeline
      (validation + caps shipped in 4B; scanning still stubbed)
- [x] Global search across Chats/Contacts/Groups + in-chat search (Phase 5A:
      `GET /search`, bounded `ILIKE` scans scoped to the caller's own rows)
- [ ] Mail search folded into `GET /search` — **5G**
- [ ] Postgres FTS / `pg_trgm` index once message volume makes scans slow
- [x] Contacts address book + recent-recipient autocomplete (Phase 5A: `/contacts`
      CRUD, `GET /contacts/recent`) — this is what `CONTACTS` /
      `CONTACTS_EXCEPT` status audiences and private-group discovery now read
- [ ] Device contacts sync (explicit permission, secure identity matching, spec
      §21) — needs a native permission surface, so it is not Expo-Go safe
- [x] Remaining Settings: privacy (photo/about/online/group-add/read receipts,
      disappearing messages), two-step PIN, active sessions UI with revoke,
      linked devices, account deletion + chat export — **Phase 5C**
- [ ] Mobile app lock / biometric screen lock (spec §34) — the settings model
      and the web lock shipped in 5C; React Native has no `SubtleCrypto`, so the
      device side needs a crypto dependency plus a lock screen, and biometrics
      need a development build (`expo-local-authentication`). **5G**
- [ ] Notification prefs per conversation + global, storage management and
      account recovery flows (spec §34) — **5G**

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
