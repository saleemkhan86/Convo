import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { PrismaClient } from "@prisma/client";
import type {
  Account,
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
  eventsFor(userId: string): WsServerEvent[] {
    return this.published.filter((p) => p.userIds.includes(userId)).map((p) => p.event);
  }
  lastEventFor(userId: string): WsServerEvent | undefined {
    return this.eventsFor(userId).at(-1);
  }
}

const noopSocket: SocketLike = { send: () => {}, readyState: 1 };

describe.skipIf(!TEST_DATABASE_URL)("chat options integration (Phase 4A)", () => {
  let app: FastifyInstance;
  let db: PrismaClient;
  let hub: SpyHub;

  const ALICE_PHONE = "+919900001001";
  const BOB_PHONE = "+919900001002";
  const CAROL_PHONE = "+919900001003";

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
    app.inject({ method: "POST", url, payload: body, headers: auth(token) });
  const get = (url: string, token?: string) =>
    app.inject({ method: "GET", url, headers: auth(token) });
  const patch = (url: string, body: unknown, token?: string) =>
    app.inject({ method: "PATCH", url, payload: body, headers: auth(token) });
  const put = (url: string, body: unknown, token?: string) =>
    app.inject({ method: "PUT", url, payload: body, headers: auth(token) });
  const del = (url: string, token?: string, body?: unknown) =>
    app.inject({ method: "DELETE", url, payload: body, headers: auth(token) });

  function auth(token?: string): Record<string, string> | undefined {
    return token ? { authorization: `Bearer ${token}` } : undefined;
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

  let seq = 0;
  const cmid = () =>
    `aaaa${(++seq).toString().padStart(4, "0")}-0000-4000-8000-000000000000`;

  async function startConversation(a: AuthResult, bPhone: string): Promise<ConversationSummary> {
    const res = await post("/conversations/start", { phone: bPhone }, a.session.accessToken);
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as ConversationSummary;
  }

  it("edits own messages, forbids editing others', broadcasts message.edited", async () => {
    const alice = await signupPhone(ALICE_PHONE);
    const bob = await signupPhone(BOB_PHONE);
    hub.add(bob.account.id, noopSocket);
    const conv = await startConversation(alice, BOB_PHONE);

    const send = await post(
      `/conversations/${conv.id}/messages`,
      { clientMessageId: cmid(), body: "original" },
      alice.session.accessToken,
    );
    const msg = send.json() as Message;

    const denied = await patch(`/messages/${msg.id}`, { body: "hacked" }, bob.session.accessToken);
    expect(denied.statusCode).toBe(403);

    const edit = await patch(`/messages/${msg.id}`, { body: "edited text" }, alice.session.accessToken);
    expect(edit.statusCode, edit.body).toBe(200);
    const edited = edit.json() as Message;
    expect(edited.body).toBe("edited text");
    expect(edited.editedAt).not.toBeNull();

    const evt = hub.eventsFor(bob.account.id).find((e) => e.type === "message.edited");
    expect(evt).toBeDefined();

    const page = (await get(`/conversations/${conv.id}/messages`, alice.session.accessToken)).json() as MessagePage;
    expect(page.messages.find((m) => m.id === msg.id)?.body).toBe("edited text");
  });

  it("deletes for everyone (clears body) and for me (hides only from viewer)", async () => {
    const alice = await signupPhone(ALICE_PHONE);
    const carol = await signupPhone(CAROL_PHONE);
    hub.add(carol.account.id, noopSocket);
    const conv = await startConversation(alice, CAROL_PHONE);

    // Delete for everyone, by the sender.
    const a1 = await post(
      `/conversations/${conv.id}/messages`,
      { clientMessageId: cmid(), body: "to vanish" },
      alice.session.accessToken,
    );
    const msgEveryone = a1.json() as Message;

    const notSender = await del(`/messages/${msgEveryone.id}`, carol.session.accessToken, { scope: "EVERYONE" });
    expect(notSender.statusCode).toBe(403);

    const delEveryone = await del(`/messages/${msgEveryone.id}`, alice.session.accessToken, { scope: "EVERYONE" });
    expect(delEveryone.statusCode, delEveryone.body).toBe(200);
    const aliceTimeline = (await get(`/conversations/${conv.id}/messages`, alice.session.accessToken)).json() as MessagePage;
    const deletedRow = aliceTimeline.messages.find((m) => m.id === msgEveryone.id)!;
    expect(deletedRow.deletedAt).not.toBeNull();
    expect(deletedRow.body).toBeNull();

    // Delete for me: recipient hides, sender still sees it.
    const a2 = await post(
      `/conversations/${conv.id}/messages`,
      { clientMessageId: cmid(), body: "keep it" },
      alice.session.accessToken,
    );
    const msgMine = a2.json() as Message;
    const delMine = await del(`/messages/${msgMine.id}`, carol.session.accessToken, { scope: "MINE" });
    expect(delMine.statusCode, delMine.body).toBe(200);

    const carolTimeline = (await get(`/conversations/${conv.id}/messages`, carol.session.accessToken)).json() as MessagePage;
    const aliceTimeline2 = (await get(`/conversations/${conv.id}/messages`, alice.session.accessToken)).json() as MessagePage;
    expect(carolTimeline.messages.some((m) => m.id === msgMine.id)).toBe(false);
    expect(aliceTimeline2.messages.some((m) => m.id === msgMine.id)).toBe(true);

    // Hidden message drops out of the viewer's conversation-list preview watermark too.
    const carolList = (await get("/conversations", carol.session.accessToken)).json() as ConversationList;
    expect(carolList.conversations.find((c) => c.id === conv.id)?.lastMessage?.id).not.toBe(msgMine.id);
  });

  it("adds, aggregates and removes emoji reactions with per-viewer flags", async () => {
    const alice = await signupPhone(ALICE_PHONE);
    const bob = await signupPhone(BOB_PHONE);
    hub.add(bob.account.id, noopSocket);
    const conv = await startConversation(alice, BOB_PHONE);

    const send = await post(
      `/conversations/${conv.id}/messages`,
      { clientMessageId: cmid(), body: "react to me" },
      alice.session.accessToken,
    );
    const msg = send.json() as Message;

    const aliceReact = await put(`/messages/${msg.id}/reactions`, { emoji: "👍" }, alice.session.accessToken);
    expect(aliceReact.statusCode, aliceReact.body).toBe(200);
    expect((aliceReact.json() as Message).reactions).toEqual([{ emoji: "👍", count: 1, reactedByMe: true }]);

    await put(`/messages/${msg.id}/reactions`, { emoji: "👍" }, bob.session.accessToken);

    // Bob's view: count 2, reactedByMe true for him; Alice's view: count 2, reactedByMe for her.
    const bobView = (await get(`/conversations/${conv.id}/messages`, bob.session.accessToken)).json() as MessagePage;
    const bobReaction = bobView.messages.find((m) => m.id === msg.id)!.reactions[0]!;
    expect(bobReaction).toEqual({ emoji: "👍", count: 2, reactedByMe: true });

    // Alice un-reacts → count 1, reactedByMe false for Bob.
    const unReact = await del(`/messages/${msg.id}/reactions?emoji=%F0%9F%91%8D`, alice.session.accessToken);
    expect(unReact.statusCode, unReact.body).toBe(200);
    expect((unReact.json() as Message).reactions).toEqual([{ emoji: "👍", count: 1, reactedByMe: false }]);

    const evt = hub.eventsFor(bob.account.id).find((e) => e.type === "message.reacted");
    expect(evt).toBeDefined();
  });

  it("tracks delivery receipts: sent → delivered (online) → read", async () => {
    const alice = await signupPhone(ALICE_PHONE);
    const bob = await signupPhone(BOB_PHONE);
    hub.add(bob.account.id, noopSocket); // online at send → delivered immediately
    const conv = await startConversation(alice, BOB_PHONE);

    const send = await post(
      `/conversations/${conv.id}/messages`,
      { clientMessageId: cmid(), body: "hi bob" },
      alice.session.accessToken,
    );
    const msg = send.json() as Message;
    expect(msg.deliveryStatus).toBe("DELIVERED");

    // Sender-only field: Bob sees no tick on Alice's message.
    const bobView = (await get(`/conversations/${conv.id}/messages`, bob.session.accessToken)).json() as MessagePage;
    expect(bobView.messages.find((m) => m.id === msg.id)?.deliveryStatus).toBeNull();

    await post(`/conversations/${conv.id}/read`, { messageId: msg.id }, bob.session.accessToken);

    const aliceView = (await get(`/conversations/${conv.id}/messages`, alice.session.accessToken)).json() as MessagePage;
    expect(aliceView.messages.find((m) => m.id === msg.id)?.deliveryStatus).toBe("READ");

    const deliveredEvt = hub.eventsFor(alice.account.id).find((e) => e.type === "message.delivered");
    expect(deliveredEvt).toBeDefined();
  });

  it("gates peer last-seen by presenceVisibility", async () => {
    const alice = await signupPhone(ALICE_PHONE);
    const carol = await signupPhone(CAROL_PHONE);
    const conv = await startConversation(alice, CAROL_PHONE);
    const seenAt = new Date();

    await db.user.update({ where: { id: carol.account.id }, data: { lastSeenAt: seenAt, presenceVisibility: "EVERYONE" } });
    const aliceList = (await get("/conversations", alice.session.accessToken)).json() as ConversationList;
    expect(aliceList.conversations.find((c) => c.id === conv.id)?.peer?.lastSeenAt).toBe(seenAt.toISOString());

    await db.user.update({ where: { id: carol.account.id }, data: { presenceVisibility: "NONE" } });
    const hidden = (await get("/conversations", alice.session.accessToken)).json() as ConversationList;
    expect(hidden.conversations.find((c) => c.id === conv.id)?.peer?.lastSeenAt).toBeNull();

    // CONTACTS hides until Carol saves Alice as a contact, then reveals.
    await db.user.update({ where: { id: carol.account.id }, data: { presenceVisibility: "CONTACTS" } });
    const contactsHidden = (await get("/conversations", alice.session.accessToken)).json() as ConversationList;
    expect(contactsHidden.conversations.find((c) => c.id === conv.id)?.peer?.lastSeenAt).toBeNull();

    await db.contact.create({
      data: { ownerId: carol.account.id, displayName: "Alice", convoUserId: alice.account.id },
    });
    const contactsShown = (await get("/conversations", alice.session.accessToken)).json() as ConversationList;
    expect(contactsShown.conversations.find((c) => c.id === conv.id)?.peer?.lastSeenAt).toBe(seenAt.toISOString());
  });

  it("reads and updates presenceVisibility on the profile", async () => {
    const alice = await signupPhone(ALICE_PHONE);
    const me = (await get("/me", alice.session.accessToken)).json() as Account;
    expect(me.presenceVisibility).toBe("EVERYONE");
    const upd = await patch("/me/profile", { presenceVisibility: "NONE" }, alice.session.accessToken);
    expect(upd.statusCode, upd.body).toBe(200);
    expect((upd.json() as Account).presenceVisibility).toBe("NONE");
  });
});
