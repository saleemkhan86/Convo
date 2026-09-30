import type { AttachmentKind, ConversationSummary, GroupMember, Message } from "@convo/shared";

export function peerName(conv: Pick<ConversationSummary, "type" | "title" | "peer">): string {
  if (conv.type === "GROUP") return conv.title ?? "Group";
  return conv.peer?.displayName ?? conv.peer?.phone ?? "Unknown";
}

export function avatarInitial(name: string): string {
  return name.replace(/[^\p{L}\p{N}]/gu, "").charAt(0).toUpperCase() || "?";
}

/** Human label for a media kind ("Photo", "Voice message", the file name…). */
export function attachmentKindLabel(kind: AttachmentKind | string | null, fileName: string | null): string | null {
  if (!kind || kind === "TEXT") return null;
  switch (kind) {
    case "IMAGE":
      return "Photo";
    case "VIDEO":
      return "Video";
    case "VOICE":
      return "Voice message";
    case "DOCUMENT":
      return fileName ?? "Document";
    case "LOCATION":
      return "Location";
    case "CONTACT":
      return "Contact card";
    default:
      return fileName ?? "Attachment";
  }
}

/** One-line description of a message for lists, the reply strip and reports. */
export function messageLabel(message: Message): string {
  if (message.viewOnce) return "View once";
  if (message.location) return "Location";
  if (message.contactCard) return "Contact card";
  const media = message.attachments[0];
  return message.body ?? attachmentKindLabel(media?.kind ?? null, media?.fileName ?? null) ?? "Message";
}

/**
 * The quote line inside a reply bubble. `replyPreview` is the server snapshot, so
 * the quote survives even when the quoted message is outside the loaded page.
 */
export function replyQuoteLabel(message: Message, quoted: Message | null): string | null {
  const preview = message.replyPreview;
  if (message.statusReply) {
    const line =
      preview?.body ?? attachmentKindLabel(preview?.kind ?? null, preview?.fileName ?? null);
    return line ? `Status reply · ${line}` : "Status reply";
  }
  if (preview) {
    if (preview.type === "LOCATION") return "Location";
    if (preview.type === "CONTACT") return "Contact card";
    return preview.body ?? attachmentKindLabel(preview.kind, preview.fileName) ?? "Message";
  }
  if (!message.replyToId) return null;
  if (!quoted) return "Message";
  if (quoted.deletedAt) return "Deleted message";
  return messageLabel(quoted);
}

export function previewText(conv: ConversationSummary): string {
  const last = conv.lastMessage;
  if (!last) return "No messages yet";
  if (last.deletedAt) return "Message deleted";
  return messageLabel(last);
}

export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString();
}

export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function lastSeenLabel(lastSeenAt: string | null): string {
  if (!lastSeenAt) return "";
  const diff = Date.now() - new Date(lastSeenAt).getTime();
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return "last seen just now";
  if (mins < 60) return `last seen ${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `last seen ${hours}h ago`;
  return `last seen ${relativeTime(lastSeenAt)} ago`;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong";
}

/** A member's name the way the roster shows it. */
export function memberLabel(member: Pick<GroupMember, "displayName" | "phone">): string {
  return member.displayName ?? member.phone ?? "Convo user";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The `@token` being typed at the end of the composer text, or null. The `@`
 * must open the text or follow whitespace, so an email never opens the typeahead.
 */
export function mentionTokenAt(text: string): string | null {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(text);
  return match?.[1] ?? null;
}

/** Display names of the members a message mentions, resolved from the roster. */
export function mentionNamesOf(message: Message, names: Map<string, string>): string[] {
  return message.mentions
    .map((userId) => names.get(userId))
    .filter((name): name is string => Boolean(name));
}

/**
 * Body text cut into plain and mention chunks, so the UI can paint pills. Only
 * names the server resolved are matched, mirroring its word-boundary rule.
 */
export function splitMentions(
  body: string,
  names: string[],
): Array<{ text: string; mentioned: boolean }> {
  if (!body.includes("@") || names.length === 0) return [{ text: body, mentioned: false }];
  const alternation = [...names]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|");
  const pattern = new RegExp(`@(?:${alternation})(?![\\p{L}\\p{N}])`, "gi");
  const chunks: Array<{ text: string; mentioned: boolean }> = [];
  let cursor = 0;
  for (const match of body.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > cursor) chunks.push({ text: body.slice(cursor, start), mentioned: false });
    chunks.push({ text: match[0], mentioned: true });
    cursor = start + match[0].length;
  }
  if (cursor < body.length) chunks.push({ text: body.slice(cursor), mentioned: false });
  return chunks.length > 0 ? chunks : [{ text: body, mentioned: false }];
}
