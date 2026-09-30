import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isAllowedMime, kindForMime, type MediaStorage, type StoredMedia } from "./provider.js";

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/ogg": "ogg",
  "audio/webm": "weba",
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/zip": "zip",
  "text/plain": "txt",
  "text/csv": "csv",
};

/**
 * Dev/default storage: files under `.data/media` (git-ignored). Swap for
 * Supabase Storage (or S3) via MEDIA_STORAGE_PROVIDER without touching callers.
 */
export class LocalFileStorage implements MediaStorage {
  private readonly root = path.resolve(process.env.MEDIA_LOCAL_DIR ?? ".data/media");

  async save(buffer: Buffer, mimeType: string): Promise<{ key: string }> {
    if (!isAllowedMime(mimeType)) throw new Error(`Unsupported media type: ${mimeType}`);
    const key = `${randomUUID()}.${EXTENSIONS[mimeType] ?? "bin"}`;
    await mkdir(this.dirFor(key), { recursive: true });
    await writeFile(this.pathFor(key), buffer);
    return { key };
  }

  async fetch(key: string): Promise<{ body: Buffer; mimeType: string } | null> {
    if (!this.isSafeKey(key)) return null;
    try {
      const body = await readFile(this.pathFor(key));
      return { body, mimeType: mimeFromKey(key) };
    } catch {
      return null;
    }
  }

  private dirFor(key: string): string {
    // Shard by the first two chars to keep directories small.
    return path.join(this.root, key.slice(0, 2));
  }

  private pathFor(key: string): string {
    return path.join(this.dirFor(key), key);
  }

  private isSafeKey(key: string): boolean {
    return /^[a-f0-9-]+\.[a-z0-9]+$/i.test(key);
  }
}

function mimeFromKey(key: string): string {
  const ext = key.split(".").pop()?.toLowerCase();
  const entry = Object.entries(EXTENSIONS).find(([, e]) => e === ext);
  return entry?.[0] ?? "application/octet-stream";
}

export type { StoredMedia };
export { kindForMime };
