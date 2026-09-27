import { z } from "zod";
import { accountSchema, emailAddressSchema, e164PhoneSchema } from "./identity.js";

export const otpLength = 6;
export const otpSchema = z.string().regex(new RegExp(`^\\d{${otpLength}}$`), "Enter the 6-digit code");

export const challengeSchema = z.object({
  challengeId: z.string(),
  expiresInSeconds: z.number().int(),
  /** Only populated when the server runs with DEV_EXPOSE_OTP=true (local development). */
  devOtp: z.string().optional(),
});
export type Challenge = z.infer<typeof challengeSchema>;

export const sessionTokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  accessExpiresInSeconds: z.number().int(),
});
export type SessionTokens = z.infer<typeof sessionTokensSchema>;

export const authResultSchema = z.object({
  session: sessionTokensSchema,
  account: accountSchema,
  isNewAccount: z.boolean(),
});
export type AuthResult = z.infer<typeof authResultSchema>;

// --- Unauthenticated auth flows (A–D) ---

export const requestPhoneOtpRequestSchema = z.object({ phone: e164PhoneSchema });
export const verifyPhoneOtpRequestSchema = z.object({
  challengeId: z.string().min(1),
  code: otpSchema,
});

export const requestEmailOtpRequestSchema = z.object({ email: emailAddressSchema });
export const verifyEmailOtpRequestSchema = z.object({
  challengeId: z.string().min(1),
  code: otpSchema,
});

export const refreshRequestSchema = z.object({ refreshToken: z.string().min(1) });

// --- Authenticated identity linking (flow E) ---

export const connectIdentityRequestSchema = z.object({
  challengeId: z.string().min(1),
  code: otpSchema,
});

// --- Profile ---

export const updateProfileRequestSchema = z.object({
  displayName: z.string().trim().min(1).max(64).nullable().optional(),
  avatarUrl: z.string().url().max(2048).nullable().optional(),
  bio: z.string().trim().max(280).nullable().optional(),
});
export type UpdateProfileRequest = z.infer<typeof updateProfileRequestSchema>;

// --- Mail routing (section 16 of the spec) ---

export const mailRouteSchema = z.enum(["CONVO_INTERNAL", "EXTERNAL_SMTP"]);
export type MailRoute = z.infer<typeof mailRouteSchema>;
