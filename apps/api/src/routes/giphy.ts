import type { FastifyInstance } from "fastify";
import { giphySearchQuerySchema, giphyUploadRequestSchema } from "@convo/shared";
import type { AppDeps } from "../deps.js";
import { unauthorized } from "../lib/errors.js";
import { parse } from "../lib/validation.js";
import { authenticatePreHandler } from "../plugins/auth.js";
import { fetchGifBytes, searchGifs } from "../services/giphy.js";
import { kindForMime } from "../media/index.js";
import { issueUrl, rememberUpload } from "./media.js";

/**
 * GIF picker proxy (Phase 5B extras). Both routes are authenticated and talk
 * to Giphy server-side; the API key never leaves the environment. Uploads
 * mirror /media/upload's ownership flow so a picked GIF is an ordinary
 * caller-owned attachment from then on.
 */
export async function giphyRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const auth = authenticatePreHandler(deps.db);

  app.get("/giphy/search", { preHandler: auth }, async (request) => {
    const query = parse(giphySearchQuerySchema, request.query);
    return searchGifs(deps.config.GIPHY_API_KEY, query);
  });

  app.post("/giphy/upload", { preHandler: auth }, async (request, reply) => {
    if (!request.currentUser) throw unauthorized();
    const userId = request.currentUser.id;
    const body = parse(giphyUploadRequestSchema, request.body);
    const { buffer, mimeType } = await fetchGifBytes(body.giphyId);
    const { key } = await deps.media.save(buffer, mimeType);
    await rememberUpload(deps, userId, key, mimeType, buffer.byteLength);
    return {
      storageKey: key,
      kind: kindForMime(mimeType),
      mimeType,
      sizeBytes: buffer.byteLength,
      fileName: `giphy-${body.giphyId}.gif`,
      downloadUrl: issueUrl(app, deps, reply, key),
    };
  });
}
