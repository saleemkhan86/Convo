import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  createChatFolderRequestSchema,
  reorderChatFoldersRequestSchema,
  setChatFoldersRequestSchema,
  setFolderChatsRequestSchema,
  updateChatFolderRequestSchema,
} from "@convo/shared";
import type { AppDeps } from "../deps.js";
import { unauthorized } from "../lib/errors.js";
import { parse } from "../lib/validation.js";
import { authenticatePreHandler } from "../plugins/auth.js";
import {
  createFolder,
  deleteFolder,
  listFolders,
  reorderFolders,
  setChatFolders,
  setFolderChats,
  updateFolder,
} from "../services/folders.js";

/**
 * Chat folder API (Phase 5G).
 *
 * Folders are strictly per-viewer state: no socket event is ever emitted when a
 * folder changes, because the same conversation can be filed differently by two
 * members of the same group.
 */
export async function folderRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.addHook("preHandler", authenticatePreHandler(deps.db));

  // ── GET /chat-folders — list all folders for this user ────────────────
  app.get("/chat-folders", async (request) =>
    listFolders(deps.db, requireUserId(request)),
  );

  // ── POST /chat-folders — create a new folder ──────────────────────────
  app.post("/chat-folders", async (request) => {
    const body = parse(createChatFolderRequestSchema, request.body);
    return createFolder(deps.db, requireUserId(request), body);
  });

  // ── PATCH /chat-folders/:id — rename or change emoji ──────────────────
  app.patch<{ Params: { id: string } }>("/chat-folders/:id", async (request) => {
    const body = parse(updateChatFolderRequestSchema, request.body);
    return updateFolder(deps.db, requireUserId(request), request.params.id, body);
  });

  // ── DELETE /chat-folders/:id — remove the folder (items cascade) ──────
  app.delete<{ Params: { id: string } }>("/chat-folders/:id", async (request) =>
    deleteFolder(deps.db, requireUserId(request), request.params.id),
  );

  // ── PUT /chat-folders/order — reorder the whole strip ─────────────────
  app.put("/chat-folders/order", async (request) => {
    const body = parse(reorderChatFoldersRequestSchema, request.body);
    return reorderFolders(deps.db, requireUserId(request), body);
  });

  // ── PUT /chat-folders/:id/chats — replace folder membership ───────────
  app.put<{ Params: { id: string } }>("/chat-folders/:id/chats", async (request) => {
    const body = parse(setFolderChatsRequestSchema, request.body);
    return setFolderChats(deps.db, requireUserId(request), request.params.id, body);
  });

  // ── PUT /conversations/:id/folders — which folders contain this chat ──
  app.put<{ Params: { conversationId: string } }>("/conversations/:conversationId/folders", async (request) => {
    const body = parse(setChatFoldersRequestSchema, request.body);
    return setChatFolders(
      deps.db,
      requireUserId(request),
      request.params.conversationId,
      body,
    );
  });
}

function requireUserId(request: FastifyRequest): string {
  if (!request.currentUser) throw unauthorized();
  return request.currentUser.id;
}
