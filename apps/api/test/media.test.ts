import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import fastifyJwt from "@fastify/jwt";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import type { AppDeps } from "../src/deps";
import { isAllowedMime, kindForMime, newStorageKey } from "../src/media/provider";
import { LocalFileStorage } from "../src/media/local";
import { mediaDownloadUrl } from "../src/routes/media";

describe("mime classification", () => {
  it("maps mime types to attachment kinds", () => {
    expect(kindForMime("image/png")).toBe("IMAGE");
    expect(kindForMime("video/mp4")).toBe("VIDEO");
    expect(kindForMime("audio/ogg")).toBe("VOICE");
    expect(kindForMime("application/pdf")).toBe("DOCUMENT");
    expect(kindForMime("application/zip")).toBe("OTHER");
  });

  it("accepts media and documents but not arbitrary types", () => {
    expect(isAllowedMime("image/webp")).toBe(true);
    expect(isAllowedMime("video/webm")).toBe(true);
    expect(isAllowedMime("application/pdf")).toBe(true);
    expect(isAllowedMime("application/x-executable")).toBe(false);
    expect(isAllowedMime("text/html")).toBe(false);
  });

  it("issues keys that fit the storage safety pattern", () => {
    const key = newStorageKey();
    expect(key).toMatch(/^[a-f0-9-]+\.[a-z0-9]+$/i);
    expect(key).not.toBe(newStorageKey());
  });
});

describe("media download URLs", () => {
  const secret = "x".repeat(48);

  async function depsWith(env: Record<string, string>): Promise<AppDeps> {
    const config = loadConfig({
      DATABASE_URL: "postgresql://user:pass@localhost:5432/convo",
      JWT_SECRET: secret,
      ...env,
    });
    return { config } as unknown as AppDeps;
  }

  it("builds absolute URLs on the API origin, not the web app origin", async () => {
    const app = Fastify();
    await app.register(fastifyJwt, { secret });
    const deps = await depsWith({
      API_PUBLIC_URL: "https://api.convo.test",
      APP_URL: "https://convo.test",
    });

    const url = mediaDownloadUrl(app, deps, "abc.png");
    expect(url.startsWith("https://api.convo.test/media/abc.png?token=")).toBe(true);
    expect(url.startsWith("https://convo.test/")).toBe(false);

    const token = new URL(url).searchParams.get("token");
    expect(app.jwt.verify(token as string).media).toBe("abc.png");
    await app.close();
  });

  it("defaults to the local API port in development", async () => {
    const app = Fastify();
    await app.register(fastifyJwt, { secret });
    const url = mediaDownloadUrl(app, await depsWith({}), "abc.png");
    expect(url.startsWith("http://localhost:4000/media/abc.png?token=")).toBe(true);
    await app.close();
  });
});

describe("LocalFileStorage", () => {
  let dir: string;
  let storage: LocalFileStorage;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "convo-media-"));
    process.env.MEDIA_LOCAL_DIR = dir;
    storage = new LocalFileStorage();
  });

  afterAll(async () => {
    delete process.env.MEDIA_LOCAL_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips stored bytes and reports the mime type back", async () => {
    const payload = Buffer.from("fake-jpeg-bytes");
    const { key } = await storage.save(payload, "image/jpeg");
    const stored = await storage.fetch(key);
    expect(stored?.body.equals(payload)).toBe(true);
    expect(stored?.mimeType).toBe("image/jpeg");
  });

  it("returns null instead of reading outside the storage root", async () => {
    expect(await storage.fetch("../../etc/passwd")).toBeNull();
    expect(await storage.fetch("deadbeef.jpg")).toBeNull();
  });

  it("refuses unsupported mime types", async () => {
    await expect(storage.save(Buffer.from("x"), "application/x-executable")).rejects.toThrow();
  });
});
