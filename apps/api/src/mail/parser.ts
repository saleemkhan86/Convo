import { isBounceSender, isBounceSubject } from "./providers/address.js";

/**
 * Turns provider mail (HTML and/or text) into the clean, chat-like text Convo
 * stores. Raw HTML is never persisted or rendered. This is deliberately
 * dependency-free: the regex pass covers the common mail clients, and the
 * contract stays stable if we later swap in a DOM-based converter.
 */

export interface NormalizeEmailInput {
  from?: string;
  subject?: string;
  bodyHtml?: string;
  bodyText?: string;
}

export interface NormalizeEmailOptions {
  maxChars?: number;
  maxLinks?: number;
}

export interface NormalizedEmailBody {
  text: string;
  preview: string;
  /** Tail that looked like a quoted reply, when the text body had one. */
  quotedText?: string;
  links: string[];
  isBounce: boolean;
  usedHtml: boolean;
}

const MAX_INPUT_CHARS = 512_000;
const DEFAULT_MAX_CHARS = 20_000;
const DEFAULT_MAX_LINKS = 20;
const PREVIEW_CHARS = 200;

const REMOVED_BLOCKS =
  /<(script|style|head|title|iframe|object|embed|form|svg|canvas|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

export function normalizeEmailBody(
  input: NormalizeEmailInput,
  options: NormalizeEmailOptions = {},
): NormalizedEmailBody {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const maxLinks = options.maxLinks ?? DEFAULT_MAX_LINKS;

  const rawPlain = cap(input.bodyText ?? "", MAX_INPUT_CHARS).replace(/\r\n?/g, "\n");
  const plainParts = splitQuotedReply(rawPlain);
  const plain = cleanupPlainText(plainParts.body);
  const html = input.bodyHtml
    ? cleanupPlainText(cap(htmlToText(cap(input.bodyHtml, MAX_INPUT_CHARS)), MAX_INPUT_CHARS))
    : "";

  const usedHtml = !isMeaningful(plain) && isMeaningful(html);
  const body = usedHtml || (!plain && html) ? html : plain;
  const text = cap(body, maxChars);

  return {
    text,
    preview: makePreview(text),
    quotedText: plainParts.quoted
      ? cap(cleanupPlainText(plainParts.quoted), maxChars)
      : undefined,
    links: extractLinks(text, maxLinks),
    isBounce: isBounce(input.from, input.subject, text),
    usedHtml,
  };
}

export function isBounce(
  from: string | undefined,
  subject: string | undefined,
  body: string,
): boolean {
  if (from && isBounceSender(from)) return true;
  if (isBounceSubject(subject)) return true;
  return /delivery status notification|undeliverable|mail delivery failed/i.test(body.slice(0, 2000));
}

export function extractLinks(text: string, max = DEFAULT_MAX_LINKS): string[] {
  const seen = new Set<string>();
  const links: string[] = [];
  const matches = text.match(/https?:\/\/[^\s<>"']+/gi) ?? [];
  for (const match of matches) {
    const url = match.replace(/[.,;:!?)\]}]+$/g, "");
    if (!url || seen.has(url)) continue;
    seen.add(url);
    links.push(url);
    if (links.length >= max) break;
  }
  return links;
}

function isMeaningful(value: string): boolean {
  return value.replace(/\s+/g, " ").trim().length >= 20;
}

function cap(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function makePreview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS - 1)}…` : flat;
}

/** HTML → readable text, stripping quoted replies, signatures, and images. */
export function htmlToText(html: string): string {
  let value = html.replace(/<!--[\s\S]*?-->/g, "");
  value = value.replace(REMOVED_BLOCKS, "");

  // Tracking pixels and decorative images carry no meaning in chat.
  value = value.replace(/<img\b[^>]*>/gi, "");
  value = value.replace(/<source\b[^>]*>/gi, "");

  // Quoted history: Gmail/Yahoo/Outlook containers, plus plain blockquotes.
  value = value
    .replace(/<blockquote\b[^>]*>[\s\S]*?<\/blockquote\s*>/gi, "")
    .replace(
      /<div\b[^>]*(?:gmail_quote|gmail_quote_container|yahoo_quoted|moz-cite-prefix|OutlookMessageHeader|divRplyFwdMsg)[^>]*>[\s\S]*$/gi,
      "",
    );

  // Signature blocks are usually the last element in the body.
  value = value.replace(
    /<div\b[^>]*(?:gmail_signature|signature|moz-signature)[^>]*>[\s\S]*$/gi,
    "",
  );

  // Keep anchors readable: "label (url)" unless they are identical.
  value = value.replace(
    /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi,
    (match, href: string, labelHtml: string) => {
      const label = labelHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      if (!/^https?:\/\//i.test(href)) return label || match;
      if (!label || label === href) return href;
      return `${label} (${href})`;
    },
  );

  value = value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<hr\b[^>]*>/gi, "\n---\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(?:p|div|li|tr|h[1-6]|table|ul|ol|section|article)\s*>/gi, "\n")
    .replace(/<\/td\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ");

  return decodeEntities(value);
}

/** Removes quote chains, signatures, and mail-client footer noise. */
export function cleanupPlainText(value: string): string {
  let text = value.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ");

  text = text
    .replace(/^\s*[-–—]{2,}\s*Original Message\s*[-–—]{2,}[\s\S]*$/im, "")
    .replace(/^\s*On\b[\s\S]{0,300}?\bwrote:\s*$[\s\S]*$/im, "")
    .replace(/^\s*_{10,}\s*$[\s\S]*$/m, "")
    .replace(/^\s*From:\s[^\n]*\n(?:Sent|Date|To|Subject):[^\n]*(?:\n(?:Sent|Date|To|Subject):[^\n]*)*[\s\S]*$/im, "");

  // A run of quoted lines at the end is history, not content.
  const lines = text.split("\n");
  const firstQuote = lines.findIndex(
    (line, index) =>
      /^\s*>/.test(line) &&
      lines.slice(index).filter((candidate) => !candidate.trim() || /^\s*>/.test(candidate)).length >=
        2,
  );
  if (firstQuote > 0) text = lines.slice(0, firstQuote).join("\n");

  text = text
    .replace(/^-- ?$[\s\S]*$/m, "")
    .replace(
      /^\s*(?:Sent from my (?:iPhone|iPad|iPod|Android|Galaxy|BlackBerry)|Get Outlook for (?:iOS|Android))[\s\S]*$/im,
      "",
    )
    .replace(/^\s*BEGIN:VCARD[\s\S]*$/im, "");

  return normalizeWhitespace(text);
}

function normalizeWhitespace(value: string): string {
  return value
    .normalize("NFC")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitQuotedReply(value: string): { body: string; quoted?: string } {
  const patterns: RegExp[] = [
    /^\s*On\b[\s\S]{0,300}?\bwrote:\s*$/im,
    /^\s*[-–—]{2,}\s*Original Message\s*[-–—]{2,}\s*$/im,
    /^\s*From:\s[^\n]*\n(?:Sent|Date|To|Subject):/im,
    /^\s*_{10,}\s*$/m,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(value);
    if (match && match.index > 0) {
      return {
        body: value.slice(0, match.index).trim(),
        quoted:
          value.slice(match.index + match[0].length).trim() || undefined,
      };
    }
  }
  return { body: value };
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  copy: "©",
  reg: "®",
  trade: "™",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  bull: "•",
  middot: "·",
  euro: "€",
  pound: "£",
  yen: "¥",
};

export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const hex = entity[1]?.toLowerCase() === "x";
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}
