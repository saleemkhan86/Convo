# Convo → WhatsApp feature parity

Research target for **Phase 5**: by the end of the phase everything WhatsApp
offers in a personal account must exist in Convo (web + mobile), or be listed
here as explicitly out of scope with a reason.

Sources for the taxonomy: WhatsApp Help Center privacy/group/advanced articles
and the 2026 security-feature roundups (links at the bottom). Feature names are
kept in WhatsApp's own words so the matrix can be checked against the app.

Status legend: ✅ shipped · 🟨 partial (some of it exists) · ⬜ not started.

## 1. Chats

| WhatsApp feature | Convo today | Phase |
|---|---|---|
| 1-1 chat, send/receive, typing, presence | ✅ | — |
| Read receipts (blue ticks) | ✅ per-message receipts | — |
| Reply / edit / delete for me / delete for everyone | ✅ | — |
| Emoji reactions (+ chips) | ✅ | — |
| Timestamps, delivery states | ✅ | — |
| **Pin a chat** | ✅ per-viewer `PATCH /conversations/:id` | 5A |
| **Archive / unarchive** | ✅ `GET /conversations?archived=true` | 5A |
| **Mute with durations (8h/1w/1y)** | ✅ `muteHours` 8/168/8760, 0 = unmute | 5A |
| **Star a message + starred list** | ✅ `PUT /messages/:id/star` + `GET /starred` | 5A |
| **Clear chat (for me)** | ✅ `clearedAt` watermark, others untouched | 5A |
| **Delete chat (for me)** | ✅ `hidden`, returns on new activity | 5A |
| **Search inside a chat** | ✅ `?q=` + `?starred=true` on the history endpoint | 5A |
| **Global search (chats, contacts, mail)** | 🟨 chats/contacts/messages/groups via `GET /search`; mail not yet | 5G |
| **Forward a message (single + multi-select)** | ✅ long-press/select → "Select messages" → `POST /conversations/forward` with up to 20 ids (web + mobile) | 5E |
| Contact info sheet (name, phone, about, media) | 🟨 `GET /users/:id` name/phone/bio/last-seen + block/report; the per-contact media/links strip is still open (the chat gallery has it since 5E) | 5G |
| Disappearing messages (24h/7d/90d) per chat | ✅ `PATCH /conversations/:id/ephemeral` + `Message.expiresAt`, lazy sweep + `message.expired` (web + mobile) | 5C |
| Default disappearing timer for new chats | ✅ `defaultEphemeralSeconds`, shorter-of-the-two on 1-1 start | 5C |
| Chat wallpaper / custom background | ⬜ | 5G |
| Export chat (text / with media) | ✅ `GET /conversations/:id/export` transcript, signed `mediaUrl`s on demand; web downloads, mobile writes to app storage | 5C |
| Quiet mode / notification schedule | ⬜ | 5G |
| Chat folders (All / Personal / Group) | ⬜ | 5G |

## 2. Media in chats

| WhatsApp feature | Convo today | Phase |
|---|---|---|
| Photo messages | ✅ upload → `IMAGE` message → bubble + lightbox (web + mobile) | 5B |
| Video messages | ✅ `VIDEO` messages with native players | 5B |
| Document messages (pdf/doc/xls/…) | ✅ `DOCUMENT` messages, MIME-allowlisted uploads | 5B |
| Voice notes (record → send → play) | ✅ recorder (MediaRecorder web / expo-audio mobile) → `VOICE` message with inline player | 5B |
| Contact card shared into a chat | ✅ `CONTACT` payload message from saved contacts; tap → dialer/mail (web + mobile) | 5B extras |
| Location share | ✅ `LOCATION` pin via geolocation; card opens maps (web + mobile) | 5B extras |
| Stickers + sticker picker | ✅ `STICKER` type — any image (or GIF) sent edge-to-edge, no bubble | 5B extras |
| GIF search (Giphy) | ✅ `/giphy/search` + `/giphy/upload` proxy, key server-side only; needs `GIPHY_API_KEY` to light up | 5B extras |
| View-once photo/video | ✅ URL-less in every payload; `POST /messages/:id/view-once` mints one view per viewer, 409 on the second | 5B |
| Link previews (rich card + open graph) | ✅ SSRF-guarded post-send scrape of the first link → `Message.linkPreview` + `message.linkPreview` event | 5B extras |
| In-chat media gallery (docs/links/media tabs) | ✅ kind-tabbed `GET /conversations/:id/media` grid plus a **Links** tab fed by `GET /conversations/:id/links` (web + mobile) | 5E |
| Auto-download media (per network) setting | ✅ `mediaAutoDownload: ALWAYS\|WIFI_ONLY` on the account; web + mobile gate heavy tiles on Wi-Fi with tap-to-download | 5B extras |
| Reply preview with thumbnail | 🟨 frozen `replyPreview` snapshot outlives edit/delete (text + kind label); thumbnail later | 5B extras |

