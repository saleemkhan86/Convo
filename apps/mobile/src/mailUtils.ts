import type { MailMessage, MailThreadSummary } from "@convo/shared";

/** The participants other than me — display names, falling back to addresses. */
export function otherParticipants(thread: MailThreadSummary, myEmail: string | null): string[] {
  return thread.participants
    .filter((p) => p.address !== myEmail)
    .map((p) => p.displayName ?? p.address);
}

export function threadTitle(thread: MailThreadSummary, myEmail: string | null): string {
  return thread.subject ?? otherParticipants(thread, myEmail)[0] ?? "Conversation";
}

export function participantsLabel(thread: MailThreadSummary, myEmail: string | null): string {
  const others = otherParticipants(thread, myEmail);
  if (others.length === 0) return "No recipients yet";
  return others.join(", ");
}

export function previewText(thread: MailThreadSummary): string {
  const last = thread.lastMessage;
  if (!last) return "No messages yet";
  return last.bodyText ?? last.subject ?? "";
}

export function senderLabel(message: MailMessage, myEmail: string | null): string {
  if (message.direction === "OUTBOUND" || message.fromAddress === myEmail) return "You";
  return message.fromAddress;
}

export function avatarInitial(name: string): string {
  return name.replace(/[^\p{L}\p{N}]/gu, "").charAt(0).toUpperCase() || "?";
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

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong";
}
