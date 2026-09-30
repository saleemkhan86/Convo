import { promises as dns } from "node:dns";
import net from "node:net";
import type { LinkPreview } from "@convo/shared";

/**
 * Link previews (Phase 5B extras): scrape the first http(s) link in a message
 * body into an Open Graph card. Runs *after* the send, so a slow or hostile
 * publisher can never delay or fail the message itself — every failure path
 * here just returns null.
 *
 * SSRF policy: the URL comes from user text, so we resolve the hostname
 * ourselves and refuse anything that maps to loopback, private, link-local,
 * unique-local or multicast space (IPv4 + IPv6, including embedded-v4 forms).
 * Redirects are followed manually so every hop is re-validated, the body is
 * byte-capped, and the whole fetch is deadline-bound.
 */

const MAX_REDIRECTS = 3;
const USER_AGENT = "ConvoBot/1.0 (+link preview)";

/** First http(s) URL in the text, with trailing sentence punctuation trimmed. */
export function firstUrl(text: string | null | undefined): string | null {
  if (!text) return null;
  const match = /https?:\/\/[^\s<>"']+/i.exec(text);
  if (!match) return null;
  const url = match[0].replace(/[),.;!?'"]+$/, "");
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** True when the address is in a range a user-supplied URL must never reach. */
export function isBlockedAddress(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) return isBlockedV4(ip);
  if (version !== 6) return true;

  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped?.[1]) return isBlockedV4(mapped[1]);
  const compressed = expandIPv6(ip);
  if (
    compressed === null ||
    compressed === "00000000000000000000000000000000" || // ::
    compressed === "00000000000000000000000000000001" // ::1
  ) {
    return true;
  }
  const head = parseInt(compressed.slice(0, 4), 16);
  if ((head & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if (head >= 0xff00) return true; // ff00::/8 multicast + reserved
  const firstByte = head >> 8;
  if ((firstByte & 0xfe) === 0xfc) return true; // fc00::/7 unique local
  if (compressed.startsWith("2002")) {
    // 6to4: the embedded IPv4 decides.
    const octets = [4, 6, 8, 10].map((i) => parseInt(compressed.slice(i, i + 2), 16));
    if (isBlockedV4(octets.join("."))) return true;
  }
  return false;
}

function isBlockedV4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const a = parts[0] as number;
  const b = parts[1] as number;
  if (a === 0 || a === 10 || a === 127) return true; // "this" + private + loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 169 && b === 254) return true; // link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved
  return false;
}

/** Expand `::` shorthand to 32 hex chars; null when malformed. */
function expandIPv6(ip: string): string | null {
  const stripped = ip.replace(/^\[|\]$/g, "").split("%")[0] ?? "";
  const sections = stripped.split("::");
  if (sections.length > 2) return null;
  let groups: string[];
  if (sections.length === 1) {
    groups = stripped.split(":");
  } else {
    const head = sections[0] ?? "";
    const tail = sections[1] ?? "";
    const headGroups = head === "" ? [] : head.split(":");
    const tailGroups = tail === "" ? [] : tail.split(":");
    const fill = 8 - headGroups.length - tailGroups.length;
    if (fill < 1) return null;
    groups = [...headGroups, ...Array<string>(fill).fill("0"), ...tailGroups];
  }
  if (groups.length !== 8) return null;
  let out = "";
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    out += g.padStart(4, "0");
  }
  return out.toLowerCase();
}

/** Throws when the host is an IP literal or resolves to any blocked range. */
export async function assertPublicUrl(url: string): Promise<URL> {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http(s) URLs may be unfurled");
  }
  if (parsed.username || parsed.password) throw new Error("Credentialed URLs are refused");
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) throw new Error("Host resolves to a blocked address");
    return parsed;
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    throw new Error("Host resolves to a blocked address");
  }
  let records: { address: string }[];
  try {
    records = await dns.lookup(host, { all: true });
  } catch {
    throw new Error("Host does not resolve");
  }
  if (records.length === 0) throw new Error("Host does not resolve");
  for (const record of records) {
    if (isBlockedAddress(record.address)) throw new Error("Host resolves to a blocked address");
  }
  return parsed;
}

