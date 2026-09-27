import { z } from "zod";

/**
 * Core account/identity model.
 *
 * One Convo account holds at most one phone identity and at most one email
 * identity. Either may be absent; neither creates a separate account.
 */

export const e164PhoneSchema = z
  .string()
  .regex(/^\+[1-9]\d{6,14}$/, "Phone number must be in E.164 format (e.g. +919876543210)");

export const emailAddressSchema = z
  .string()
  .trim()
  .min(3)
  .max(320)
  .email("Invalid email address")
  .transform((v) => v.toLowerCase());

export type E164Phone = z.infer<typeof e164PhoneSchema>;
export type EmailAddress = z.infer<typeof emailAddressSchema>;

export const identityStateSchema = z.enum([
  "none",
  "phone_only",
  "email_only",
  "both",
]);
export type IdentityState = z.infer<typeof identityStateSchema>;

export const phoneIdentitySchema = z.object({
  phone: e164PhoneSchema,
  verifiedAt: z.string().datetime(),
});
export type PhoneIdentity = z.infer<typeof phoneIdentitySchema>;

export const emailIdentitySchema = z.object({
  email: z.string(),
  verifiedAt: z.string().datetime(),
});
export type EmailIdentity = z.infer<typeof emailIdentitySchema>;

export const capabilitiesSchema = z.object({
  chats: z.boolean(),
  mail: z.boolean(),
});
export type Capabilities = z.infer<typeof capabilitiesSchema>;

export const accountSchema = z.object({
  id: z.string(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  bio: z.string().nullable(),
  phone: phoneIdentitySchema.nullable(),
  email: emailIdentitySchema.nullable(),
  capabilities: capabilitiesSchema,
  createdAt: z.string().datetime(),
});
export type Account = z.infer<typeof accountSchema>;

export function identityStateOf(account: {
  phone: unknown | null;
  email: unknown | null;
}): IdentityState {
  if (account.phone && account.email) return "both";
  if (account.phone) return "phone_only";
  if (account.email) return "email_only";
  return "none";
}

export function capabilitiesOf(state: IdentityState): Capabilities {
  return { chats: state === "phone_only" || state === "both", mail: state === "email_only" || state === "both" };
}
