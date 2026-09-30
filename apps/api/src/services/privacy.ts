import type { PrismaClient } from "@prisma/client";
import type { GroupAddVisibility, ProfileVisibility } from "@convo/shared";

/**
 * Per-field privacy (Phase 5C, spec §34). Each rule answers "may `viewerId`
 * see this one facet of `ownerId`'s presence/profile?" — always resolved
 * from the owner's stored settings, never from a client claim.
 */

export const VISIBILITY_FIELDS = ["avatar", "about", "online"] as const;
export type PrivacyField = (typeof VISIBILITY_FIELDS)[number];

/** The visibility columns + exclusion list, however the row was loaded. */
export type PrivacyOwner = {
  avatarVisibility: ProfileVisibility;
  aboutVisibility: ProfileVisibility;
  onlineVisibility: ProfileVisibility;
  visibilityExcluded?: unknown;
};

/**
 * userIds the account hid under CONTACTS_EXCEPT. Anything that is not a JSON
 * array of strings is read as "nobody hidden" — the safe interpretation of
 * corrupt data, since every broader mode can be re-checked by the owner.
 */
export function excludedIds(raw: unknown): Set<string> {
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.filter((v): v is string => typeof v === "string"));
}

export function visibilityFor(owner: PrivacyOwner, field: PrivacyField): ProfileVisibility {
  switch (field) {
    case "avatar":
      return owner.avatarVisibility;
    case "about":
      return owner.aboutVisibility;
    case "online":
      return owner.onlineVisibility;
  }
}

/**
 * Core rule, parameterised so unit tests can pin the semantics:
 *  - EVERYONE: visible to all.
 *  - CONTACTS: only viewers the owner has saved as a contact.
 *  - CONTACTS_EXCEPT: same, minus the owner's explicit exclusion list
 *    (WhatsApp's "My contacts except…").
 *  - NONE: hidden.
 */
export function fieldVisibleTo(
  visibility: ProfileVisibility,
  opts: { savedViewer: boolean; excluded: boolean },
): boolean {
  switch (visibility) {
    case "EVERYONE":
      return true;
    case "CONTACTS":
      return opts.savedViewer;
    case "CONTACTS_EXCEPT":
      return opts.savedViewer && !opts.excluded;
    case "NONE":
      return false;
  }
}

/**
 * Whether `viewerId` may see `field` of `owner`. The CONTACTS modes reuse the
 * last-seen rule: the owner must have saved the viewer as a contact.
 */
export async function fieldVisibleToUser(
  db: PrismaClient,
  viewerId: string,
  owner: PrivacyOwner & { id: string },
  field: PrivacyField,
): Promise<boolean> {
  const visibility = visibilityFor(owner, field);
  if (visibility === "EVERYONE") return true;
  if (visibility === "NONE") return false;
  if (
    visibility === "CONTACTS_EXCEPT" &&
    excludedIds(owner.visibilityExcluded ?? null).has(viewerId)
  ) {
    return false;
  }
  const saved = await db.contact.findFirst({
    where: { ownerId: owner.id, convoUserId: viewerId },
    select: { id: true },
  });
  return saved !== null;
}

/** Whether `actorId` may add `targetId` to a group (5C who-can-add-me). */
export async function mayAddToGroup(
  db: PrismaClient,
  actorId: string,
  targetId: string,
  target: { groupAddVisibility: GroupAddVisibility },
): Promise<boolean> {
  switch (target.groupAddVisibility) {
    case "EVERYONE":
      return true;
    case "NOBODY":
      return false;
    case "CONTACTS": {
      const saved = await db.contact.findFirst({
        where: { ownerId: targetId, convoUserId: actorId },
        select: { id: true },
      });
      return saved !== null;
    }
  }
}

/**
 * Privacy columns a visibility check needs. Every query that renders another
 * person's profile through `peerOf`/`getUserCard` must select at least this.
 */
const PRIVACY_SELECT = {
  avatarVisibility: true,
  aboutVisibility: true,
  onlineVisibility: true,
  visibilityExcluded: true,
} as const;

/**
 * The user-row shape every profile render needs: the visibility columns plus
 * the fields the card itself shows. Spread into a Prisma query as
 * `...PROFILE_QUERY` — it selects rather than includes, because the privacy
 * columns are scalars.
 */
export const PROFILE_QUERY = {
  select: {
    id: true,
    status: true,
    displayName: true,
    avatarUrl: true,
    bio: true,
    lastSeenAt: true,
    presenceVisibility: true,
    phoneIdentity: true,
    ...PRIVACY_SELECT,
  },
} as const;
