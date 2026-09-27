import type { PrismaClient } from "@prisma/client";
import type { MailRoute } from "@convo/shared";

export interface MailRouteDecision {
  route: MailRoute;
  /** Set when the address belongs to a Convo email identity. */
  convoUserId?: string;
}

/**
 * Routing decision for a recipient address (spec §16):
 * recognized Convo email identity → internal delivery; otherwise external SMTP.
 *
 * Privacy: this resolver is INTERNAL ONLY. No public endpoint may expose
 * whether an arbitrary address belongs to a Convo user (enumeration risk).
 * The composer UI must treat both routes identically.
 */
export async function resolveMailRoute(
  db: PrismaClient,
  address: string,
): Promise<MailRouteDecision> {
  const normalized = address.trim().toLowerCase();
  const identity = await db.emailIdentity.findUnique({
    where: { email: normalized },
    select: { userId: true },
  });
  if (identity) {
    return { route: "CONVO_INTERNAL", convoUserId: identity.userId };
  }
  return { route: "EXTERNAL_SMTP" };
}
