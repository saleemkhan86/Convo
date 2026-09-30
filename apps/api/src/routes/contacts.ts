import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  blockRequestSchema,
  contactRefSchema,
  cursorQuerySchema,
  globalSearchQuerySchema,
  reportRequestSchema,
  upsertContactRequestSchema,
} from "@convo/shared";
import type { AppDeps } from "../deps.js";
import { unauthorized } from "../lib/errors.js";
import { parse } from "../lib/validation.js";
import { authenticatePreHandler } from "../plugins/auth.js";
import { mediaDownloadUrl } from "./media.js";
import { listStarred, type ConversationDeps } from "../services/conversations.js";
import {
  blockUser,
  deleteContact,
  getUserCard,
  globalSearch,
  listBlocked,
  listContacts,
  listRecentRecipients,
  reportTarget,
  unblockUser,
  upsertContact,
  type ContactDeps,
} from "../services/contacts.js";

/**
 * Contacts, blocking, reporting and search (Phase 5A, spec §9, §10, §28).
 *
 * Address-book rows are private to their owner; blocked lists and reports are
 * per-account moderation state. Nothing here is broadcast over the socket —
 * clients re-pull after these calls.
 */
export async function contactRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.addHook("preHandler", authenticatePreHandler(deps.db));
  const mediaUrl = (key: string) => mediaDownloadUrl(app, deps, key);
  const svc: ContactDeps = { db: deps.db, mediaUrl };
  const chatSvc: ConversationDeps = { db: deps.db, hub: deps.hub, mediaUrl };

  // ── address book ──

  app.get("/contacts", async (request) => listContacts(svc, requireUserId(request)));

  /** Recent chat partners — powers "message new chat" autocomplete. */
  app.get("/contacts/recent", async (request) =>
    listRecentRecipients(svc, requireUserId(request), 20),
  );

  app.post("/contacts", async (request) => {
    const body = parse(upsertContactRequestSchema, request.body);
    return upsertContact(svc, requireUserId(request), body);
  });

  app.delete("/contacts/:id", async (request) => {
    const { id } = parse(contactRefSchema, request.params as { id: string });
    await deleteContact(svc, requireUserId(request), id);
    return { ok: true };
  });

  /** The contact-info sheet for any account the viewer can see. */
  app.get("/users/:id", async (request) => {
    const { id } = request.params as { id: string };
    return getUserCard(svc, requireUserId(request), id);
  });

  // ── blocking ──

  app.get("/blocks", async (request) => listBlocked(svc, requireUserId(request)));

  app.post(
    "/blocks",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request) => {
      const body = parse(blockRequestSchema, request.body);
      return blockUser(svc, requireUserId(request), body);
    },
  );

  app.delete("/blocks/:userId", async (request) => {
    const { userId } = request.params as { userId: string };
    await unblockUser(svc, requireUserId(request), userId);
    return { ok: true };
  });

  // ── moderation ──

  app.post(
    "/reports",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request) => {
      const body = parse(reportRequestSchema, request.body);
      return reportTarget(svc, requireUserId(request), body);
    },
  );

  // ── search ──

  app.get("/search", async (request) => {
    const { q, limit } = parse(globalSearchQuerySchema, request.query);
    return globalSearch(svc, requireUserId(request), q, limit);
  });

  /** Starred messages across every chat. */
  app.get("/starred", async (request) => {
    const { cursor, limit } = parse(cursorQuerySchema, request.query);
    return listStarred(chatSvc, requireUserId(request), { cursor, limit });
  });
}

function requireUserId(request: FastifyRequest): string {
  if (!request.currentUser) throw unauthorized();
  return request.currentUser.id;
}
