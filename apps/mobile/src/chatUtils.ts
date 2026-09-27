import type { ConversationSummary } from "@convo/shared";

export function peerName(conv: Pick<ConversationSummary, "type" | "title" | "peer">): string {
  if (conv.type === "GROUP") return conv.title ?? "Group";
  return conv.peer?.displayName ?? conv.peer?.phone ?? "Unknown";
}

export function avatarInitial(name: string): string {
  return name.replace(/[^\p{L}\p{N}]/gu, "").charAt(0).toUpperCase() || "?";
}

export function previewText(conv: ConversationSummary): string {
  const last = conv.lastMessage;
  if (!last) return "No messages yet";
  if (last.deletedAt) return "Message deleted";
  return last.body ?? "";
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
