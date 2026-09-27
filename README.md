# Convo

One account. Every way to talk. Convo is a cross-platform communication app
(Android + Web) combining phone-number instant messaging (**Chats**) with a
chat-style email system (**Mail**) that interoperates with Gmail, Outlook and
any standard email provider.

**Core model:** a single Convo account can hold two optional identities — a
phone number (unlocks Chats) and an email address (unlocks Mail). Users may
start with either and connect the other later; the second identity attaches to
the *same* account after ownership verification. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Monorepo

| Package | Stack | Purpose |
|---|---|---|
| `apps/api` | Fastify · Prisma · PostgreSQL | REST API, auth, identity linking, email gateway |
| `apps/web` | Vite · React 19 · Tailwind v4 | Responsive web app |
| `apps/mobile` | Expo SDK 57 (React Native) | Android app |
| `packages/shared` | Zod · TypeScript | API contracts shared by every client |

## Prerequisites

- Node.js ≥ 22 and pnpm (`corepack enable`)
- PostgreSQL 16+ (local via Docker, or a cloud instance — Neon/Supabase/Railway)
- Optional: Docker for the local email test server (Mailpit)

## Local development

```bash
pnpm install

# 1. Environment
cp .env.example apps/api/.env
#    → set DATABASE_URL (your Postgres) and a strong JWT_SECRET:
#      node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"

# 2. Database (cloud Postgres: skip; local Docker: )
docker compose up -d postgres

# 3. Migrate + seed
pnpm db:migrate     # prisma migrate dev
pnpm db:seed        # demo accounts (see below)

# 4. Optional: local email (SMTP :1025, inbox UI http://localhost:8025)
docker compose up -d mailpit

# 5. Run
pnpm dev:api        # http://localhost:4000
pnpm dev:web        # http://localhost:5173
pnpm dev:mobile     # Expo — press "a" for Android
```

With `DEV_EXPOSE_OTP=true` (default in `.env.example`), verification codes are
returned in API responses and shown in the UI — **development only**; the API
refuses to start with it enabled in production.

Mobile on a physical device: set `EXPO_PUBLIC_API_URL` in `apps/mobile/.env`
to your machine's LAN IP (the Android emulator default `http://10.0.2.2:4000`
works out of the box).

### Demo accounts (seeded)

| User | Identities | Capabilities |
|---|---|---|
| Alice | `+919800000001`, `alice@example.com` | Chats + Mail |
| Bob | `bob@example.com` | Mail only (prompted to connect phone) |
| Carol | `+919800000003` | Chats only (prompted to connect email) |

Sign in with any of them — OTP codes appear in the UI in dev mode.

## Testing

```bash
pnpm test                       # all workspaces
pnpm --filter @convo/api test   # unit + integration (needs TEST_DATABASE_URL)
```

## Deployment

### API
1. Provision PostgreSQL (managed) and set `DATABASE_URL`.
2. Set `NODE_ENV=production`, strong `JWT_SECRET`, `CORS_ORIGIN`,
   `APP_URL`, and SMTP credentials (`SMTP_HOST/PORT/USER/PASS`, `MAIL_FROM`)
   — never `DEV_EXPOSE_OTP`.
3. Build: `pnpm install --frozen-lockfile && pnpm --filter @convo/api build`.
4. Migrate: `pnpm --filter @convo/api prisma:deploy` (runs on release, before
   the new instance serves traffic).
5. Start: `pnpm --filter @convo/api start`. Deploy behind TLS (reverse proxy
   or platform-managed). Any Node host works (Fly.io, Render, Railway, ECS).

### Web
1. `pnpm --filter @convo/web build` with `VITE_API_URL` set to the public API
   origin (or serve behind the same origin with `/api` proxied).
2. Deploy `apps/web/dist` to any static host (Netlify/Vercel/Cloudflare Pages/
   S3+CDN). SPA fallback: route all paths to `index.html`.

### Android
1. Configure `EXPO_PUBLIC_API_URL` for the production API.
2. `eas build --platform android` → internal testing → Play Store
   (see docs/TODO.md Phase 6 for push/deep-link hardening before launch).

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — system design + decision log
- [docs/API.md](docs/API.md) — REST API reference
- [docs/TODO.md](docs/TODO.md) — deferred features by phase

## Security notes

- OTP codes are hashed at rest; attempt-capped; resend-cooled down.
- Refresh tokens are opaque, hashed, rotated on use, revocable.
- Email/SMTP credentials are server-side only; clients never see them.
- Identity linking requires OTP proof of ownership; conflicting identities are
  refused without revealing which account holds them (enumeration-safe).
- Sensitive operations write to the audit log.