## 3. Groups

| WhatsApp feature | Convo today | Phase |
|---|---|---|
| Create group, add by contact/phone | ✅ | — |
| Public vs private, invite link + revoke | ✅ | — |
| Admin approval of join requests | ✅ | — |
| Announce-only / who can send / who can edit | ✅ | — |
| Promote / demote / remove, last-admin guard | ✅ | — |
| System events in the timeline | ✅ | — |
| Group subject + about + icon editing | ✅ name/about plus an uploaded icon: media-pipeline key, signed per read, removable (web + mobile) | 5E |
| **@mentions with typeahead + unread badge** | ✅ roster-driven typeahead, server-resolved `MessageMention`, pills in bubbles, `unreadMentions` badge on the chat list | 5E |
| **"Invite via link" permission: everyone / admins only** | ✅ `settings.whoCanInvite` — `ADMINS` stops `inviteCode` ever reaching a member's payload | 5E |
| **Group info: media / docs / links tabs** | ✅ the chat's gallery sheet carries All/Photos/Videos/Docs/Voice/**Links** for groups too (web + mobile) | 5E |
| **Mute group, custom group notification** | ✅ mute (5A); per-group sound still 5G | 5G |
| **Exit group + "who can re-add me" guard** | ✅ exit + `groupAddVisibility` (EVERYONE / MY CONTACTS / NO ONE) enforced in `addGroupMembers`, so a member who leaves cannot be dragged back by someone they restricted | 5C |
| **Report group / delete group for all members** | ✅ `REPORT CONVERSATION` + admin `DELETE /groups/:id` | — |
| Pin a group message for all members | ✅ `PUT`/`DELETE /messages/:id/pin` + `GET /conversations/:id/pins`; shared state, `message.pin` fan-out, banner + jump (web + mobile) | 5E |
| Group calls | ⬜ 1-1 only in 5F; `CallParticipant` is already a per-member roster, so no schema work stands in the way | 5G |
| Communities / channels | out of scope (Meta-only, not personal-account features) | — |

## 4. Status (24h stories)

| WhatsApp feature | Convo today | Phase |
|---|---|---|
| Text / photo / video status, custom TTL | ✅ | — |
| Link status | ✅ (beyond WhatsApp) | — |
| Audience: everyone / contacts / only with / never share with | ✅ | — |
| Viewed-by list + view counts | ✅ | — |
| **Reply to a status (→ DM to the author)** | ✅ `POST /statuses/:id/reply` opens (or reuses) the 1-1 chat and sends the reply there | 5D |
| **Status read-receipt toggle (author-side)** | ✅ `shareReadReceipts` per post; off means views are never recorded | 5D |
| **Delete a status** | ✅ | — |
| **Mute one author's status updates** | ✅ `PUT/DELETE /statuses/mute/:authorId`, private to the viewer, filters pull and push | 5D |
| Pause/seek in the status viewer | ✅ pause button + hold-to-pause + tap-a-segment to seek | 5D |

## 5. Contacts, privacy, security

