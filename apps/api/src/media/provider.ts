import { randomUUID } from "node:crypto";

/** Matches the Prisma AttachmentKind enum values. */
export type MediaKind = "IMAGE" | "VIDEO" | "DOCUMENT" | "VOICE" | "OTHER";

export interface StoredMedia {
  kind: MediaKind;
  mimeType: string;
  sizeBytes: number;
}

/**
 * Pluggable object storage for user media (status photos/videos today,
 * chat/mail attachments later). Keys are opaque; the API serves content back
 * through expiring signed URLs (see routes/media.ts).
 */
export interface MediaStorage {
  /** Persist bytes and return the storage key. */
  save(buffer: Buffer, mimeType: string): Promise<{ key: string }>;
  /** Read a stored object back. Null when the key does not exist. */
  fetch(key: string): Promise<{ body: Buffer; mimeType: string } | null>;
}

export function kindForMime(mimeType: string): MediaKind {
  if (mimeType.startsWith("image/")) return "IMAGE";
  if (mimeType.startsWith("video/")) return "VIDEO";
  if (mimeType.startsWith("audio/")) return "VOICE";
  if (
    mimeType === "application/pdf" ||
    mimeType.startsWith("text/") ||
    mimeType.startsWith("application/vnd.") ||
    mimeType.startsWith("application/msword")
  ) {
    return "DOCUMENT";
  }
  return "OTHER";
}

/** MIME types accepted for uploads (spec §24 media validation). */
const ALLOWED_EXACT = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "audio/mpeg",
  "audio/mp4",
  "audio/ogg",
  "audio/webm",
  "application/pdf",
  // Chat documents (Phase 5B): the formats people actually send each other.
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/zip",
  "text/plain",
  "text/csv",
]);

const ALLOWED_PREFIXES = ["image/", "video/", "audio/"];

export function isAllowedMime(mimeType: string): boolean {
  if (ALLOWED_EXACT.has(mimeType)) return true;
  return ALLOWED_PREFIXES.some((p) => mimeType.startsWith(p));
}

export function newStorageKey(): string {
  return randomUUID().replace(/-/g, "") + "." + randomUUID().slice(0, 4);
}
