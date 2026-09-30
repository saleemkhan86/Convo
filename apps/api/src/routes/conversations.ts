import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  cursorQuerySchema,
  deleteMessageRequestSchema,
  editMessageRequestSchema,
  exportChatQuerySchema,
  forwardMessagesRequestSchema,
  listConversationsQuerySchema,
  listMessagesQuerySchema,
  listSharedMediaQuerySchema,
  markReadRequestSchema,
  reactMessageRequestSchema,
  sendMessageRequestSchema,
  starMessageRequestSchema,
  startConversationRequestSchema,
  updateConversationRequestSchema,
  updateEphemeralRequestSchema,
} from "@convo/shared";
import type { AppDeps } from "../deps.js";
import { unauthorized } from "../lib/errors.js";
import { parse } from "../lib/validation.js";
import { authenticatePreHandler } from "../plugins/auth.js";
import { mediaDownloadUrl } from "./media.js";
import { clearChatNotifications, notifyUser, type NotifyDeps as NotificationDeps } from "../services/notifications.js";
import {
  clearConversation,
  deleteConversationForMe,
  deleteMessage,
  editMessage,
  exportChat,
  forwardMessages,
  listConversations,
  listChatLinks,
  listMessages,
  listPinned,
  listSharedMedia,
  markRead,
  openViewOnce,
  reactMessage,
  removeReaction,
  sendMessage,
  setConversationEphemeral,
  setMessagePinned,
  setMessageStarred,
  startDirectConversation,
  updateConversationSettings,
  type ConversationDeps,
} from "../services/conversations.js";

