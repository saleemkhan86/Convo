import type { FastifyInstance, FastifyRequest } from "fastify";
import { createStatusRequestSchemaChecked, replyToStatusRequestSchema } from "@convo/shared";
import type { AppDeps } from "../deps.js";
import { unauthorized } from "../lib/errors.js";
import { parse } from "../lib/validation.js";
import { authenticatePreHandler } from "../plugins/auth.js";
import {
  createStatus,
  deleteStatus,
  listStatusMutes,
  listStatusViewers,
  listStatuses,
  markStatusViewed,
  muteStatusAuthor,
  replyToStatus,
  unmuteStatusAuthor,
  type StatusDeps,
} from "../services/statuses.js";
import { mediaDownloadUrl } from "./media.js";

/**
 * Status API (Phase 4B): ephemeral 24h posts (text/photo/video/URL) with
 * audience privacy. Media itself goes through /media/upload first.
 * Phase 5D adds replies to a status, the author's read-receipt toggle (set when
 * the status is posted) and per-author muting.
 */
export async function statusRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.addHook("preHandler", authenticatePreHandler(deps.db));
  const svc: StatusDeps = {
    db: deps.db,
    hub: deps.hub,
    media: deps.media,
    mediaUrl: (key) => mediaDownloadUrl(app, deps, key),
  };

  app.post(
    "/statuses",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request) => {
      const body = parse(createStatusRequestSchemaChecked, request.body);
      return createStatus(svc, requireUserId(request), body);
    },
  );

  app.get("/statuses", async (request) => listStatuses(svc, requireUserId(request)));

  app.get("/statuses/:id/viewers", async (request) => {
    const { id } = request.params as { id: string };
    return { viewers: await listStatusViewers(svc, requireUserId(request), id) };
  });

  app.post("/statuses/:id/viewed", async (request) => {
    const { id } = request.params as { id: string };
    return markStatusViewed(svc, requireUserId(request), id);
  });

  app.delete("/statuses/:id", async (request) => {
    const { id } = request.params as { id: string };
    return deleteStatus(svc, requireUserId(request), id);
  });

  app.post(
    "/statuses/:id/reply",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = parse(replyToStatusRequestSchema, request.body);
      return replyToStatus(svc, requireUserId(request), id, body);
    },
  );

  // ── muting an author (Phase 5D) ──

  app.get("/statuses/muted", async (request) => ({
    items: await listStatusMutes(svc, requireUserId(request)),
  }));

  app.put("/statuses/mute/:authorId", async (request) => {
    const { authorId } = request.params as { authorId: string };
    return muteStatusAuthor(svc, requireUserId(request), authorId);
  });

  app.delete("/statuses/mute/:authorId", async (request) => {
    const { authorId } = request.params as { authorId: string };
    return unmuteStatusAuthor(svc, requireUserId(request), authorId);
  });
}

function requireUserId(request: FastifyRequest): string {
  if (!request.currentUser) throw unauthorized();
  return request.currentUser.id;
}
