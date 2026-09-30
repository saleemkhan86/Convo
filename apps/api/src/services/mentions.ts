/**
 * @mention resolution (Phase 5E).
 *
 * Mentions are parsed from the message body against the group's own roster, so
 * a client never declares "I mentioned user X" — the ids come from serverside
 * matching and cannot be forged into someone else's chat. Names are matched
 * case-insensitively, longest candidate first, and only on a word boundary so
 * "@Sam" never fires for a member called "Sammy" (or an email in the body).
 */

export interface MentionableMember {
  userId: string;
  displayName: string | null;
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A member answers to their full name and, for two-word names, their first word. */
function candidates(name: string): string[] {
  const trimmed = name.trim();
  const first = trimmed.split(/\s+/)[0] ?? trimmed;
  return first === trimmed ? [trimmed] : [trimmed, first];
}

/** `@` that is not part of an email address or a handle inside a word. */
const AT_BOUNDARY = String.raw`(?<![\w.+-])`;

function mentionPattern(name: string): RegExp {
  return new RegExp(`${AT_BOUNDARY}@${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, "iu");
}

/** Ids of roster members named in `body`, in roster order and without repeats. */
export function parseMentions(body: string | null | undefined, roster: MentionableMember[]): string[] {
  // No "@" in the text means no mention can exist, whatever the roster holds.
  if (!body || !body.includes("@")) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const member of roster) {
    if (seen.has(member.userId)) continue;
    const name = member.displayName?.trim();
    if (!name) continue;
    for (const candidate of candidates(name)) {
      if (candidate.length === 0) continue;
      if (mentionPattern(candidate).test(body)) {
        seen.add(member.userId);
        ids.push(member.userId);
        break;
      }
    }
  }
  return ids;
}