export async function conversationRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.addHook("preHandler", authenticatePreHandler(deps.db));
  const notifySvc: NotificationDeps = { db: deps.db, hub: deps.hub, push: deps.push };
  const svc: ConversationDeps = {
    db: deps.db,
    hub: deps.hub,
    mediaUrl: (key) => mediaDownloadUrl(app, deps, key),
    linkUnfurl: {
      timeoutMs: deps.config.LINK_UNFURL_TIMEOUT_MS,
      maxBytes: deps.config.LINK_PREVIEW_MAX_BYTES,
    },
    // Phase 5G: fire a notification per recipient after each send.
    notifyRecipient: (userId, type, title, body, actorId, conversationId, messageId) =>
      notifyUser(notifySvc, { userId, type, title, body, actorId, conversationId, messageId }),
  };

  app.post(
    "/conversations/start",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request) => {
      const { phone } = parse(startConversationRequestSchema, request.body);
      return startDirectConversation(svc, requireUserId(request), phone);
    },
  );

  app.get("/conversations", async (request) => {
    const q = parse(listConversationsQuerySchema, request.query);
    return listConversations(svc, requireUserId(request), q);
  });

  app.get("/conversations/:id/messages", async (request) => {
    const { id } = request.params as { id: string };
    const q = parse(listMessagesQuerySchema, request.query);
    return listMessages(svc, requireUserId(request), id, q);
  });

  app.post(
    "/conversations/:id/messages",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = parse(sendMessageRequestSchema, request.body);
      return sendMessage(svc, requireUserId(request), id, body);
    },
  );

  app.post("/conversations/:id/read", async (request) => {
    const { id } = request.params as { id: string };
    const body = parse(markReadRequestSchema, request.body ?? {});
    await markRead(svc, requireUserId(request), id, body.messageId);
    // Phase 5G: opening a chat clears its notifications on all devices.
    void clearChatNotifications(notifySvc, requireUserId(request), id).catch(() => {});
    return { ok: true };
  });

  // ── media (Phase 5B): forward, shared-media gallery, view-once ──

  /** Multi-chat forward. Bytes are referenced, never copied, so this is cheap. */
  app.post(
    "/conversations/forward",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request) => {
      const body = parse(forwardMessagesRequestSchema, request.body);
      return forwardMessages(svc, requireUserId(request), body);
    },
  );

  /** The chat's "Media, links and docs" grid, newest first. */
  app.get("/conversations/:id/media", async (request) => {
    const { id } = request.params as { id: string };
    const q = parse(listSharedMediaQuerySchema, request.query);
    return listSharedMedia(svc, requireUserId(request), id, q);
  });

  /** The "Links" tab: every link card posted in this chat, newest first. */
  app.get("/conversations/:id/links", async (request) => {
    const { id } = request.params as { id: string };
    const q = parse(cursorQuerySchema, request.query);
    return listChatLinks(svc, requireUserId(request), id, q);
  });

  /** Burn the single view of a view-once message; returns its URLs exactly once. */
  app.post("/messages/:id/view-once", async (request) => {
    const { id } = request.params as { id: string };
    return openViewOnce(svc, requireUserId(request), id);
  });

  // ── pins (Phase 5E): shared chat state, unlike a per-viewer star ──

  app.put("/messages/:id/pin", async (request) => {
    const { id } = request.params as { id: string };
    return setMessagePinned(svc, requireUserId(request), id, true);
  });

  app.delete("/messages/:id/pin", async (request) => {
    const { id } = request.params as { id: string };
    return setMessagePinned(svc, requireUserId(request), id, false);
  });

  /** Every message pinned in this chat, newest pin first. */
  app.get("/conversations/:id/pins", async (request) => {
    const { id } = request.params as { id: string };
    const q = parse(cursorQuerySchema, request.query);
    return listPinned(svc, requireUserId(request), id, q);
  });

  // ── privacy + security (Phase 5C): disappearing timer, chat export ──

  /** 1-1 only; 0 turns the timer off. Existing messages keep their own expiry. */
  app.patch("/conversations/:id/ephemeral", async (request) => {
    const { id } = request.params as { id: string };
    const { seconds } = parse(updateEphemeralRequestSchema, request.body);
    return setConversationEphemeral(svc, requireUserId(request), id, seconds);
  });

  /** The viewer's own transcript as JSON; `includeMedia=true` signs its media. */
  app.get("/conversations/:id/export", async (request) => {
    const { id } = request.params as { id: string };
    const { includeMedia } = parse(exportChatQuerySchema, request.query);
    return exportChat(svc, requireUserId(request), id, includeMedia);
  });

  // ── chat controls (Phase 5A): pin, archive, mute, clear, delete, star ──

  /** All three are per-viewer state; the response is the refreshed summary. */
  app.patch("/conversations/:id", async (request) => {
    const { id } = request.params as { id: string };
    const body = parse(updateConversationRequestSchema, request.body);
    return updateConversationSettings(svc, requireUserId(request), id, body);
  });

  app.post("/conversations/:id/clear", async (request) => {
    const { id } = request.params as { id: string };
    return clearConversation(svc, requireUserId(request), id);
  });

  app.delete("/conversations/:id", async (request) => {
    const { id } = request.params as { id: string };
    await deleteConversationForMe(svc, requireUserId(request), id);
    return { ok: true };
  });

  app.put("/messages/:id/star", async (request) => {
    const { id } = request.params as { id: string };
    const { starred } = parse(starMessageRequestSchema, request.body ?? {});
    return setMessageStarred(svc, requireUserId(request), id, starred);
  });

  // ── chat options (Phase 4A): edit, delete, reactions ──

  app.patch("/messages/:id", async (request) => {
    const { id } = request.params as { id: string };
    const body = parse(editMessageRequestSchema, request.body);
    return editMessage(svc, requireUserId(request), id, body.body);
  });

  app.delete("/messages/:id", async (request) => {
    const { id } = request.params as { id: string };
    const body = parse(deleteMessageRequestSchema, request.body ?? {});
    await deleteMessage(svc, requireUserId(request), id, body.scope);
    return { ok: true };
  });

  app.put("/messages/:id/reactions", async (request) => {
    const { id } = request.params as { id: string };
    const body = parse(reactMessageRequestSchema, request.body);
    return reactMessage(svc, requireUserId(request), id, body.emoji);
  });

  app.delete("/messages/:id/reactions", async (request) => {
    const { id } = request.params as { id: string };
    const { emoji } = parse(reactMessageRequestSchema, request.query);
    return removeReaction(svc, requireUserId(request), id, emoji);
  });
}

function requireUserId(request: FastifyRequest): string {
  if (!request.currentUser) throw unauthorized();
  return request.currentUser.id;
}
