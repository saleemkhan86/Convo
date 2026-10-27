import { describe, expect, it, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { Config } from "../src/config";
import { googleOAuthRoutes } from "../src/routes/auth/google";
import type { FastifyInstance } from "fastify";

describe("Google OAuth Routes", () => {
  let mockDb: PrismaClient;
  let mockConfig: Config;
  let mockApp: FastifyInstance;

  beforeEach(() => {
    mockDb = {
      emailIdentity: {
        findUnique: vi.fn(),
        upsert: vi.fn(),
      },
      user: {
        create: vi.fn(),
      },
      mailOAuthState: {
        create: vi.fn(),
        findUnique: vi.fn(),
        updateMany: vi.fn(),
        deleteMany: vi.fn(),
      },
      mailConnection: {
        upsert: vi.fn(),
      },
      authHandoff: {
        create: vi.fn(),
        findUnique: vi.fn(),
        updateMany: vi.fn(),
      },
      refreshToken: {
        create: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
    } as unknown as PrismaClient;

    mockConfig = {
      GOOGLE_CLIENT_ID: "test-client-id",
      GOOGLE_CLIENT_SECRET: "test-client-secret",
      GOOGLE_REDIRECT_URI: "http://localhost:4000/auth/google/callback",
      APP_URL: "http://localhost:5173",
      MAIL_OAUTH_STATE_TTL_SECONDS: 600,
      MAIL_OAUTH_HANDOFF_TTL_SECONDS: 60,
      MAIL_TOKEN_ENC_KEY: Buffer.alloc(32, 1).toString("base64"),
      MAIL_TOKEN_KEY_VERSION: 1,
    } as Config;

    mockApp = {
      get: vi.fn(),
      post: vi.fn(),
    } as unknown as FastifyInstance;
  });

  describe("GET /auth/google", () => {
    it("redirects to Google OAuth URL with PKCE parameters", async () => {
      const mockReply = {
        redirect: vi.fn(),
      };
      const mockRequest = {
        query: { purpose: "SIGN_IN", client: "web" },
      };

      (mockDb.mailOAuthState.create as ReturnType<typeof vi.fn>).mockResolvedValue({
        stateHash: "test-hash",
        expiresAt: new Date(Date.now() + 600_000),
      });

      await googleOAuthRoutes(mockApp, { db: mockDb, config: mockConfig });

      const getHandler = (mockApp.get as ReturnType<typeof vi.fn>).mock.calls.find(
        (call) => call[0] === "/auth/google",
      )?.[1];

      expect(getHandler).toBeDefined();
      await getHandler(mockRequest, mockReply);

      expect(mockReply.redirect).toHaveBeenCalled();
      const redirectUrl = mockReply.redirect.mock.calls[0][0];
      expect(redirectUrl).toContain("accounts.google.com");
      expect(redirectUrl).toContain("client_id=test-client-id");
      expect(redirectUrl).toContain("response_type=code");
      expect(redirectUrl).toContain("code_challenge=");
      expect(redirectUrl).toContain("state=");
    });

    it("throws 503 when Google OAuth is not configured", async () => {
      const unconfiguredConfig = { ...mockConfig, GOOGLE_CLIENT_ID: undefined };
      const mockReply = { redirect: vi.fn() };
      const mockRequest = { query: {} };

      await googleOAuthRoutes(mockApp, { db: mockDb, config: unconfiguredConfig });

      const getHandler = (mockApp.get as ReturnType<typeof vi.fn>).mock.calls.find(
        (call) => call[0] === "/auth/google",
      )?.[1];

      await expect(getHandler(mockRequest, mockReply)).rejects.toThrow(
        /Google OAuth is not configured/,
      );
    });
  });

  describe("POST /auth/oauth/exchange", () => {
    it("exchanges handoff code for session tokens", async () => {
      const mockRequest = {
        body: { code: "test-handoff-code" },
        ip: "127.0.0.1",
        headers: { "user-agent": "test-agent" },
        server: {
          jwt: {
            sign: vi.fn().mockReturnValue("mock-access-token"),
          },
        },
      };

      (mockDb.authHandoff.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "handoff-1",
        userId: "user-1",
        codeHash: "hash",
        expiresAt: new Date(Date.now() + 60_000),
        consumedAt: null,
      });

      (mockDb.authHandoff.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({
        count: 1,
      });

      (mockDb.refreshToken.create as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "session-1",
        userId: "user-1",
        tokenHash: "hash",
        expiresAt: new Date(Date.now() + 90 * 86_400_000),
      });

      await googleOAuthRoutes(mockApp, { db: mockDb, config: mockConfig });

      const postHandler = (mockApp.post as ReturnType<typeof vi.fn>).mock.calls.find(
        (call) => call[0] === "/auth/oauth/exchange",
      )?.[1];

      expect(postHandler).toBeDefined();
      const result = await postHandler(mockRequest);

      expect(result).toHaveProperty("session");
      expect(result).toHaveProperty("userId", "user-1");
      expect(result.session).toHaveProperty("accessToken");
      expect(result.session).toHaveProperty("refreshToken");
    });

    it("throws 400 when code is missing", async () => {
      const mockRequest = {
        body: {},
        ip: "127.0.0.1",
        headers: {},
        server: {},
      };

      await googleOAuthRoutes(mockApp, { db: mockDb, config: mockConfig });

      const postHandler = (mockApp.post as ReturnType<typeof vi.fn>).mock.calls.find(
        (call) => call[0] === "/auth/oauth/exchange",
      )?.[1];

      await expect(postHandler(mockRequest)).rejects.toThrow(/Missing code/);
    });
  });
});
