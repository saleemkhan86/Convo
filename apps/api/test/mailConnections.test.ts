import { describe, expect, it, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { Config } from "../src/config";
import { connectionRoutes } from "../src/routes/mail/connections";
import type { FastifyInstance } from "fastify";

describe("Connection Routes", () => {
  let mockDb: PrismaClient;
  let mockConfig: Config;
  let mockApp: FastifyInstance;

  beforeEach(() => {
    mockDb = {
      mailConnection: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
        delete: vi.fn(),
      },
    } as unknown as PrismaClient;

    mockConfig = {
      GOOGLE_CLIENT_ID: "test-client-id",
      GOOGLE_CLIENT_SECRET: "test-client-secret",
      GOOGLE_REDIRECT_URI: "http://localhost:4000/auth/google/callback",
      MAIL_OAUTH_STATE_TTL_SECONDS: 600,
      MAIL_TOKEN_ENC_KEY: Buffer.alloc(32, 1).toString("base64"),
      MAIL_TOKEN_KEY_VERSION: 1,
      MAIL_SYNC_INITIAL_DAYS: 30,
      MAIL_SYNC_PAGE_SIZE: 100,
      MAIL_SYNC_CONCURRENCY: 4,
    } as Config;

    mockApp = {
      addHook: vi.fn(),
      get: vi.fn(),
      post: vi.fn(),
      delete: vi.fn(),
    } as unknown as FastifyInstance;
  });

  describe("GET /mail/connections", () => {
    it("lists connections for authenticated user", async () => {
      const mockRequest = {
        currentUser: { id: "user-1" },
      };

      (mockDb.mailConnection.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "conn-1",
          provider: "GOOGLE",
          emailAddress: "alice@example.com",
          displayName: "Alice",
          status: "CONNECTED",
          statusReason: null,
          lastSyncedAt: new Date("2026-10-26T10:00:00Z"),
          createdAt: new Date("2026-10-25T09:00:00Z"),
        },
      ]);

      await connectionRoutes(mockApp, { db: mockDb, config: mockConfig });

      const getHandler = (mockApp.get as ReturnType<typeof vi.fn>).mock.calls.find(
        (call) => call[0] === "/mail/connections",
      )?.[1];

      expect(getHandler).toBeDefined();
      const result = await getHandler(mockRequest);

      expect(result.connections).toHaveLength(1);
      expect(result.connections[0]).toMatchObject({
        id: "conn-1",
        provider: "GOOGLE",
        emailAddress: "alice@example.com",
        status: "CONNECTED",
      });
    });

    it("throws 401 when user is not authenticated", async () => {
      const mockRequest = { currentUser: null };

      await connectionRoutes(mockApp, { db: mockDb, config: mockConfig });

      const getHandler = (mockApp.get as ReturnType<typeof vi.fn>).mock.calls.find(
        (call) => call[0] === "/mail/connections",
      )?.[1];

      await expect(getHandler(mockRequest)).rejects.toThrow(/Authentication required/);
    });
  });

  describe("DELETE /mail/connections/:id", () => {
    it("deletes connection and revokes token", async () => {
      const mockRequest = {
        currentUser: { id: "user-1" },
        params: { id: "conn-1" },
        log: { warn: vi.fn() },
      };

      (mockDb.mailConnection.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "conn-1",
        provider: "GOOGLE",
        emailIdentityId: "identity-1",
        status: "CONNECTED",
        refreshTokenCiphertext: Buffer.from("encrypted"),
        refreshTokenIv: Buffer.alloc(12),
        refreshTokenTag: Buffer.alloc(16),
      });

      (mockDb.mailConnection.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({});
      (mockDb.mailConnection.delete as ReturnType<typeof vi.fn>).mockResolvedValue({});

      await connectionRoutes(mockApp, { db: mockDb, config: mockConfig });

      const deleteHandler = (mockApp.delete as ReturnType<typeof vi.fn>).mock.calls.find(
        (call) => call[0] === "/mail/connections/:id",
      )?.[1];

      expect(deleteHandler).toBeDefined();
      const result = await deleteHandler(mockRequest);

      expect(result).toEqual({ ok: true });
      expect(mockDb.mailConnection.delete).toHaveBeenCalledWith({ where: { id: "conn-1" } });
    });

    it("throws 404 when connection not found", async () => {
      const mockRequest = {
        currentUser: { id: "user-1" },
        params: { id: "conn-999" },
        log: { warn: vi.fn() },
      };

      (mockDb.mailConnection.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await connectionRoutes(mockApp, { db: mockDb, config: mockConfig });

      const deleteHandler = (mockApp.delete as ReturnType<typeof vi.fn>).mock.calls.find(
        (call) => call[0] === "/mail/connections/:id",
      )?.[1];

      await expect(deleteHandler(mockRequest)).rejects.toThrow(/Connection not found/);
    });
  });
});
