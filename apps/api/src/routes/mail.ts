import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  composeMailRequestSchema,
  cursorQuerySchema,
  replyMailRequestSchema,
} from "@convo/shared";
import type { AppDeps } from "../deps.js";
import { unauthorized } from "../lib/errors.js";
import { parse } from "../lib/validation.js";
import { authenticatePreHandler } from "../plugins/auth.js";
import { notifyUser, type NotifyDeps as NotificationDeps } from "../services/notifications.js";
import {
  composeMail,
  listThreadMessages,
  listThreads,
  markThreadRead,
  replyToThread,
  type MailDeps,
} from "../services/mail.js";

export async function mailRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.addHook("preHandler", authenticatePreHandler(deps.db));
  const notifySvc: NotificationDeps = { db: deps.db, hub: deps.hub, push: deps.push };
  const svc: MailDeps = {
    db: deps.db,
    hub: deps.hub,
    // Phase 5G: notify each internal recipient about a new mail message.
    notifyRecipient: (userId, title, body, actorId, conversationId, messageId) =>
      notifyUser(notifySvc, { userId, type: "MAIL_MESSAGE", title, body, actorId, conversationId, messageId }),
  };

  app.get("/mail/threads", async (request) => {
    const q = parse(cursorQuerySchema, request.query);
    return listThreads(svc, requireUserId(request), q);
  });

  app.get("/mail/threads/:id/messages", async (request) => {
    const { id } = request.params as { id: string };
    const q = parse(cursorQuerySchema, request.query);
    return listThreadMessages(svc, requireUserId(request), id, q);
  });

  app.post(
    "/mail/send",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request) => {
      const body = parse(composeMailRequestSchema, request.body);
      return composeMail(svc, requireUserId(request), body);
    },
  );

  app.post(
    "/mail/threads/:id/reply",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = parse(replyMailRequestSchema, request.body);
      return replyToThread(svc, requireUserId(request), id, body);
    },
  );

  app.post("/mail/threads/:id/read", async (request) => {
    const { id } = request.params as { id: string };
    await markThreadRead(svc, requireUserId(request), id);
    return { ok: true };
  });
}

function requireUserId(request: FastifyRequest): string {
  if (!request.currentUser) throw unauthorized();
  return request.currentUser.id;
}
