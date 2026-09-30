import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { PrismaClient } from "@prisma/client";
import type { Account, AuthResult, Challenge, SessionTokens } from "@convo/shared";
import { buildApp } from "../../src/app";
import { loadConfig } from "../../src/config";
import { createEmailProvider } from "../../src/email/index";
import { createMediaStorage } from "../../src/media/index";
import { InMemoryHub } from "../../src/services/realtime";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("auth + identity integration", () => {
  let app: FastifyInstance;
  let db: PrismaClient;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL!;
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: TEST_DATABASE_URL!,
      JWT_SECRET: "integration-test-secret-value-that-is-long-enough-123",
      DEV_EXPOSE_OTP: "true",
      OTP_RESEND_COOLDOWN_SECONDS: "0",
    } as NodeJS.ProcessEnv);
    db = new PrismaClient();
    app = await buildApp({ config, db, email: createEmailProvider(config), media: createMediaStorage(config), hub: new InMemoryHub() });
    await app.ready();

    // clean slate
    await db.auditLog.deleteMany();
    await db.refreshToken.deleteMany();
    await db.verificationChallenge.deleteMany();
    await db.contact.deleteMany();
    await db.phoneIdentity.deleteMany();
    await db.emailIdentity.deleteMany();
    await db.user.deleteMany();
  });

  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
  });

  const post = (url: string, body: unknown, token?: string) =>
    app.inject({
      method: "POST",
      url,
      payload: body,
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
    });

  const get = (url: string, token?: string) =>
    app.inject({ method: "GET", url, headers: token ? { authorization: `Bearer ${token}` } : undefined });

  async function signupPhone(phone: string): Promise<AuthResult> {
    const req = await post("/auth/phone/request-otp", { phone });
    expect(req.statusCode).toBe(200);
    const challenge = req.json() as Challenge;
    expect(challenge.devOtp).toMatch(/^\d{6}$/);
    const verify = await post("/auth/phone/verify-otp", {
      challengeId: challenge.challengeId,
      code: challenge.devOtp,
    });
    expect(verify.statusCode).toBe(200);
    return verify.json() as AuthResult;
  }

  async function signupEmail(email: string): Promise<AuthResult> {
    const req = await post("/auth/email/request-otp", { email });
    const challenge = req.json() as Challenge;
    const verify = await post("/auth/email/verify-otp", {
      challengeId: challenge.challengeId,
      code: challenge.devOtp,
    });
    expect(verify.statusCode).toBe(200);
    return verify.json() as AuthResult;
  }

  it("GET /health responds", async () => {
    const res = await get("/health");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok" });
  });

  it("flow A: new phone user signs up, gets Chats only", async () => {
    const result = await signupPhone("+919811111111");
    expect(result.isNewAccount).toBe(true);
    expect(result.account.capabilities).toEqual({ chats: true, mail: false });
    expect(result.account.phone?.phone).toBe("+919811111111");
    expect(result.account.email).toBeNull();
    expect(result.session.accessToken).toBeTruthy();
  });

  it("flow C: existing phone identity restores the same account", async () => {
    const result = await signupPhone("+919811111111");
    expect(result.isNewAccount).toBe(false);
    const users = await db.user.count();
    expect(users).toBe(1);
  });

  it("flow B: new email user gets Mail only", async () => {
    const result = await signupEmail("eve@example.com");
    expect(result.isNewAccount).toBe(true);
    expect(result.account.capabilities).toEqual({ chats: false, mail: true });
  });

  it("rejects wrong OTP codes", async () => {
    const req = await post("/auth/email/request-otp", { email: "wrongotp@example.com" });
    const challenge = req.json() as Challenge;
    const bad = (Number(challenge.devOtp) + 1) % 1000000;
    const res = await post("/auth/email/verify-otp", {
      challengeId: challenge.challengeId,
      code: String(bad).padStart(6, "0"),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("OTP_INVALID");
  });

  it("invalidates a consumed challenge (no replay)", async () => {
    const result = await signupEmail("replay@example.com");
    expect(result.isNewAccount).toBe(true);
    // reuse by requesting a new challenge then verifying twice
    const req = await post("/auth/email/request-otp", { email: "replay@example.com" });
    const challenge = req.json() as Challenge;
    const first = await post("/auth/email/verify-otp", {
      challengeId: challenge.challengeId,
      code: challenge.devOtp,
    });
    expect(first.statusCode).toBe(200);
    const second = await post("/auth/email/verify-otp", {
      challengeId: challenge.challengeId,
      code: challenge.devOtp,
    });
    expect(second.statusCode).toBe(400);
    expect(second.json().error.code).toBe("CHALLENGE_NOT_FOUND");
  });

  it("flow E: phone user connects an email — SAME account, both capabilities", async () => {
    const phoneUser = await signupPhone("+919822222222");
    const token = phoneUser.session.accessToken;

    const req = await post("/identities/email/request-otp", { email: "dual@example.com" }, token);
    expect(req.statusCode).toBe(200);
    const challenge = req.json() as Challenge;

    const res = await post(
      "/identities/email/verify-otp",
      { challengeId: challenge.challengeId, code: challenge.devOtp },
      token,
    );
    expect(res.statusCode).toBe(200);
    const account = res.json() as Account;
    expect(account.id).toBe(phoneUser.account.id); // no second account
    expect(account.capabilities).toEqual({ chats: true, mail: true });
    expect(account.email?.email).toBe("dual@example.com");

    const userCount = await db.user.count({ where: { id: account.id } });
    expect(userCount).toBe(1);
  });

  it("flow E: email user connects a phone", async () => {
    const emailUser = await signupEmail("phonebind@example.com");
    const token = emailUser.session.accessToken;
    const req = await post("/identities/phone/request-otp", { phone: "+919833333333" }, token);
    const challenge = req.json() as Challenge;
    const res = await post(
      "/identities/phone/verify-otp",
      { challengeId: challenge.challengeId, code: challenge.devOtp },
      token,
    );
    expect(res.statusCode).toBe(200);
    const account = res.json() as Account;
    expect(account.id).toBe(emailUser.account.id);
    expect(account.capabilities).toEqual({ chats: true, mail: true });
  });

  it("refuses connecting an email owned by another account (no merge, no enumeration)", async () => {
    const phoneUser = await signupPhone("+919844444444");
    const res = await post(
      "/identities/email/request-otp",
      { email: "dual@example.com" }, // owned by the flow-E user above
      phoneUser.session.accessToken,
    );
    expect(res.statusCode).toBe(409);
    const body = res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("IDENTITY_LINKED_TO_ANOTHER_ACCOUNT");
    expect(body.error.message).not.toContain("dual@example.com");
  });

  it("refuses connecting a second email to the same account", async () => {
    const dual = await signupPhone("+919822222222"); // has dual@example.com
    const res = await post(
      "/identities/email/request-otp",
      { email: "another@example.com" },
      dual.session.accessToken,
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("IDENTITY_ALREADY_LINKED_TO_THIS_ACCOUNT");
  });

  it("identity linking requires authentication", async () => {
    const res = await post("/identities/email/request-otp", { email: "x@example.com" });
    expect(res.statusCode).toBe(401);
  });

  it("GET /me and PATCH /me/profile work", async () => {
    const user = await signupEmail("profile@example.com");
    const token = user.session.accessToken;

    const me = await get("/me", token);
    expect(me.statusCode).toBe(200);
    expect((me.json() as Account).email?.email).toBe("profile@example.com");

    const patch = await app.inject({
      method: "PATCH",
      url: "/me/profile",
      headers: { authorization: `Bearer ${token}` },
      payload: { displayName: "Profile Test", bio: "hello" },
    });
    expect(patch.statusCode).toBe(200);
    expect((patch.json() as Account).displayName).toBe("Profile Test");
  });

  it("refresh rotates tokens; old refresh token is revoked", async () => {
    const user = await signupEmail("rotate@example.com");
    const res = await post("/auth/refresh", { refreshToken: user.session.refreshToken });
    expect(res.statusCode).toBe(200);
    const rotated = res.json() as SessionTokens;
    expect(rotated.refreshToken).not.toBe(user.session.refreshToken);

    const replay = await post("/auth/refresh", { refreshToken: user.session.refreshToken });
    expect(replay.statusCode).toBe(401);
  });

  it("logout revokes the refresh token", async () => {
    const user = await signupEmail("logout@example.com");
    const out = await post("/auth/logout", { refreshToken: user.session.refreshToken });
    expect(out.statusCode).toBe(200);
    const res = await post("/auth/refresh", { refreshToken: user.session.refreshToken });
    expect(res.statusCode).toBe(401);
  });

  it("validates request bodies at the boundary", async () => {
    const res = await post("/auth/phone/request-otp", { phone: "not-a-phone" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("caps OTP attempts", async () => {
    const req = await post("/auth/email/request-otp", { email: "brute@example.com" });
    const challenge = req.json() as Challenge;
    const wrong = String((Number(challenge.devOtp) + 1) % 1000000).padStart(6, "0");
    for (let i = 0; i < 5; i++) {
      const res = await post("/auth/email/verify-otp", {
        challengeId: challenge.challengeId,
        code: wrong,
      });
      expect(res.statusCode).toBe(400);
    }
    const locked = await post("/auth/email/verify-otp", {
      challengeId: challenge.challengeId,
      code: challenge.devOtp, // correct code, but attempts exhausted
    });
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error.code).toBe("OTP_ATTEMPTS_EXCEEDED");
  });
});
