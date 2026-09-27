import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  cursorQuerySchema,
  markReadRequestSchema,
  sendMessageRequestSchema,
  startConversationRequestSchema,
} from "@convo/shared";
import type { AppDeps } from "../deps.js";
import { unauthorized } from "../lib/errors.js";
import { parse } from "../lib/validation.js";
import { authenticatePreHandler } from "../plugins/auth.js";
import {
  listConversations,
  listMessages,
  markRead,
  sendMessage,
  startDirectConversation,
  type ConversationDeps,
} from "../services/conversations.js";

export async function conversationRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.addHook("preHandler", authenticatePreHandler(deps.db));
  const svc: ConversationDeps = { db: deps.db, hub: deps.hub };

  app.post(
    "/conversations/start",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request) => {
      const { phone } = parse(startConversationRequestSchema, request.body);
      return startDirectConversation(svc, requireUserId(request), phone);
    },
  );

  app.get("/conversations", async (request) => {
    const q = parse(cursorQuerySchema, request.query);
    return listConversations(svc, requireUserId(request), q);
  });

  app.get("/conversations/:id/messages", async (request) => {
    const { id } = request.params as { id: string };
    const q = parse(cursorQuerySchema, request.query);
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
    return { ok: true };
  });
}

function requireUserId(request: FastifyRequest): string {
  if (!request.currentUser) throw unauthorized();
  return request.currentUser.id;
}
