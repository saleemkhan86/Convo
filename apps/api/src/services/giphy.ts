import type { GiphyItem, GiphyListResult } from "@convo/shared";
import { badRequest } from "../lib/errors.js";

/**
 * Giphy proxy (Phase 5B extras). The API key lives in the server environment
 * only — clients call our `/giphy/*` routes and never see it. Picking a GIF
 * downloads it into Convo's own media storage, so a GIF in a chat is just a
 * normal owned attachment (same keys, same expiring URLs, same GC rules).
 */

const GIPHY_MAX_BYTES = 15 * 1024 * 1024;
const GIPHY_TIMEOUT_MS = 15_000;
const GIPHY_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

interface RawGiphyImage {
  url?: string;
  width?: number;
  height?: number;
}

interface RawGiphyGif {
  id: string;
  title?: string;
  images?: Record<string, RawGiphyImage | undefined>;
}

function toItem(gif: RawGiphyGif): GiphyItem | null {
  const full = gif.images?.fixed_width ?? gif.images?.downsized_large ?? gif.images?.original;
  const preview = gif.images?.fixed_width_small ?? gif.images?.preview_gif ?? full;
  if (!full?.url || !preview?.url) return null;
  return {
    id: gif.id,
    title: gif.title?.trim() ? gif.title.trim().slice(0, 120) : null,
    previewUrl: preview.url,
    width: Math.trunc(full.width ?? preview.width ?? 0),
    height: Math.trunc(full.height ?? preview.height ?? 0),
  };
}

/**
 * Search (or, with no query, trending). When GIPHY_API_KEY is unset the
 * picker is simply disabled — no error, no client-side key.
 */
export async function searchGifs(
  apiKey: string | undefined,
  query: { q?: string; limit: number },
): Promise<GiphyListResult> {
  if (!apiKey) return { enabled: false, items: [] };
  const params = new URLSearchParams({
    api_key: apiKey,
    limit: String(query.limit),
    rating: "pg-13",
  });
  const path = query.q
    ? `https://api.giphy.com/v1/gifs/search?${params}&q=${encodeURIComponent(query.q)}`
    : `https://api.giphy.com/v1/gifs/trending?${params}`;
  const response = await fetch(path, { signal: AbortSignal.timeout(GIPHY_TIMEOUT_MS) });
  if (!response.ok) throw badRequest("Giphy search failed, try again");
  const payload = (await response.json()) as { data?: RawGiphyGif[] };
  const items = (payload.data ?? [])
    .map(toItem)
    .filter((item): item is GiphyItem => item !== null);
  return { enabled: true, items };
}

/** Download one GIF by id into a buffer ready for `media.save`. */
export async function fetchGifBytes(
  giphyId: string,
): Promise<{ buffer: Buffer; mimeType: string }> {
  if (!GIPHY_ID_RE.test(giphyId)) throw badRequest("Invalid GIF id");
  const url = `https://media.giphy.com/media/${giphyId}/giphy.gif`;
  const response = await fetch(url, { signal: AbortSignal.timeout(GIPHY_TIMEOUT_MS) });
  if (!response.ok) throw badRequest("GIF download failed, try again");
  const mimeType = (response.headers.get("content-type") ?? "").split(";")[0];
  if (mimeType && mimeType !== "image/gif") throw badRequest("URL did not return a GIF");
  const declared = Number(response.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > GIPHY_MAX_BYTES) throw badRequest("GIF too large");
  const chunk = new Uint8Array(await response.arrayBuffer());
  if (chunk.byteLength === 0) throw badRequest("GIF download failed, try again");
  if (chunk.byteLength > GIPHY_MAX_BYTES) throw badRequest("GIF too large");
  return { buffer: Buffer.from(chunk), mimeType: "image/gif" };
}
