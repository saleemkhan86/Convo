/**
 * Offline outbox (spec §23): messages sent while disconnected persist in
 * localStorage and replay on reconnect. Each item carries its
 * clientMessageId, so a replay that races an earlier successful delivery is
 * deduplicated server-side — retries can never duplicate a message.
 */

export interface OutboxItem {
  conversationId: string;
  clientMessageId: string;
  body: string;
  queuedAt: number;
}

const STORAGE_KEY = "convo.outbox";

export function newClientMessageId(): string {
  return crypto.randomUUID();
}

export function loadOutbox(): OutboxItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as OutboxItem[]) : [];
  } catch {
    return [];
  }
}

export function saveOutbox(items: OutboxItem[]): void {
  try {
    if (items.length === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    // storage full/blocked — outbox is best-effort
  }
}

export function addToOutbox(item: OutboxItem): OutboxItem[] {
  const items = [...loadOutbox().filter((i) => i.clientMessageId !== item.clientMessageId), item];
  saveOutbox(items);
  return items;
}

export function removeFromOutbox(clientMessageId: string): OutboxItem[] {
  const items = loadOutbox().filter((i) => i.clientMessageId !== clientMessageId);
  saveOutbox(items);
  return items;
}
