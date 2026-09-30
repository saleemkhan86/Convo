import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().default(4000),
  HOST: z.string().default("0.0.0.0"),
  APP_URL: z.string().url().default("http://localhost:5173"),
  CORS_ORIGIN: z.string().default("http://localhost:5173,http://localhost:8081"),

  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),

  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().default(90),

  OTP_TTL_SECONDS: z.coerce.number().int().default(600),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().default(5),
  OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().default(60),
  /** When true, OTP challenges return the code in the API response (local dev only). */
  DEV_EXPOSE_OTP: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  // Email gateway (spec §14). All credentials stay server-side.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().default(1025),
  SMTP_SECURE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().default("Convo <no-reply@convo.local>"),

  // Media storage (Phase 4B: status photos/videos, chat attachments later).
  // All credentials stay server-side; clients only ever see expiring URLs.
  MEDIA_STORAGE_PROVIDER: z.enum(["local", "supabase"]).default("local"),
  MEDIA_MAX_UPLOAD_BYTES: z.coerce.number().int().default(100 * 1024 * 1024),
  MEDIA_URL_TTL_SECONDS: z.coerce.number().int().default(6 * 3600),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_MEDIA_BUCKET: z.string().default("media"),

  // Link previews + GIF picker (Phase 5B extras). The Giphy key stays
  // server-side; clients only hit our proxy routes.
  GIPHY_API_KEY: z.string().optional(),
  LINK_UNFURL_TIMEOUT_MS: z.coerce.number().int().default(5000),
  LINK_PREVIEW_MAX_BYTES: z.coerce.number().int().default(2 * 1024 * 1024),

  // Calling (Phase 5F). WebRTC is peer-to-peer; the server only mints ICE
  // configs. A TURN shared secret stays server-side — clients receive a
  // short-lived HMAC credential scoped to their own user id, never the secret.
  STUN_URLS: z.string().default("stun:stun.l.google.com:19302"),
  TURN_URLS: z.string().default(""),
  TURN_SECRET: z.string().min(8).optional(),
  TURN_CREDENTIAL_TTL_SECONDS: z.coerce.number().int().min(60).default(3600),
  /** How long the callee gets to answer before the call becomes "missed". */
  CALL_RING_TIMEOUT_SECONDS: z.coerce.number().int().min(10).default(45),
  CALL_SWEEP_SECONDS: z.coerce.number().int().min(5).default(15),

  // Abuse prevention (spec §30)
  EXTERNAL_EMAIL_DAILY_LIMIT: z.coerce.number().int().default(50),

  // Phase 5C security timers.
  /** Grace before a deletion request becomes final (WhatsApp uses 30 days). */
  ACCOUNT_DELETION_GRACE_DAYS: z.coerce.number().int().min(1).default(30),
  /** How often the server drains expired disappearing messages. */
  EPHEMERAL_SWEEP_SECONDS: z.coerce.number().int().min(5).default(60),
  /** How often the server finalises past-grace account deletions. */
  DELETION_SWEEP_SECONDS: z.coerce.number().int().min(60).default(3600),

  // Push (Phase 5G). Everything here stays server-side; the only key a client
  // receives is the VAPID *public* one, which is public by design. With no
  // credentials configured the app still works — alerts land in the centre and
  // over the socket, they just never wake a closed app.
  PUSH_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  EXPO_ACCESS_TOKEN: z.string().optional(),
  EXPO_PUSH_URL: z.string().url().default("https://exp.host/--/api/v2/push/send"),
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  /** Contact address VAPID asks for so a push service can reach the sender. */
  VAPID_SUBJECT: z.string().default("mailto:push@convo.local"),
});

export type Config = z.infer<typeof envSchema> & { isProduction: boolean; isDev: boolean };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  if (parsed.data.NODE_ENV === "production" && parsed.data.DEV_EXPOSE_OTP) {
    throw new Error("DEV_EXPOSE_OTP must not be enabled in production");
  }
  if (
    parsed.data.MEDIA_STORAGE_PROVIDER === "supabase" &&
    (!parsed.data.SUPABASE_URL || !parsed.data.SUPABASE_SERVICE_ROLE_KEY)
  ) {
    throw new Error("MEDIA_STORAGE_PROVIDER=supabase requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  }
  if (parsed.data.TURN_URLS && !parsed.data.TURN_SECRET) {
    throw new Error("TURN_URLS requires TURN_SECRET so per-call credentials can be minted");
  }
  if (Boolean(parsed.data.VAPID_PUBLIC_KEY) !== Boolean(parsed.data.VAPID_PRIVATE_KEY)) {
    throw new Error("Web push needs both VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY (or neither)");
  }
  return {
    ...parsed.data,
    isProduction: parsed.data.NODE_ENV === "production",
    isDev: parsed.data.NODE_ENV === "development",
  };
}
