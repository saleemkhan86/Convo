import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppDeps } from "../deps.js";
import { syncConversation, syncAllConversations, markDeviceDelivered, markDeviceRead } from "../services/delivery.js";
import { authenticatePreHandler } from "../plugins/auth.js";
import { mediaDownloadUrl } from "./media.js";
import { unauthorized } from "../lib/errors.js";

/**
 * Sync routes (Stage 4): devices call these on reconnection to fetch messages
 * they missed while offline. Each device tracks its last seen sequence number
 * per conversation and passes it as `afterSequence` to get only new messages.
 */
export async function syncRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.addHook("preHandler", authenticatePreHandler(deps.db));

  /**
   * GET /sync/:conversationId?afterSequence=N
   *
   * Sync one conversation: return all messages newer than sequence N. The
   * device passes the last sequence number it saw; the server returns
   * everything after that, in order.
   */
  app.get("/sync/:conversationId", async (request, reply) => {
    const userId = requireUserId(request);

    const { conversationId } = request.params as { conversationId: string };
    const { afterSequence, deviceId } = request.query as {
      afterSequence?: string;
      deviceId?: string;
    };

    const cursor = afterSequence ? parseInt(afterSequence, 10) : null;
    const resolvedDeviceId = deviceId ?? `sync-${Date.now()}`;

    const result = await syncConversation(
      { db: deps.db, hub: deps.hub, mediaUrl: (key) => mediaDownloadUrl(app, deps, key) },
      userId,
      resolvedDeviceId,
      conversationId,
      cursor,
    );

    return reply.send(result);
  });

  /**
   * POST /sync/batch
   *
   * Sync multiple conversations at once. The body is a map of
   * conversationId → lastSequenceNumber. Returns only conversations with
   * new messages.
   *
   * This is the efficient reconnection path: a device that was offline for
   * a while can fetch all missed messages in one round trip instead of
   * polling each chat.
   */
  app.post("/sync/batch", async (request, reply) => {
    const userId = requireUserId(request);

    const { cursors, deviceId } = request.body as {
      cursors: Record<string, number>;
      deviceId?: string;
    };

    const resolvedDeviceId = deviceId ?? `sync-${Date.now()}`;
    const cursorMap = new Map(Object.entries(cursors));

    const results = await syncAllConversations(
      { db: deps.db, hub: deps.hub, mediaUrl: (key) => mediaDownloadUrl(app, deps, key) },
      userId,
      resolvedDeviceId,
      cursorMap,
    );

    // Convert Map to object for JSON serialization
    const response: Record<string, { messages: unknown[]; nextSequence: number | null }> = {};
    for (const [conversationId, result] of results.entries()) {
      response[conversationId] = result;
    }

    return reply.send(response);
  });

  /**
   * POST /sync/delivered
   *
   * Mark a message as delivered to this device. Called by the client when it
   * successfully receives and stores a message. This is more granular than
   * the per-user receipt — it tracks which specific devices have the message.
   */
  app.post("/sync/delivered", async (request, reply) => {
    const userId = requireUserId(request);
    const { messageId, deviceId } = request.body as {
      messageId: string;
      deviceId?: string;
    };

    const resolvedDeviceId = deviceId ?? `device-${Date.now()}`;

    await markDeviceDelivered(
      { db: deps.db, hub: deps.hub, mediaUrl: (key) => mediaDownloadUrl(app, deps, key) },
      messageId,
      userId,
      resolvedDeviceId,
    );

    return reply.send({ success: true });
  });

  /**
   * POST /sync/read
   *
   * Mark a message as read on this device. Called when the user opens a
   * message or the chat. Updates both the per-device delivery record and
   * the per-user receipt for backwards compatibility.
   */
  app.post("/sync/read", async (request, reply) => {
    const userId = requireUserId(request);
    const { messageId, deviceId } = request.body as {
      messageId: string;
      deviceId?: string;
    };

    const resolvedDeviceId = deviceId ?? `device-${Date.now()}`;

    await markDeviceRead(
      { db: deps.db, hub: deps.hub, mediaUrl: (key) => mediaDownloadUrl(app, deps, key) },
      messageId,
      userId,
      resolvedDeviceId,
    );

    return reply.send({ success: true });
  });
}

function requireUserId(request: FastifyRequest): string {
  if (!request.currentUser) throw unauthorized();
  return request.currentUser.id;
}