| WhatsApp feature | Convo today | Phase |
|---|---|---|
| Address book (add/edit/remove, sync) | ✅ `/contacts` CRUD (device sync still n/a) | 5A |
| Recent-recipient autocomplete | ✅ `GET /contacts/recent` | 5A |
| **Block / unblock + blocked list** | ✅ `/blocks`, non-revealing delivery | 5A |
| **Report contact / message / group (+ block afterwards)** | ✅ `POST /reports` + `blockAfterReport` | 5A |
| Last seen visibility | ✅ `presenceVisibility` | — |
| **"Who can see when I'm online"** (2026 split) | ✅ `onlineVisibility` per field, enforced at every serialization edge | 5C |
| **Profile photo visibility** | ✅ `avatarVisibility` (Everyone / Contacts / Except / Nobody) | 5C |
| **About visibility** | ✅ `aboutVisibility`, same four-way rule | 5C |
| **Read receipts on/off** (two-way) | ✅ `readReceiptsEnabled`; off hides ticks both ways | 5C |
| **"Who can add me to groups"** | ✅ `groupAddVisibility`; adds are silently skipped, never a privacy oracle | 5C |
| **Two-step verification (PIN)** | ✅ scrypt PIN + one-time token exchange at `POST /auth/2fa/verify` (web + mobile PIN step) | 5C |
| **App lock / biometric screen lock** | 🟨 web hashes its own PIN and mirrors settings via `appLock`; mobile has no SubtleCrypto, so the on-device lock screen is open | 5C/5G |
| **Active sessions UI + revoke** | ✅ `GET /me/sessions` + revoke one / all others, current session flagged | 5C |
| **Linked devices / log out everywhere** | ✅ `/me/devices` CRUD + "log out everywhere else" | 5C |
| **Account deletion (with grace)** | ✅ `POST/DELETE /me/delete-account`, 30-day grace, login cancels, sweeper anonymises then removes | 5C |
| Silent unknown callers | ✅ by construction: a call only exists inside a 1-1 chat you already have, and blocking kills ringing in both directions with a generic 403 | 5F |
| Local AI spam detection | out of scope (Meta-specific) | — |

## 6. Notifications

| WhatsApp feature | Convo today | Phase |
|---|---|---|
| In-app realtime updates (socket) | ✅ | — |
| **Notification centre / unread badges** | 🟨 `notifications` table, no API | 5G |
| **Push on Android (FCM) + web push** | ⬜ | 5G |
| **Notification sound / preview / per-chat toggle** | ⬜ | 5G |
| Missed-call notifications | 🟨 the `MISSED` row and its badge exist (`GET /calls/missed-count`); the push that wakes a closed app is **5G** | 5F/5G |

## 7. Calling

| WhatsApp feature | Convo today | Phase |
|---|---|---|
| Voice call 1-1 (WebRTC) | ✅ self-hosted peer-to-peer; server owns the record + signaling only, media never transits it | 5F |
| Video call 1-1 | ✅ same path, `mediaType: VIDEO`, with PiP self-view and camera toggle | 5F |
| Call history + missed calls | ✅ `GET /calls` (All/Missed, cursor-paged) + watermark-based missed badge | 5F |
| In-call controls (mute, camera, end) | ✅ web + mobile overlay; mute/camera state recorded per participant (`PATCH /calls/:id/me`) | 5F |
| TURN relay | 🟨 coturn adapter shipped (`STUN_URLS`/`TURN_URLS`/`TURN_SECRET` with HMAC time-limited creds); needs a relay deployed to exercise NAT-traversal beyond a LAN | 5F |
| Incoming call while the app is closed | ⬜ needs push (FCM/APNs) | 5G |
| Group calls | ⬜ `CallParticipant` is already a per-member roster, so no schema change — state machine + UI remain | 5G |
| Call link / "join from notification" | ⬜ | 5G |
| Screen share | out of scope for MVP | — |

## 8. Accounts & platform

| WhatsApp feature | Convo today | Phase |
|---|---|---|
| Phone-OTP login | ✅ | — |
| Email identity + mail | ✅ (Convo-to-Convo) | — |
| External email gateway (SMTP/IMAP) | ⬜ moved to **Phase 6** | 6 |
| Multi-device companion | out of scope (single session model) | — |
| Chat backup to cloud | ⬜ (5C shipped the local `GET /conversations/:id/export` transcript; no cloud backup) | 5G |
| Business features | out of scope | — |
| Arabic/other-language packs, tablets, wearables | out of scope | — |

