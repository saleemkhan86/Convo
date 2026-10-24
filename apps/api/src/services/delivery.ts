import type { PrismaClient } from "@prisma/client";
import type { RealtimeHub } from "./realtime.js";
import type { Message } from "@convo/shared";
import { serializeMessage, type MediaUrlFor } from "./conversations.js";

/**
 * Message delivery service (Stage 4): handles offline queuing and reconnection
 * sync. Each device tracks its last synced sequence number per conversation,
 * so on reconnection it can fetch missed messages without gaps.
 *
 * The offline queue is implicit: messages are stored in the database with
 * sequence numbers, and devices sync by requesting messages newer than their
 * last known sequence number. This avoids maintaining a separate queue.
 */

export interface DeliveryServiceDeps {
  db: PrismaClient;
  hub: RealtimeHub;
  mediaUrl: MediaUrlFor;
}

/**
 * Sync result: messages a device missed while offline, plus the new cursor
 * position for the next sync.
 */
export interface SyncResult {
  messages: Message[];
  /** Pass as `afterSequence` on the next sync to continue from here. */
  nextSequence: number | null;
}

/**
 * Sync a device's view of a conversation: return all messages newer than
 * `afterSequence` (the last sequence number the device saw). This is the
 * reconnection path — a device that was offline calls this on reconnect to
 * catch up without gaps.
 */
export async function syncConversation(
  deps: DeliveryServiceDeps,
  userId: string,
  deviceId: string,
  conversationId: string,
  afterSequence: number | null,
): Promise<SyncResult> {
  const { db, mediaUrl } = deps;

  // Verify membership
  const member = await db.conversationMember.findFirst({
    where: { userId, conversationId, leftAt: null },
    select: { id: true },
  });
  if (!member) {
    return { messages: [], nextSequence: null };
  }

  // Fetch messages newer than the cursor
  const messages = await db.message.findMany({
    where: {
      conversationId,
      ...(afterSequence !== null ? { sequenceNumber: { gt: afterSequence } } : {}),
      deletedAt: null,
    },
    orderBy: { sequenceNumber: "asc" },
    include: {
      reactions: true,
      receipts: true,
      starredBy: true,
      attachments: true,
      forwardedFrom: { select: { id: true, displayName: true } },
      viewOnceViews: { select: { userId: true } },
      mentions: { select: { userId: true } },
      pin: { select: { pinnedById: true, pinnedAt: true, user: { select: { displayName: true } } } },
    },
  });

  // Update the device's sync cursor. `updateMany` because callers may pass a
  // transient id (routes default to a fabricated one); a missing row must not
  // turn a successful sync into a 500.
  const lastMessage = messages[messages.length - 1];
  if (lastMessage) {
    await db.device.updateMany({
      where: { id: deviceId },
      data: { lastSyncedAt: new Date() },
    });
  }

  return {
    messages: messages.map((m) => serializeMessage(m, userId, mediaUrl)),
    nextSequence: lastMessage?.sequenceNumber ?? afterSequence,
  };
}

/**
 * Sync all conversations a user is a member of. Returns a map of
 * conversationId → SyncResult for each chat with new messages.
 */
export async function syncAllConversations(
  deps: DeliveryServiceDeps,
  userId: string,
  deviceId: string,
  cursors: Map<string, number>,
): Promise<Map<string, SyncResult>> {
  const { db } = deps;

  const memberships = await db.conversationMember.findMany({
    where: { userId, leftAt: null },
    select: { conversationId: true },
  });

  const results = new Map<string, SyncResult>();
  for (const membership of memberships) {
    const afterSequence = cursors.get(membership.conversationId) ?? null;
    const result = await syncConversation(
      deps,
      userId,
      deviceId,
      membership.conversationId,
      afterSequence,
    );
    if (result.messages.length > 0) {
      results.set(membership.conversationId, result);
    }
  }

  return results;
}

/**
 * Mark a message as delivered to a specific device. This updates the
 * DeviceMessageDelivery record to set deliveredAt, and also updates the
 * per-user MessageReceipt for backwards compatibility.
 */
export async function markDeviceDelivered(
  deps: DeliveryServiceDeps,
  messageId: string,
  userId: string,
  deviceId: string,
): Promise<void> {
  const { db } = deps;

  // Update the per-device delivery record
  await db.deviceMessageDelivery.updateMany({
    where: { deviceId, messageId, deliveredAt: null },
    data: { deliveredAt: new Date() },
  });

  // Update the per-user receipt (backwards compatibility)
  await db.messageReceipt.updateMany({
    where: { messageId, userId, deliveredAt: null },
    data: { deliveredAt: new Date() },
  });

  // Update device sync cursor
  await db.device.updateMany({
    where: { id: deviceId },
    data: { lastSyncedAt: new Date() },
  });
}

/**
 * Mark a message as read on a specific device. This updates the
 * DeviceMessageDelivery record to set readAt, and also updates the
 * per-user MessageReceipt for backwards compatibility.
 */
export async function markDeviceRead(
  deps: DeliveryServiceDeps,
  messageId: string,
  userId: string,
  deviceId: string,
): Promise<void> {
  const { db } = deps;

  // Update the per-device delivery record
  await db.deviceMessageDelivery.updateMany({
    where: { deviceId, messageId, readAt: null },
    data: { readAt: new Date() },
  });

  // Update the per-user receipt (backwards compatibility)
  await db.messageReceipt.updateMany({
    where: { messageId, userId, readAt: null },
    data: { readAt: new Date() },
  });
}
