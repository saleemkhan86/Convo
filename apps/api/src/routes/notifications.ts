import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  dismissNotificationsRequestSchema,
  listNotificationsQuerySchema,
  markNotificationsReadRequestSchema,
} from "@convo/shared";
import type { AppDeps } from "../deps.js";
import { unauthorized } from "../lib/errors.js";
import { parse } from "../lib/validation.js";
import { authenticatePreHandler } from "../plugins/auth.js";
import {
  dismissNotifications,
  listNotifications,
  markNotificationsRead,
  unreadNotificationCount,
  type NotifyDeps,
} from "../services/notifications.js";

/**
 * Notification centre API (Phase 5G): the bell's list, its badge, and the two
 * ways out of it (read, dismissed). There is no "create" — rows are written by
 * whatever happens, never by a client, so a caller can only ever see and settle
 * its own alerts.
 */
export async function notificationRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.addHook("preHandler", authenticatePreHandler(deps.db));
  const svc: NotifyDeps = { db: deps.db, hub: deps.hub, push: deps.push };

  app.get("/notifications", async (request) => {
    const query = parse(listNotificationsQuerySchema, request.query);
    return listNotifications(deps.db, requireUserId(request), query);
  });

  app.get("/notifications/unread-count", async (request) =>
    unreadNotificationCount(deps.db, requireUserId(request)),
  );

  app.post("/notifications/read", async (request) => {
    const body = parse(markNotificationsReadRequestSchema, request.body);
    return markNotificationsRead(svc, requireUserId(request), body);
  });

  app.post("/notifications/dismiss", async (request) => {
    const body = parse(dismissNotificationsRequestSchema, request.body);
    return dismissNotifications(svc, requireUserId(request), body);
  });

  /**
   * A browser cannot subscribe to push without the VAPID *public* key, and a
   * public key is the one credential that is safe to hand out. Null means this
   * server has no web push configured, so the client hides the toggle instead of
   * asking for a permission it can never satisfy.
   */
  app.get("/notifications/web-push-key", async () => ({
    key: deps.push?.vapidPublicKey() ?? null,
  }));
}

function requireUserId(request: FastifyRequest): string {
  if (!request.currentUser) throw unauthorized();
  return request.currentUser.id;
}
