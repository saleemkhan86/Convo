import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../deps.js";
import { badRequest, forbidden, notFound, unauthorized } from "../lib/errors.js";
import { parse } from "../lib/validation.js";
import { authenticatePreHandler } from "../plugins/auth.js";
import { isAllowedMime, kindForMime } from "../media/index.js";
import { mediaDownloadUrl, rememberUpload } from "./media.js";

/**
 * Contact feed (7-day auto-deleting posts). Simpler than Status: no audience
 * privacy, no view tracking. Users post media from contacts, and posts expire
 * after 7 days. The background sweep in server.ts prunes expired posts and
 * their media objects.
 */

const FEED_TTL_DAYS = 7;

const createFeedPostSchema = z.object({
  data: z.string().min(1),
  mimeType: z.string().min(3).max(128),
  fileName: z.string().max(255).optional(),
  caption: z.string().max(500).optional(),
});

const feedPostResponseSchema = z.object({
  id: z.string(),
  authorId: z.string(),
  authorName: z.string(),
  mediaUrl: z.string(),
  caption: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
});

const feedListResponseSchema = z.object({
  posts: z.array(feedPostResponseSchema),
});

export async function feedRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const auth = authenticatePreHandler(deps.db);

  app.post("/feed", { preHandler: auth }, async (request) => {
    const userId = requireUserId(request);
    const body = parse(createFeedPostSchema, request.body);

    if (!isAllowedMime(body.mimeType)) {
      throw badRequest(`Unsupported media type: ${body.mimeType}`);
    }

    const buffer = decodeBase64(body.data);
    if (buffer.byteLength === 0) throw badRequest("File is empty");
    if (buffer.byteLength > deps.config.MEDIA_MAX_UPLOAD_BYTES) {
      throw badRequest("File too large");
    }

    const { key } = await deps.media.save(buffer, body.mimeType);
    await rememberUpload(deps, userId, key, body.mimeType, buffer.byteLength);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + FEED_TTL_DAYS * 24 * 60 * 60 * 1000);

    const post = await deps.db.feedPost.create({
      data: {
        authorId: userId,
        mediaKey: key,
        caption: body.caption ?? null,
        createdAt: now,
        expiresAt,
      },
      include: {
        author: { select: { displayName: true } },
      },
    });

    return {
      id: post.id,
      authorId: post.authorId,
      authorName: post.author.displayName,
      mediaUrl: mediaDownloadUrl(app, deps, key),
      caption: post.caption,
      createdAt: post.createdAt.toISOString(),
      expiresAt: post.expiresAt.toISOString(),
    };
  });

  app.get("/feed", { preHandler: auth }, async (request) => {
    const userId = requireUserId(request);

    // Get the user's contact IDs (only resolved Convo accounts)
    const contacts = await deps.db.contact.findMany({
      where: { ownerId: userId, convoUserId: { not: null } },
      select: { convoUserId: true },
    });
    const contactIds = contacts.map((c) => c.convoUserId!).filter(Boolean);

    if (contactIds.length === 0) {
      return { posts: [] };
    }

    const now = new Date();
    const posts = await deps.db.feedPost.findMany({
      where: {
        authorId: { in: contactIds },
        expiresAt: { gt: now },
      },
      orderBy: { createdAt: "desc" },
      include: {
        author: { select: { displayName: true } },
      },
    });

    return {
      posts: posts.map((post) => ({
        id: post.id,
        authorId: post.authorId,
        authorName: post.author.displayName,
        mediaUrl: mediaDownloadUrl(app, deps, post.mediaKey),
        caption: post.caption,
        createdAt: post.createdAt.toISOString(),
        expiresAt: post.expiresAt.toISOString(),
      })),
    };
  });
}

function requireUserId(request: { currentUser?: { id: string } }): string {
  if (!request.currentUser) throw unauthorized();
  return request.currentUser.id;
}

function decodeBase64(data: string): Buffer {
  const raw = data.includes(",") ? data.slice(data.indexOf(",") + 1) : data;
  return Buffer.from(raw, "base64");
}
