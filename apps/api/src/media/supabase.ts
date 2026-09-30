import { randomUUID } from "node:crypto";
import { isAllowedMime, type MediaStorage } from "./provider.js";

interface SupabaseOptions {
  baseUrl: string;
  serviceRoleKey: string;
  bucket: string;
}

/**
 * Supabase Storage adapter (public bucket, private service-role credentials).
 * Objects live at `<bucket>/<key>`; the API is the only party that constructs
 * URLs, and clients access media exclusively through the API's expiring
 * signed-token route — the service-role key never leaves the server.
 */
export class SupabaseStorage implements MediaStorage {
  constructor(private readonly opts: SupabaseOptions) {}

  private objectPath(key: string): string {
    return `${this.opts.baseUrl.replace(/\/$/, "")}/storage/v1/object/${this.opts.bucket}/${key}`;
  }

  async save(buffer: Buffer, mimeType: string): Promise<{ key: string }> {
    if (!isAllowedMime(mimeType)) throw new Error(`Unsupported media type: ${mimeType}`);
    const key = `${crypto.randomUUID().replace(/-/g, "")}`;
    const res = await fetch(this.objectPath(key), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.opts.serviceRoleKey}`,
        "x-upsert": "true",
        "content-type": mimeType,
      },
      body: new Uint8Array(buffer),
    });
    if (!res.ok) {
      throw new Error(`Supabase upload failed (${res.status}): ${await res.text()}`);
    }
    return { key };
  }

  async fetch(key: string): Promise<{ body: Buffer; mimeType: string } | null> {
    if (!/^[a-f0-9-]+$/i.test(key)) return null;
    const res = await fetch(this.objectPath(key), {
      headers: { Authorization: `Bearer ${this.opts.serviceRoleKey}` },
      redirect: "follow",
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Supabase download failed (${res.status})`);
    const mimeType = res.headers.get("content-type") ?? "application/octet-stream";
    return { body: Buffer.from(await res.arrayBuffer()), mimeType };
  }
}
