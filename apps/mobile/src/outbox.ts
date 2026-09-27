/**
 * In-memory outbox for messages queued while a send failed (offline / transient
 * error). Sends are idempotent server-side via clientMessageId, so replaying is
 * always safe. Persistence across app restarts is a documented follow-up; this
 * keeps Phase 2 runnable in Expo Go without extra native modules.
 */
export interface OutboxItem {
  conversationId: string;
  clientMessageId: string;
  body: string;
  queuedAt: number;
}

export function newClientMessageId(): string {
  // RFC 4122 v4 UUID from Math.random — avoids a native crypto dependency so
  // the app stays runnable in Expo Go. Server dedups on this value.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

const items = new Map<string, OutboxItem>();

export function outboxSnapshot(): OutboxItem[] {
  return [...items.values()].sort((a, b) => a.queuedAt - b.queuedAt);
}

export function outboxAdd(item: OutboxItem): void {
  items.set(item.clientMessageId, item);
}

export function outboxRemove(clientMessageId: string): void {
  items.delete(clientMessageId);
}

export function outboxFor(conversationId: string): OutboxItem[] {
  return outboxSnapshot().filter((i) => i.conversationId === conversationId);
}
