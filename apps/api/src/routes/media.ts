import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../deps.js";
import { badRequest, forbidden, notFound, unauthorized } from "../lib/errors.js";
import { isAllowedMime, kindForMime } from "../media/index.js";
import { parse } from "../lib/validation.js";
import { authenticatePreHandler } from "../plugins/auth.js";

/**
 * Media upload/download (Phase 4B). Uploads are authenticated and size-capped;
 * downloads use short-lived JWT tokens bound to one storage key, so clients
 * get expiring URLs without the provider credentials ever being exposed.
 */

const uploadBodySchema = z.object({
  data: z.string().min(1),
  mimeType: z.string().min(3).max(128),
  fileName: z.string().max(255).optional(),
});

const tokenPayloadSchema = z.object({ sub: z.string().optional(), media: z.string() });

export async function mediaRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  await app.register(import("@fastify/multipart"), {
    limits: { fileSize: deps.config.MEDIA_MAX_UPLOAD_BYTES, files: 1 },
  });

  const auth = authenticatePreHandler(deps.db);

  app.post("/media/upload", { preHandler: auth }, async (request, reply) => {
    const userId = requireUserId(request);
    // JSON + base64 body: works identically from browsers and React Native
    // (camera-roll assets), which cannot stream multipart bodies.
    if (request.isMultipart?.()) return uploadFromMultipart(deps, request, reply, userId);

    const body = parse(uploadBodySchema, request.body);
    if (!isAllowedMime(body.mimeType)) {
      throw badRequest(`Unsupported media type: ${body.mimeType}`);
    }
    const buffer = decodeBase64(body.data);
    enforceSize(deps, buffer.byteLength);
    const { key } = await deps.media.save(buffer, body.mimeType);
    await rememberUpload(deps, userId, key, body.mimeType, buffer.byteLength);
    return {
      storageKey: key,
      kind: kindForMime(body.mimeType),
      mimeType: body.mimeType,
      sizeBytes: buffer.byteLength,
      fileName: body.fileName ?? null,
      downloadUrl: issueUrl(app, deps, reply, key),
    };
  });

  // Expiring media fetch. Token is a JWT { media: key }; no auth header needed
  // so plain <img>/<video> tags can load media directly.
  app.get("/media/:key", async (request, reply) => {
    const { key } = request.params as { key: string };
    const { token } = parse(
      z.object({ token: z.string().min(10) }),
      request.query,
    );
    let payload: z.infer<typeof tokenPayloadSchema>;
    try {
      payload = app.jwt.verify(token);
    } catch {
      throw unauthorized("Media link expired");
    }
    if (payload.media !== key) throw forbidden("Media link does not match this file");

    const stored = await deps.media.fetch(key);
    if (!stored) throw notFound("Media not found");
    reply
      .header("content-type", stored.mimeType)
      .header("cache-control", "private, max-age=300")
      .send(stored.body);
  });
}

async function uploadFromMultipart(
  deps: AppDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string,
) {
  const file = await request.file();
  if (!file) throw badRequest("No file part in the request");
  const mimeType = file.mimetype;
  if (!isAllowedMime(mimeType)) throw badRequest(`Unsupported media type: ${mimeType}`);
  const buffer = await file.toBuffer();
  if (file.file.truncated) throw badRequest("File too large");
  enforceSize(deps, buffer.byteLength);
  const { key } = await deps.media.save(buffer, mimeType);
  await rememberUpload(deps, userId, key, mimeType, buffer.byteLength);
  return {
    storageKey: key,
    kind: kindForMime(mimeType),
    mimeType,
    sizeBytes: buffer.byteLength,
    fileName: file.filename || null,
    downloadUrl: issueUrl(request.server as FastifyInstance, deps, reply, key),
  };
}

/**
 * Bind stored bytes to the account that uploaded them. Attaching a media key to
 * a message is only allowed for the owner of this row, so a key that leaked from
 * someone else's chat cannot be reposted into a chat its owner is not in.
 */
export async function rememberUpload(
  deps: AppDeps,
  ownerId: string,
  storageKey: string,
  mimeType: string,
  sizeBytes: number,
): Promise<void> {
  await deps.db.mediaObject.upsert({
    where: { storageKey },
    create: {
      ownerId,
      storageKey,
      mimeType,
      kind: kindForMime(mimeType),
      sizeBytes: BigInt(sizeBytes),
    },
    update: {},
  });
}

function requireUserId(request: FastifyRequest): string {
  if (!request.currentUser) throw unauthorized();
  return request.currentUser.id;
}

function enforceSize(deps: AppDeps, bytes: number): void {
  if (bytes > deps.config.MEDIA_MAX_UPLOAD_BYTES) {
    throw badRequest("File too large");
  }
  if (bytes === 0) throw badRequest("File is empty");
}

function decodeBase64(data: string): Buffer {
  const raw = data.includes(",") ? data.slice(data.indexOf(",") + 1) : data;
  const buffer = Buffer.from(raw, "base64");
  if (buffer.byteLength === 0) throw badRequest("Invalid base64 payload");
  return buffer;
}

/** Build the expiring download URL the client should use for this key. */
export function issueUrl(app: FastifyInstance, deps: AppDeps, reply: FastifyReply, key: string): string {
  const token = app.jwt.sign(
    { media: key },
    { expiresIn: deps.config.MEDIA_URL_TTL_SECONDS },
  );
  const base = resolveBaseUrl(deps, reply);
  return `${base}/media/${key}?token=${token}`;
}

export function mediaDownloadUrl(app: FastifyInstance, deps: AppDeps, key: string): string {
  const token = app.jwt.sign(
    { media: key },
    { expiresIn: deps.config.MEDIA_URL_TTL_SECONDS },
  );
  return `${deps.config.APP_URL}/media/${key}?token=${token}`;
}

function resolveBaseUrl(deps: AppDeps, reply: FastifyReply): string {
  // Behind the Vite proxy the client reaches us at its own origin; absolute
  // API_URL would break same-origin image loading in dev.
  if (!deps.config.isDev) return deps.config.APP_URL;
  const host = reply.request.headers.host ?? "localhost:4000";
  const proto = reply.request.headers["x-forwarded-proto"] ?? "http";
  return `${proto as string}://${host}`;
}
