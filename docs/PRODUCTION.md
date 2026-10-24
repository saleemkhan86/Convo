# Production runbook — convo.fawzxenon.com

Topology:

```
browser ──https──▶ convo.fawzxenon.com        (Netlify: static SPA)
        └─https/wss─▶ api.convo.fawzxenon.com (API: WebSocket + persistent disk)
                                        └──▶ Supabase Postgres (session pooler)
                                        └──▶ Redis (only when >1 API instance)
```

The browser calls the API on its own origin, not through Netlify: Netlify
redirects cannot carry WebSocket upgrades, so proxying `/api/*` would leave
`wss://…/ws` dead while REST kept working — a failure that looks like "realtime
randomly stopped".

## 1. DNS

| Record | Type | Value | Notes |
|---|---|---|---|
| `convo` | CNAME | `<site-name>.netlify.app` | then add `convo.fawzxenon.com` in Netlify ▸ Domain management; TLS is issued automatically |
| `api.convo` | CNAME / A+AAAA | what the API platform assigns (Fly: the app's IPv4/IPv6; Railway: its CNAME target; VPS: the server IP) | must terminate TLS for `wss://` |

If FawzXenon's DNS sits behind a CDN proxy, set `api.convo` to **DNS-only**:
long-lived WebSocket connections behind an HTTP proxy can be cut at the proxy's
idle timeout.

## 2. Netlify (web)

Environment variables (Site configuration ▸ Environment variables):

| Variable | Value | Why |
|---|---|---|
| `VITE_API_URL` | `https://api.convo.fawzxenon.com` | build-time; `realtimeUrl()` derives `wss://` from it. A Netlify production build **fails** without it (`apps/web/vite.config.ts`) |

No secret belongs in the web build: everything under `VITE_*` is inlined into
the bundle and readable by anyone.

## 3. API environment (`apps/api/.env` on the host, or the platform's secret store)

Required for boot:

```
NODE_ENV=production
PORT=<platform-assigned, usually injected>
API_PUBLIC_URL=https://api.convo.fawzxenon.com
APP_URL=https://convo.fawzxenon.com
CORS_ORIGIN=https://convo.fawzxenon.com
DATABASE_URL=postgresql://postgres.zpjjueqjcuxqnswkadtr:<pw>@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres
JWT_SECRET=<48 random bytes, base64url>
```

`API_PUBLIC_URL` is the origin signed media links are built from (the API host,
**not** the web app): production boot throws without it, because building them
from `APP_URL` would point every image and video at the SPA, where `/media`
does not exist.

`DATABASE_URL` must use the **session pooler on 5432**. The direct host is
IPv6-only here, and the transaction pooler breaks Prisma's prepared statements.

Feature credentials (each one is currently load-bearing for a whole feature):

```
# Email — required: production boot throws without SMTP_HOST
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=<Brevo SMTP login>
SMTP_PASS=<Brevo SMTP key, not the API key>
MAIL_FROM=Convo <no-reply@your-verified-domain>

# Media — the `media` bucket must exist in Supabase Storage first
MEDIA_STORAGE_PROVIDER=supabase
SUPABASE_URL=…
SUPABASE_SERVICE_ROLE_KEY=…
SUPABASE_MEDIA_BUCKET=media

# Realtime across instances (omit only if you run exactly one API process)
REDIS_URL=rediss://default:<token>@<region>.upstash.io:6379

# Calls across NAT
TURN_URLS=turn:relay.<domain>:3478?transport=udp
TURN_SECRET=<matches coturn>

# Web push
VAPID_PUBLIC_KEY=…
VAPID_PRIVATE_KEY=…
VAPID_SUBJECT=mailto:push@<domain>
EXPO_ACCESS_TOKEN=<only needed for the mobile app>
```

Never set `DEV_EXPOSE_OTP=true` in production — `loadConfig` throws.

Phone OTP returns **503** in production until a Brevo SMS adapter exists
(`apps/api/src/sms/`); email OTP works as soon as the SMTP values are valid.

## 4. Platform requirements

- **WebSocket upgrade** on `/ws` (no HTTP-only host can serve Convo).
- **Persistent disk** if `MEDIA_STORAGE_PROVIDER=local` — otherwise uploads
  disappear on redeploy. Prefer `supabase` and skip this.
- **One instance** unless `REDIS_URL` is set. Two processes without Redis means
  two realtime worlds: a message sent on node A is invisible to a socket on B.
- **Health check** on `GET /health`.
- **Do not expose the app port directly.** `apps/api/src/app.ts` sets
  `trustProxy: true` in production, so only the platform's edge may reach the
  process; otherwise a client can spoof `X-Forwarded-For` and walk past the
  rate limiter.

## 5. Migrations

Run from a machine with the production `DATABASE_URL` in scope:

```
pnpm --filter @convo/api prisma:deploy
```

Never `prisma:migrate` (`migrate dev`) against production. Note that three
migration folders (`add_device_model_extensions`, `add_message_sequence_number`,
`add_device_message_delivery`) are not committed yet — a fresh database needs
them in git before the first deploy, or `migrate deploy` will not create the
tables the current schema expects. The existing development database already has
them applied; see `docs/DB-DRIFT.md`.

## 6. Post-deploy smoke checks

| Check | Expected |
|---|---|
| `GET https://api.convo.fawzxenon.com/health` | `200` |
| WebSocket to `wss://api.convo.fawzxenon.com/ws?token=…` with `Connection: Upgrade` | `101` (a bare GET returns `404`, which is not a failure) |
| `POST https://api.convo.fawzxenon.com/auth/email/request-otp` | mail arrives from the verified sender |
| Preflight `OPTIONS` with `Origin: https://convo.fawzxenon.com` | `access-control-allow-origin` echoes the origin |
| Send a message in two browser tabs | both update without reload |
| Upload a status photo | returns an expiring URL that loads |
| Settings page, scrolled to the bottom | partner-services line present |

## 7. Rollback

Netlify keeps every deploy — publish a previous one from Deploys ▸ (choose
build) ▸ Publish deploy. For the API, roll the platform release back; database
migrations are forward-only, so any schema change needs its own plan.
