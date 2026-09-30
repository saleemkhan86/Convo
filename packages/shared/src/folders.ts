import { z } from "zod";

/**
 * Chat folders (Phase 5G).
 *
 * A folder holds a chat *for one viewer*: the same group can sit in "Work" on
 * your phone and in nothing on mine, because membership lives on
 * `ChatFolderItem`, which is keyed by the folder's owner — never on the
 * `Conversation` row the members share.
 *
 * That is also why there is no `folder.*` socket event. For the same reason 5A
 * invented no event for pin and archive: organising my list is not news to
 * anyone else.
 */

export const chatFolderRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  emoji: z.string().nullable(),
});
export type ChatFolderRef = z.infer<typeof chatFolderRefSchema>;

export const chatFolderSchema = chatFolderRefSchema.extend({
  /** Sort order within this owner's tab strip; dense from 0. */
  position: z.number().int().nonnegative(),
  /** How many of this viewer's chats are inside, so a tab can show a count
   * without fetching the chats. */
  chatCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
});
export type ChatFolder = z.infer<typeof chatFolderSchema>;

export const chatFolderListSchema = z.object({
  folders: z.array(chatFolderSchema),
});
export type ChatFolderList = z.infer<typeof chatFolderListSchema>;

export const folderNameSchema = z
  .string()
  .trim()
  .min(1, "Folder needs a name")
  .max(48, "Folder name too long");

export const folderEmojiSchema = z
  .string()
  .trim()
  .min(1)
  .max(16, "Pick one emoji");

/** `POST /chat-folders` — optionally seeded with chats in the same call. */
export const createChatFolderRequestSchema = z.object({
  name: folderNameSchema,
  emoji: folderEmojiSchema.optional(),
  conversationIds: z.array(z.string()).max(200).optional(),
});
export type CreateChatFolderRequest = z.infer<typeof createChatFolderRequestSchema>;

export const updateChatFolderRequestSchema = z
  .object({
    name: folderNameSchema.optional(),
    /** null removes the emoji. */
    emoji: folderEmojiSchema.nullable().optional(),
  })
  .refine((v) => v.name !== undefined || v.emoji !== undefined, {
    message: "Nothing to update",
  });
export type UpdateChatFolderRequest = z.infer<typeof updateChatFolderRequestSchema>;

/** `PUT /chat-folders/order` — the whole strip, in the order the user wants it. */
export const reorderChatFoldersRequestSchema = z.object({
  folderIds: z.array(z.string()).min(1).max(25),
});
export type ReorderChatFoldersRequest = z.infer<typeof reorderChatFoldersRequestSchema>;

/**
 * `PUT /chat-folders/:id/chats` — the complete membership of one folder. The
 * client sends the set it wants, so a bulk select and a single drag both become
 * one idempotent call.
 */
export const setFolderChatsRequestSchema = z.object({
  conversationIds: z.array(z.string()).max(200),
});
export type SetFolderChatsRequest = z.infer<typeof setFolderChatsRequestSchema>;

/**
 * `PUT /conversations/:id/folders` — the complete set of folders one chat
 * belongs to. An empty array takes it out of every folder.
 */
export const setChatFoldersRequestSchema = z.object({
  folderIds: z.array(z.string()).max(25),
});
export type SetChatFoldersRequest = z.infer<typeof setChatFoldersRequestSchema>;
