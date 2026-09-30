import type { PrismaClient } from "@prisma/client";
import type {
  ChatFolder,
  ChatFolderList,
  CreateChatFolderRequest,
  ReorderChatFoldersRequest,
  SetChatFoldersRequest,
  SetFolderChatsRequest,
  UpdateChatFolderRequest,
} from "@convo/shared";
import { badRequest, notFound } from "../lib/errors.js";

/**
 * Chat folders (Phase 5G).
 *
 * A folder is one viewer's way of organising their own list. Nothing here ever
 * touches the shared `Conversation` row, so no member can see, let alone
 * change, how another member files the same chat — which is also why no folder
 * operation emits a socket event.
 *
 * Every write path re-checks membership, because a folder is only meaningful
 * for chats the caller actually belongs to.
 */

/** Enough to keep one account's tab strip from becoming a stress test. */
const MAX_FOLDERS_PER_USER = 20;

type FolderRow = {
  id: string;
  name: string;
  emoji: string | null;
  position: number;
  createdAt: Date;
  _count: { items: number };
};

export async function listFolders(db: PrismaClient, userId: string): Promise<ChatFolderList> {
  const rows = await db.chatFolder.findMany({
    where: { userId },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    ...folderCountInclude,
  });
  return { folders: rows.map(serializeFolder) };
}

export async function createFolder(
  db: PrismaClient,
  userId: string,
  req: CreateChatFolderRequest,
): Promise<ChatFolder> {
  const existing = await db.chatFolder.count({ where: { userId } });
  if (existing >= MAX_FOLDERS_PER_USER) {
    throw badRequest(`A chat list holds at most ${MAX_FOLDERS_PER_USER} folders`);
  }
  if (req.conversationIds && req.conversationIds.length > 0) {
    await assertOwnChats(db, userId, req.conversationIds);
  }

  const created = await db.chatFolder.create({
    data: {
      userId,
      name: req.name,
      emoji: req.emoji ?? null,
      // Appended last; a reorder renumbers the whole strip.
      position: existing,
      ...(req.conversationIds && req.conversationIds.length > 0
        ? { items: { create: req.conversationIds.map((conversationId) => ({ conversationId })) } }
        : {}),
    },
    ...folderCountInclude,
  });
  return serializeFolder(created);
}

export async function updateFolder(
  db: PrismaClient,
  userId: string,
  folderId: string,
  req: UpdateChatFolderRequest,
): Promise<ChatFolder> {
  await requireFolder(db, userId, folderId);
  const row = await db.chatFolder.update({
    where: { id: folderId },
    data: {
      ...(req.name !== undefined ? { name: req.name } : {}),
      ...(req.emoji !== undefined ? { emoji: req.emoji } : {}),
    },
    ...folderCountInclude,
  });
  return serializeFolder(row);
}

export async function deleteFolder(db: PrismaClient, userId: string, folderId: string): Promise<void> {
  await requireFolder(db, userId, folderId);
  // The items go with it (ON DELETE CASCADE); the chats themselves stay.
  await db.chatFolder.delete({ where: { id: folderId } });
}

/**
 * Order is a property of the whole strip, so it is written as the whole strip:
 * the ids in the order the user wants. Anything not listed keeps its relative
 * order behind them, so a drag that only moves one tab never loses the others.
 */
export async function reorderFolders(
  db: PrismaClient,
  userId: string,
  req: ReorderChatFoldersRequest,
): Promise<ChatFolderList> {
  const mine = await db.chatFolder.findMany({ where: { userId }, select: { id: true } });
  const known = new Set(mine.map((f) => f.id));
  for (const id of req.folderIds) {
    if (!known.has(id)) throw notFound("Folder not found");
  }
  const tail = mine.map((f) => f.id).filter((id) => !req.folderIds.includes(id));
  const order = [...req.folderIds, ...tail];
  await db.$transaction(
    order.map((id, position) =>
      db.chatFolder.update({ where: { id }, data: { position }, select: { id: true } }),
    ),
  );
  return listFolders(db, userId);
}

/**
 * `PUT /chat-folders/:id/chats` — the folder's complete membership. Written as
 * a replace so a bulk select and a single drag are the same idempotent call,
 * and so a client can never leave stale rows behind by guessing at deltas.
 */
export async function setFolderChats(
  db: PrismaClient,
  userId: string,
  folderId: string,
  req: SetFolderChatsRequest,
): Promise<ChatFolder> {
  await requireFolder(db, userId, folderId);
  if (req.conversationIds.length > 0) await assertOwnChats(db, userId, req.conversationIds);

  await db.$transaction([
    db.chatFolderItem.deleteMany({ where: { folderId } }),
    ...(req.conversationIds.length > 0
      ? [
          db.chatFolderItem.createMany({
            data: req.conversationIds.map((conversationId) => ({ folderId, conversationId })),
          }),
        ]
      : []),
  ]);
  const row = await db.chatFolder.findUniqueOrThrow({ where: { id: folderId }, ...folderCountInclude });
  return serializeFolder(row);
}

/**
 * `PUT /conversations/:id/folders` — the same relation seen from the chat, which
 * is what a "Move to folder" menu has. An empty list takes the chat out of every
 * folder.
 */
export async function setChatFolders(
  db: PrismaClient,
  userId: string,
  conversationId: string,
  req: SetChatFoldersRequest,
): Promise<void> {
  const membership = await db.conversationMember.findFirst({
    where: { conversationId, userId, leftAt: null },
    select: { id: true },
  });
  if (!membership) throw notFound("Chat not found");
  if (req.folderIds.length > 0) {
    const count = await db.chatFolder.count({ where: { userId, id: { in: req.folderIds } } });
    if (count !== new Set(req.folderIds).size) throw notFound("Folder not found");
  }
  await db.$transaction([
    db.chatFolderItem.deleteMany({
      where: { conversationId, folder: { userId } },
    }),
    ...(req.folderIds.length > 0
      ? [
          db.chatFolderItem.createMany({
            data: req.folderIds.map((folderId) => ({ folderId, conversationId })),
          }),
        ]
      : []),
  ]);
}

/** Folders a chat sits in, for the chat-list row that carries them. */
export async function foldersOfChat(
  db: PrismaClient,
  userId: string,
  conversationId: string,
): Promise<ChatFolder[]> {
  const rows = await db.chatFolder.findMany({
    where: { userId, items: { some: { conversationId } } },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    ...folderCountInclude,
  });
  return rows.map(serializeFolder);
}

const folderCountInclude = {
  select: {
    id: true,
    name: true,
    emoji: true,
    position: true,
    createdAt: true,
    _count: { select: { items: true } },
  },
} as const;

function serializeFolder(row: FolderRow): ChatFolder {
  return {
    id: row.id,
    name: row.name,
    emoji: row.emoji,
    position: row.position,
    chatCount: row._count.items,
    createdAt: row.createdAt.toISOString(),
  };
}

async function requireFolder(db: PrismaClient, userId: string, folderId: string): Promise<void> {
  const found = await db.chatFolder.findFirst({ where: { id: folderId, userId }, select: { id: true } });
  if (!found) throw notFound("Folder not found");
}

/**
 * Only chats the caller is an active member of. Without this a folder could hold
 * a chat id the viewer cannot open, and the tab would offer a 404.
 */
async function assertOwnChats(db: PrismaClient, userId: string, conversationIds: string[]): Promise<void> {
  const ids = [...new Set(conversationIds)];
  const owned = await db.conversationMember.count({
    where: { userId, conversationId: { in: ids }, leftAt: null },
  });
  if (owned !== ids.length) throw notFound("Chat not found");
}
