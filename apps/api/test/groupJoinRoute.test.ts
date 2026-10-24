import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { loadConfig } from "../src/config";
import type { AppDeps } from "../src/deps";

/**
 * Joining a group writes a membership row and announces it, so it must not be
 * reachable through GET: link previews, prefetchers and crawlers follow GET
 * links without any user intent. These checks only need the router, so the
 * surrounding deps are stubs.
 */
describe("group join routing", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://user@localhost:5432/convo_test",
      JWT_SECRET: "x".repeat(32),
    } as NodeJS.ProcessEnv);
    const deps = {
      config,
      db: {} as unknown as PrismaClient,
      email: {},
      sms: {},
      hub: {},
      media: {},
    } as unknown as AppDeps;
    app = await buildApp(deps);
  });

  afterAll(async () => {
    await app.close();
  });

  it("no longer exposes a GET join", async () => {
    const res = await app.inject({ method: "GET", url: "/groups/join/abcdefgh" });
    expect(res.statusCode).toBe(404);
  });

  it("exposes the join as a POST", async () => {
    // 401 from the auth preHandler still proves the route exists; a missing
    // route would answer 404 instead.
    const res = await app.inject({ method: "POST", url: "/groups/join", payload: { code: "abcdefgh" } });
    expect(res.statusCode).not.toBe(404);
  });

  it("keeps the legacy parameterised POST absent", async () => {
    const res = await app.inject({ method: "POST", url: "/groups/join/abcdefgh" });
    expect(res.statusCode).toBe(404);
  });
});
