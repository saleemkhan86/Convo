import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { PrismaClient } from "@prisma/client";
import type {
  AuthResult,
  Challenge,
  MailMessagePage,
  MailThreadList,
  MailThreadSummary,
  SendMailResult,
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

describe.skipIf(!TEST_DATABASE_URL)("mail integration", () => {
  let app: FastifyInstance;
  let db: PrismaClient;
  let hub: SpyHub;

  const ALICE_EMAIL = "mail-alice@example.com";
  const BOB_EMAIL = "mail-bob@example.com";
  const CAROL_EMAIL = "mail-carol@example.com"; // phone-only → no Mail capability
  const PHONE = "+919900005555";

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

    // Child tables first (FK order), then identities/users.
    await db.emailDeliveryEvent.deleteMany();
    await db.emailRecipient.deleteMany();
    await db.emailMessage.deleteMany();
    await db.emailThreadParticipant.deleteMany();
    await db.emailThread.deleteMany();
    await db.emailSendUsage.deleteMany();
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

  async function signupEmail(email: string): Promise<AuthResult> {
    const req = await post("/auth/email/request-otp", { email });
    const challenge = req.json() as Challenge;
    const verify = await post("/auth/email/verify-otp", {
      challengeId: challenge.challengeId,
      code: challenge.devOtp!,
    });
    return verify.json() as AuthResult;
  }

  async function signupPhone(phone: string): Promise<AuthResult> {
    const req = await post("/auth/phone/request-otp", { phone });
    const challenge = req.json() as Challenge;
    const verify = await post("/auth/phone/verify-otp", {
      challengeId: challenge.challengeId,
      code: challenge.devOtp!,
    });
    return verify.json() as AuthResult;
  }

  it("compose to a Convo user mirrors into both mailboxes and fans out realtime", async () => {
    const alice = await signupEmail(ALICE_EMAIL);
    const bob = await signupEmail(BOB_EMAIL);
    hub.add(bob.account.id, noopSocket);

    const send = await post(
      "/mail/send",
      { clientSendId: "aaaaaaaa-0000-4000-8000-000000000001", to: [BOB_EMAIL], subject: "Hello", body: "First mail" },
      alice.session.accessToken,
    );
    expect(send.statusCode, send.body).toBe(200);
    const result = send.json() as SendMailResult;
    expect(result.message.direction).toBe("OUTBOUND");
    expect(result.message.status).toBe("SENT");
    expect(result.message.subject).toBe("Hello");
    expect(result.message.internetMessageId).toMatch(/@convo\.local>$/);
    // Sender's thread shows 0 unread; lastMessage is the outbound copy.
    expect(result.thread.unreadCount).toBe(0);
    expect(result.thread.lastMessage?.direction).toBe("OUTBOUND");

    // Idempotent retry with same clientSendId → same message, no duplicate.
    const retry = await post(
      "/mail/send",
      { clientSendId: "aaaaaaaa-0000-4000-8000-000000000001", to: [BOB_EMAIL], subject: "Hello", body: "First mail" },
      alice.session.accessToken,
    );
    expect((retry.json() as SendMailResult).message.id).toBe(result.message.id);

    // Realtime: Bob got a mail.new; Alice did not.
    const evt = hub.lastEventFor(bob.account.id);
    expect(evt?.type).toBe("mail.new");
    expect(hub.lastEventFor(alice.account.id)).toBeUndefined();

    // Bob sees it in his OWN thread (different id) as INBOUND, unread 1.
    const bobList = (await get("/mail/threads", bob.session.accessToken)).json() as MailThreadList;
    expect(bobList.threads).toHaveLength(1);
    const bobThread = bobList.threads[0]!;
    expect(bobThread.id).not.toBe(result.thread.id);
    expect(bobThread.unreadCount).toBe(1);
    expect(bobThread.subject).toBe("Hello");
    expect(bobThread.lastMessage?.direction).toBe("INBOUND");
    expect(bobThread.lastMessage?.bodyText).toBe("First mail");

    // Alice's mailbox lists exactly one thread with 0 unread.
    const aliceList = (await get("/mail/threads", alice.session.accessToken)).json() as MailThreadList;
    expect(aliceList.threads[0]!.unreadCount).toBe(0);

    // Bob opens + reads → unread clears.
    const msgs = (await get(`/mail/threads/${bobThread.id}/messages`, bob.session.accessToken)).json() as MailMessagePage;
    expect(msgs.messages).toHaveLength(1);
    await post(`/mail/threads/${bobThread.id}/read`, {}, bob.session.accessToken);
    const bobList2 = (await get("/mail/threads", bob.session.accessToken)).json() as MailThreadList;
    expect(bobList2.threads[0]!.unreadCount).toBe(0);
  });

  it("reply threads via In-Reply-To / References and reifies the subject", async () => {
    // Identities persist across tests (same email → same account).
    const a = await signupEmail(ALICE_EMAIL);
    const b = await signupEmail(BOB_EMAIL);
    hub.add(a.account.id, noopSocket);

    const bobThread = (
      (await get("/mail/threads", b.session.accessToken)).json() as MailThreadList
    ).threads.find((t: MailThreadSummary) => t.subject === "Hello")!;
    expect(bobThread).toBeTruthy();

    const reply = await post(
      `/mail/threads/${bobThread.id}/reply`,
      { clientSendId: "bbbbbbbb-0000-4000-8000-000000000002", body: "Reply from Bob" },
      b.session.accessToken,
    );
    expect(reply.statusCode).toBe(200);
    const rep = reply.json() as SendMailResult;
    expect(rep.message.subject).toBe("Re: Hello");
    expect(rep.message.inReplyTo).toMatch(/^<.+@convo\.local>$/);
    expect(rep.message.references.length).toBeGreaterThanOrEqual(1);
    expect(rep.message.direction).toBe("OUTBOUND");

    // It landed in Alice's mailbox as INBOUND with the Re: subject.
    const aliceThread = (
      (await get("/mail/threads", a.session.accessToken)).json() as MailThreadList
    ).threads.find((t: MailThreadSummary) => t.subject === "Re: Hello");
    expect(aliceThread?.unreadCount).toBe(1);
    expect(aliceThread?.lastMessage?.bodyText).toBe("Reply from Bob");

    const evt = hub.lastEventFor(a.account.id);
    expect(evt?.type).toBe("mail.new");
  });

  it("accepts external recipients as QUEUED without leaking the route", async () => {
    const alice = await signupEmail(ALICE_EMAIL);
    const send = await post(
      "/mail/send",
      { clientSendId: "cccccccc-0000-4000-8000-000000000003", to: ["someone@outside.test"], body: "External hello" },
      alice.session.accessToken,
    );
    expect(send.statusCode).toBe(200);
    const result = send.json() as SendMailResult;
    // The recipient is flagged external in the thread participants.
    const external = result.thread.participants.find((p) => p.address === "someone@outside.test");
    expect(external?.isExternal).toBe(true);
    expect(external?.convoUserId).toBeNull();
    // Server-side row was stored QUEUED / EXTERNAL_SMTP for the Phase 4 gateway.
    const stored = await db.emailRecipient.findFirst({
      where: { emailMessageId: result.message.id, address: "someone@outside.test" },
    });
    expect(stored?.status).toBe("QUEUED");
    expect(stored?.route).toBe("EXTERNAL_SMTP");
  });

  it("rejects a phone-only user (no Mail capability) with 403", async () => {
    const carol = await signupPhone(PHONE);
    const list = await get("/mail/threads", carol.session.accessToken);
    expect(list.statusCode).toBe(403);
    const send = await post(
      "/mail/send",
      { clientSendId: "dddddddd-0000-4000-8000-000000000004", to: [ALICE_EMAIL], body: "should fail" },
      carol.session.accessToken,
    );
    expect(send.statusCode).toBe(403);
  });

  it("enforces thread ownership, auth, and validation", async () => {
    const alice = await signupEmail(ALICE_EMAIL);
    const bob = await signupEmail(BOB_EMAIL);
    const outsider = await signupEmail(CAROL_EMAIL);

    const aliceThread = (
      (await get("/mail/threads", alice.session.accessToken)).json() as MailThreadList
    ).threads[0]!;

    const peek = await get(`/mail/threads/${aliceThread.id}/messages`, outsider.session.accessToken);
    expect(peek.statusCode).toBe(404);
    const replyDenied = await post(
      `/mail/threads/${aliceThread.id}/reply`,
      { clientSendId: "eeeeeeee-0000-4000-8000-000000000005", body: "intruder" },
      outsider.session.accessToken,
    );
    expect(replyDenied.statusCode).toBe(404);
    const noAuth = await get(`/mail/threads/${aliceThread.id}/messages`);
    expect(noAuth.statusCode).toBe(401);

    // Empty body / non-uuid clientSendId / self-only recipients → 400.
    const empty = await post(
      "/mail/send",
      { clientSendId: "ffffffff-0000-4000-8000-000000000006", to: [BOB_EMAIL], body: "   " },
      alice.session.accessToken,
    );
    expect(empty.statusCode).toBe(400);
    const badId = await post(
      "/mail/send",
      { clientSendId: "not-a-uuid", to: [BOB_EMAIL], body: "x" },
      alice.session.accessToken,
    );
    expect(badId.statusCode).toBe(400);
    const selfOnly = await post(
      "/mail/send",
      { clientSendId: "00000000-0000-4000-8000-000000000007", to: [ALICE_EMAIL], body: "to myself" },
      alice.session.accessToken,
    );
    expect(selfOnly.statusCode).toBe(400);
  });
});
