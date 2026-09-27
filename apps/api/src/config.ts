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

  // Abuse prevention (spec §30)
  EXTERNAL_EMAIL_DAILY_LIMIT: z.coerce.number().int().default(50),
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
  return {
    ...parsed.data,
    isProduction: parsed.data.NODE_ENV === "production",
    isDev: parsed.data.NODE_ENV === "development",
  };
}
