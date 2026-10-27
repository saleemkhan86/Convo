/**
 * RFC 5322 helpers shared by provider adapters. No dependencies: header
 * parsing here only needs to be good enough for real-world mail, and every
 * value that leaves this module is CRLF-safe before it enters a MIME header.
 */

const ADDRESS_RE = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;

export function normalizeEmailAddress(value: string): string {
  return value.trim().toLowerCase();
}

/** Split a comma-separated address header, ignoring commas in quotes or <>. */
export function splitAddressList(raw: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  let angleDepth = 0;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (ch === "\\" && inQuotes && i + 1 < raw.length) {
      current += ch + raw[i + 1]!;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
      continue;
    }
    if (!inQuotes) {
      if (ch === "<") angleDepth += 1;
      else if (ch === ">") angleDepth = Math.max(0, angleDepth - 1);
      else if (ch === "," && angleDepth === 0) {
        parts.push(current);
        current = "";
        continue;
      }
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

export function parseAddress(raw: string): { address: string; name?: string } | null {
  const value = decodeRfc2047(raw).trim();
  if (!value) return null;

  const angle = /^(.*)<([^<>]+)>\s*$/.exec(value);
  if (angle) {
    const address = normalizeEmailAddress(angle[2]!);
    if (!ADDRESS_RE.test(address)) return null;
    const rawName = angle[1]!.trim().replace(/^"|"$/g, "").replace(/\\(.)/g, "$1");
    const name = rawName.trim();
    return name ? { address, name } : { address };
  }

  const address = normalizeEmailAddress(value);
  if (!ADDRESS_RE.test(address)) return null;
  return { address };
}

export function parseAddressList(raw: string | undefined | null): {
  address: string;
  name?: string;
}[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const result: { address: string; name?: string }[] = [];
  for (const part of splitAddressList(raw)) {
    const parsed = parseAddress(part);
    if (!parsed || seen.has(parsed.address)) continue;
    seen.add(parsed.address);
    result.push(parsed);
  }
  return result;
}

/** Decode `=?UTF-8?B?...?=` / `=?UTF-8?Q?...?=` runs. */
export function decodeRfc2047(value: string): string {
  if (!value.includes("=?")) return value;
  // Whitespace between adjacent encoded words is insignificant (RFC 2047 §6.2).
  const joined = value.replace(/\?=\s+=\?/g, "?==?");
  return joined.replace(
    /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
    (_match, charset: string, encoding: string, payload: string) => {
      try {
        const buffer =
          encoding.toUpperCase() === "B"
            ? Buffer.from(payload, "base64")
            : decodeQuotedPrintableWord(payload);
        const label = charset.toLowerCase() === "utf8" ? "utf-8" : charset.toLowerCase();
        return new TextDecoder(label, { fatal: false }).decode(buffer);
      } catch {
        return _match;
      }
    },
  );
}

function decodeQuotedPrintableWord(payload: string): Buffer {
  const bytes: number[] = [];
  for (let i = 0; i < payload.length; i += 1) {
    const ch = payload[i]!;
    if (ch === "_") {
      bytes.push(0x20);
      continue;
    }
    if (ch === "=" && i + 2 < payload.length) {
      const hex = payload.slice(i + 1, i + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    bytes.push(ch.charCodeAt(0));
  }
  return Buffer.from(bytes);
}

/** Header values must never contain CR/LF (header injection). */
export function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

export function encodeHeaderValue(value: string): string {
  const clean = sanitizeHeaderValue(value);
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;
  const encoded = Buffer.from(clean, "utf8").toString("base64");
  // Keep each encoded word under the 75-character line limit.
  const words: string[] = [];
  for (let i = 0; i < encoded.length; i += 60) {
    words.push(`=?UTF-8?B?${encoded.slice(i, i + 60)}?=`);
  }
  return words.join("\r\n ");
}

export function formatAddress(input: { address: string; name?: string }): string {
  const address = sanitizeHeaderValue(input.address);
  const name = input.name?.trim();
  if (!name) return address;
  const needsQuotes = /[()<>@,;:\\".[\]]/.test(name);
  const displayName = needsQuotes
    ? `"${sanitizeHeaderValue(name).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
    : encodeHeaderValue(name);
  return `${displayName} <${address}>`;
}

export function formatAddressList(
  addresses: readonly { address: string; name?: string }[] | undefined,
): string {
  return (addresses ?? []).map(formatAddress).join(", ");
}

export function normalizeMessageId(raw: string): string | undefined {
  const value = sanitizeHeaderValue(raw);
  if (!value) return undefined;
  const match = /<[^<>]+>/.exec(value);
  return match ? match[0] : undefined;
}

export function parseMessageIdList(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const ids = raw.match(/<[^<>]+>/g) ?? [];
  return ids.map((id) => sanitizeHeaderValue(id));
}

export function isBounceSender(address: string): boolean {
  const local = normalizeEmailAddress(address).split("@")[0] ?? "";
  return (
    local.startsWith("mailer-daemon") ||
    local.startsWith("postmaster") ||
    local.startsWith("mail-daemon")
  );
}

export function isBounceSubject(subject: string | undefined): boolean {
  if (!subject) return false;
  return /undeliver|delivery status notification|returned mail|delivery has failed|failure notice/i.test(
    subject,
  );
}
