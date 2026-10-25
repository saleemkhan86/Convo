import type { PrismaClient } from "@prisma/client";
import type { MediaStorage } from "../media/index.js";

/**
 * Sweep expired feed posts. Deletes the media objects from storage, then the
 * database rows (cascade handles MediaObject cleanup via FK).
 */
export async function sweepExpiredFeedPosts(
  db: PrismaClient,
  media: MediaStorage,
): Promise<number> {
  const now = new Date();

  // Find expired posts
  const expired = await db.feedPost.findMany({
    where: { expiresAt: { lt: now } },
    select: { id: true, mediaKey: true },
  });

  if (expired.length === 0) return 0;

  // Delete media from storage (best-effort; ignore errors)
  for (const post of expired) {
    try {
      await media.delete(post.mediaKey);
    } catch {
      // Media may already be gone; continue
    }
  }

  // Delete the feed posts (cascade deletes MediaObject rows)
  const result = await db.feedPost.deleteMany({
    where: { id: { in: expired.map((p) => p.id) } },
  });

  return result.count;
}
