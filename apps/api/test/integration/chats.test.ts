import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { PrismaClient } from "@prisma/client";
import type {
  AuthResult,
  Challenge,
  ConversationList,
  ConversationSummary,
  Message,
  MessagePage,
  WsServerEvent,
} from "@convo/shared";
import { buildApp } from "../../src/app";
import { loadConfig } from "../../src/config";
import { createEmailProvider } from "../../src/email/index";
import { createMediaStorage } from "../../src/media/index";
import { InMemoryHub, type RealtimeHub, type SocketLike } from "../../src/services/realtime";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

class SpyHub extends InMemoryHub implements RealtimeHub {
  published: Array<{ userIds: string[]; event: WsServerEvent }> = [];
  override publishToUsers(userIds: Iterable<string>, event: WsServerEvent): void {
    this.published.push({ userIds: [...userIds], event });
    super.publishToUsers(userIds, event);
  }
  lastEventFor(userId: string): WsServerEvent | undefined {
    return [...this.published].reverse().find((p) => p.userIds.includes(userId))?.event;
  }
}

const noopSocket: SocketLike = { send: () => {}, readyState: 1 };

describe.skipIf(!TEST_DATABASE_URL)("chats integration", () => {
  let app: FastifyInstance;
  let db: PrismaClient;
  let hub: SpyHub;

  const ALICE_PHONE = "+919900000001";
  const CAROL_PHONE = "+919900000002";
  const BOB_EMAIL = "chats-bob@example.com";

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
    hub = new SpyHub();
    app = await buildApp({ config, db, email: createEmailProvider(config), media: createMediaStorage(config), hub });
    await app.ready();

    await db.message.deleteMany();
    await db.conversationMember.deleteMany();
    await db.conversation.deleteMany();
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
    const challenge = req.json() as Challenge;
    const verify = await post("/auth/phone/verify-otp", {
      challengeId: challenge.challengeId,
      code: challenge.devOtp!,
    });
    return verify.json() as AuthResult;
  }

  async function signupEmail(email: string): Promise<AuthResult> {
    const req = await post("/auth/email/request-otp", { email });
    const challenge = req.json() as Challenge;
    const verify = await post("/auth/email/verify-otp", {
      challengeId: challenge.challengeId,
      code: challenge.devOtp!,
    });
    return verify.json() as AuthResult;
  }

  it("start, send, list, read — full 1-1 happy path with realtime events", async () => {
    const alice = await signupPhone(ALICE_PHONE);
    const carol = await signupPhone(CAROL_PHONE);
    hub.add(carol.account.id, noopSocket); // Carol "online" to receive fan-out

    // Start is idempotent: same conversation both times.
    const start1 = await post("/conversations/start", { phone: CAROL_PHONE }, alice.session.accessToken);
    expect(start1.statusCode).toBe(200);
    const conv1 = start1.json() as ConversationSummary;
    expect(conv1.type).toBe("DIRECT");
    expect(conv1.peer?.phone).toBe(CAROL_PHONE);

    const start2 = await post("/conversations/start", { phone: CAROL_PHONE }, alice.session.accessToken);
    expect((start2.json() as ConversationSummary).id).toBe(conv1.id);

    // Carol sees the same conversation from her side.
    const startFromCarol = await post("/conversations/start", { phone: ALICE_PHONE }, carol.session.accessToken);
    expect((startFromCarol.json() as ConversationSummary).id).toBe(conv1.id);

    // Send + idempotent retry with the same clientMessageId.
    const clientMessageId = "11111111-1111-4111-8111-111111111111";
    const send1 = await post(
      `/conversations/${conv1.id}/messages`,
      { clientMessageId, body: "Hey Carol!" },
      alice.session.accessToken,
    );
    expect(send1.statusCode).toBe(200);
    const msg1 = send1.json() as Message;
    expect(msg1.body).toBe("Hey Carol!");

    const retry = await post(
      `/conversations/${conv1.id}/messages`,
      { clientMessageId, body: "Hey Carol!" },
      alice.session.accessToken,
    );
    expect((retry.json() as Message).id).toBe(msg1.id); // no duplicate

    // Realtime fan-out reached Carol only.
    const evt = hub.lastEventFor(carol.account.id);
    expect(evt?.type).toBe("message.new");
    expect(hub.lastEventFor(alice.account.id)).toBeUndefined();

    // Conversation list: Carol has 1 unread; Alice has 0.
    const carolList = (await get("/conversations", carol.session.accessToken)).json() as ConversationList;
    expect(carolList.conversations).toHaveLength(1);
    expect(carolList.conversations[0]!.unreadCount).toBe(1);
    expect(carolList.conversations[0]!.lastMessage?.body).toBe("Hey Carol!");
    const aliceList = (await get("/conversations", alice.session.accessToken)).json() as ConversationList;
    expect(aliceList.conversations[0]!.unreadCount).toBe(0);

    // Carol replies, then reads Alice's message → unread clears + read event.
    await post(
      `/conversations/${conv1.id}/messages`,
      { clientMessageId: "22222222-2222-4222-8222-222222222222", body: "Hi Alice!" },
      carol.session.accessToken,
    );
    await post(`/conversations/${conv1.id}/read`, {}, carol.session.accessToken);
    const readEvt = hub.lastEventFor(alice.account.id);
    expect(readEvt?.type).toBe("message.read");
    const carolList2 = (await get("/conversations", carol.session.accessToken)).json() as ConversationList;
    expect(carolList2.conversations[0]!.unreadCount).toBe(0);

    // Timeline is oldest-first and complete.
    const page = (await get(`/conversations/${conv1.id}/messages`, alice.session.accessToken)).json() as MessagePage;
    expect(page.messages.map((m) => m.body)).toEqual(["Hey Carol!", "Hi Alice!"]);
  });

  it("rejects unknown phones, self-chats, and email-only users", async () => {
    const alice = await signupPhone(ALICE_PHONE);
    const unknown = await post("/conversations/start", { phone: "+919900009999" }, alice.session.accessToken);
    expect(unknown.statusCode).toBe(404);

    const self = await post("/conversations/start", { phone: ALICE_PHONE }, alice.session.accessToken);
    expect(self.statusCode).toBe(404); // generic, non-enumerating

    const bob = await signupEmail(BOB_EMAIL);
    const noPhone = await post("/conversations/start", { phone: ALICE_PHONE }, bob.session.accessToken);
    expect(noPhone.statusCode).toBe(403); // Chats require a phone identity
  });

  it("enforces membership and auth on message access", async () => {
    const alice = await signupPhone(ALICE_PHONE);
    const carol = await signupPhone(CAROL_PHONE);
    const outsider = await signupPhone("+919900000003");

    const conv = (
      await post("/conversations/start", { phone: CAROL_PHONE }, alice.session.accessToken)
    ).json() as ConversationSummary;

    const peek = await get(`/conversations/${conv.id}/messages`, outsider.session.accessToken);
    expect(peek.statusCode).toBe(404);
    const sendDenied = await post(
      `/conversations/${conv.id}/messages`,
      { clientMessageId: "33333333-3333-4333-8333-333333333333", body: "intruder" },
      outsider.session.accessToken,
    );
    expect(sendDenied.statusCode).toBe(404);
    const noAuth = await get(`/conversations/${conv.id}/messages`);
    expect(noAuth.statusCode).toBe(401);
    expect(carol.account.id).toBeTruthy();
  });

  it("validates message bodies", async () => {
    const alice = await signupPhone(ALICE_PHONE);
    const carol = await signupPhone(CAROL_PHONE);
    const conv = (
      await post("/conversations/start", { phone: CAROL_PHONE }, alice.session.accessToken)
    ).json() as ConversationSummary;

    const empty = await post(
      `/conversations/${conv.id}/messages`,
      { clientMessageId: "44444444-4444-4444-8444-444444444444", body: "   " },
      alice.session.accessToken,
    );
    expect(empty.statusCode).toBe(400);
    const badId = await post(
      `/conversations/${conv.id}/messages`,
      { clientMessageId: "not-a-uuid", body: "x" },
      alice.session.accessToken,
    );
    expect(badId.statusCode).toBe(400);
  });
});