interface FetchResult {
  finalUrl: string;
  contentType: string;
  html: string;
}

/** GET with manual, re-validated redirects, a deadline and a byte cap. */
async function fetchHtml(url: string, timeoutMs: number, maxBytes: number): Promise<FetchResult | null> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertPublicUrl(current);
    const response = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml" },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return null;
      current = new URL(location, current).toString();
      await assertPublicUrl(current);
      continue;
    }
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html")) return null;
    const html = await readCapped(response, maxBytes);
    return { finalUrl: current, contentType, html };
  }
  return null;
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return "";
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Buffer[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("latin1");
}

// ─────────────────────────────── html parsing ───────────────────────────────

const ENTITY_MAP: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  return text
    .replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, entity: string) => {
      if (entity.startsWith("#x") || entity.startsWith("#X")) {
        const code = Number.parseInt(entity.slice(2), 16);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
      }
      if (entity.startsWith("#")) {
        const code = Number.parseInt(entity.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
      }
      return ENTITY_MAP[entity.toLowerCase()] ?? whole;
    })
    .trim();
}

/** Attribute map for every `<meta …>` and the page `<title>`. */
function collectMetadata(html: string): Map<string, string> {
  const values = new Map<string, string>();
  const metaRe = /<meta\b([^>]*)>/gi;
  for (const match of html.matchAll(metaRe)) {
    const attrs = match[1];
    if (!attrs) continue;
    const map = new Map<string, string>();
    for (const attr of attrs.matchAll(/([a-zA-Z:\-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
      const name = attr[1];
      if (!name) continue;
      map.set(name.toLowerCase(), decodeEntities(attr[2] ?? attr[3] ?? attr[4] ?? ""));
    }
    const key = map.get("property") ?? map.get("name");
    const content = map.get("content");
    if (key && content && !values.has(key.toLowerCase())) {
      values.set(key.toLowerCase(), content);
    }
  }
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (title?.[1]) values.set("__title", decodeEntities(title[1]));
  return values;
}

function pick(values: Map<string, string>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = values.get(key);
    if (value) return value;
  }
  return null;
}

function absolutize(possible: string | null, base: string): string | null {
  if (!possible) return null;
  try {
    const url = new URL(possible, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Parse a scraped page into a preview card. Exported for unit tests. */
export function parseLinkMetadata(html: string, baseUrl: string): LinkPreview {
  const values = collectMetadata(html);
  const image = absolutize(
    pick(values, "og:image", "og:image:url", "twitter:image:src", "twitter:image"),
    baseUrl,
  );
  return {
    url: baseUrl,
    title: truncate(pick(values, "og:title", "twitter:title", "__title", "application-name"), 240),
    description: truncate(pick(values, "og:description", "twitter:description", "description"), 480),
    image: isBlockedCandidate(image) ? null : image,
    siteName: truncate(pick(values, "og:site_name"), 80),
  };
}

/**
 * Preview images are fetched by the client, not the server, so we cannot run
 * the DNS check on them — but we can still refuse obvious internal hosts so a
 * malicious page cannot point a viewer's browser at an intranet URL.
 */
function isBlockedCandidate(url: string | null): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^\[|\]$/g, "");
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return true;
    if (host === "localhost" || host.endsWith(".localhost")) return true;
    return net.isIP(host) ? isBlockedAddress(host) : false;
  } catch {
    return true;
  }
}

function truncate(text: string | null, max: number): string | null {
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Unfurl the first link in a message body. Returns null whenever there is no
 * URL or anything about the fetch/parse failed — callers treat previews as
 * strictly best-effort.
 */
export async function unfurlLink(
  body: string | null | undefined,
  options: { timeoutMs: number; maxBytes: number },
): Promise<LinkPreview | null> {
  const url = firstUrl(body);
  if (!url) return null;
  try {
    const page = await fetchHtml(url, options.timeoutMs, options.maxBytes);
    if (!page || !page.html.trim()) return null;
    const preview = parseLinkMetadata(page.html, page.finalUrl);
    return preview.title || preview.description || preview.image ? preview : null;
  } catch {
    return null;
  }
}
