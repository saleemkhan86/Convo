import type { Prisma } from "@prisma/client";
import { capabilitiesOf, identityStateOf, type Account } from "@convo/shared";

export const userWithIdentities = {
  include: { phoneIdentity: true, emailIdentity: true },
} as const;

export type UserWithIdentities = Prisma.UserGetPayload<typeof userWithIdentities>;

export function toAccount(user: UserWithIdentities): Account {
  const phone = user.phoneIdentity
    ? { phone: user.phoneIdentity.phone, verifiedAt: user.phoneIdentity.verifiedAt.toISOString() }
    : null;
  const email = user.emailIdentity
    ? {
        email: user.emailIdentity.email,
        verifiedAt: user.emailIdentity.verifiedAt.toISOString(),
      }
    : null;
  const state = identityStateOf({ phone, email });
  return {
    id: user.id,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    bio: user.bio,
    phone,
    email,
    capabilities: capabilitiesOf(state),
    createdAt: user.createdAt.toISOString(),
  };
}