## Phase 5 execution order

Each sub-phase lands schema → API → shared contracts → web UI → mobile UI →
unit tests → docs, and keeps `pnpm -r lint` green. Integration tests stay
deferred to the end-of-build pass (task #37).

1. **5A — Chat controls, contacts, safety** ✅ *done*: pin/archive/mute/clear/delete,
   star + starred list, contacts CRUD + autocomplete, block/unblock, report,
   in-chat search, global search, contact-info sheet. Mail-aware global search
   moved to 5G.
2. **5B — Media messages + extras** ✅ *done*: attachments on sends (upload →
   reference, ownership-bound), photo/video/document/voice bubbles on web +
   mobile, view-once, forwarding by reference, shared-media gallery, star/search
   previews of media, plus the extras: link previews (SSRF-guarded unfurl),
   GIF/sticker picker (server-side Giphy proxy), location + contact-card
   shares, media auto-download pref. Multi-select forward and the gallery links
   tab landed with 5E.
3. **5C — Privacy & security** ✅ *done*: per-field profile-photo/about/online
   visibility with a "my contacts except…" list, group-add + read-receipt rules,
   disappearing messages (per chat + account default), chat export, two-step
   verification PIN with a login PIN step on web + mobile, active-sessions and
   linked-devices management, and the account-deletion grace window. App lock
   shipped web-only; the mobile lock screen moves to 5G.
4. **5D — Status parity** ✅ *done*: replies that open (or reuse) a 1-1 chat with
   the author and quote the status they answered, the author-side read-receipt
   toggle (off means a view is never recorded, for anybody), muting an author's
   updates from the feed and the live push, and viewer pause / hold-to-pause /
   tap-to-seek.
5. **5E — Group parity** ✅ *done*: @mentions resolved server-side with roster
   typeahead, pills and an unread-mention badge, shared "pin for everyone" with a
   pin banner + pins sheet, the group icon (media-pipeline upload, signed per
   read), the "only admins can share the invite link" permission, the gallery
   Links tab from stored link cards, and multi-select forward on web + mobile.
6. **5F — Calling** ✅ *done*: self-hosted WebRTC voice and video for 1-1 chats —
   the call record and state machine on the API, signaling relayed on the existing
   `/ws` socket, STUN plus minted short-lived TURN credentials, a call overlay with
   mute/camera/end on web + mobile, an incoming-call modal, the call history with
   All/Missed filters and a watermark-based missed badge. Group calls and
   background (push) ringing move to 5G; mobile media needs a development build.
7. **5G — Notifications & polish**: notification centre, push (FCM/web),
   per-chat + global prefs, quiet mode, incoming-call alerts, group calls, chat
   folders, wallpaper.

## Sources

- [How to change your privacy settings — WhatsApp Help Center](https://faq.whatsapp.com/3307102709559968)
- [About advanced chat privacy — WhatsApp Help Center](https://faq.whatsapp.com/715385484388016)
- [How to change group admin settings — WhatsApp Help Center](https://faq.whatsapp.com/526742385997912)
- [How to change group privacy settings — WhatsApp Help Center](https://faq.whatsapp.com/1131457590844955)
- [How to make changes to groups — WhatsApp Help Center](https://faq.whatsapp.com/web/chats/how-to-make-changes-to-groups?lang=vi)
- [WhatsApp Security Features You Should Know in 2026](https://sheetwa.com/blogs/whatsapp-security-features-updates/)
- [WhatsApp Privacy Update 2026: Online Status, Encrypted…](https://keepnetlabs.com/blog/whatsapp-privacy-update-now-you-can-hide-when-you-are-online)
- [How To Limit Who Can Send Messages In Your WhatsApp Group](https://www.slashgear.com/1671951/whatsapp-group-message-settings-who-can-send/)
