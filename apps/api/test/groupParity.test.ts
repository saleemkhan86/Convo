import type { PrismaClient } from "@prisma/client";
import type { GroupSettings } from "@convo/shared";
import { describe, expect, it, vi } from "vitest";
import { mayInvite, summaryOf, type ConversationWithGroup } from "../src/services/groups";
import { parseMentions } from "../src/services/mentions";
import {
  listPinned,
  serializeMessage,
  setMessagePinned,
  type ConversationDeps,
} from "../src/services/conversations";

/**
 * Phase 5E unit coverage for the group-parity rules that need no database:
 * server-side @mention resolution, who may see the invite link, the signed
 * group icon, and the pin write/read path against a stubbed client.
 */

const NOW = new Date("2026-09-29T10:00:00.000Z");
const mediaUrl = (key: string) => `https://cdn.test/${key}`;

describe("parseMentions", () => {
  const roster = [
    { userId: "u1", displayName: "Sammy Khan" },
    { userId: "u2", displayName: "Sam Ali" },
    { userId: "u3", displayName: null },
  ];

  it("matches a full name and its first word", () => {
    expect(parseMentions("@Sammy Khan can you join?", roster)).toEqual(["u1"]);
    expect(parseMentions("@Sammy can you join?", roster)).toEqual(["u1"]);
  });

  it("never fires for a longer name it is a prefix of", () => {
    // "@Sam" must not light up Sammy, and the reverse must not swallow either.
    expect(parseMentions("@Sam, ping me", roster)).toEqual(["u2"]);
    expect(parseMentions("@Sammy, ping me", roster)).toEqual(["u1"]);
  });

  it("ignores @ inside words and email addresses", () => {
    expect(parseMentions("mail me at sam.my@corp.example", roster)).toEqual([]);
    expect(parseMentions("user@Sam", roster)).toEqual([]);
    expect(parseMentions("shaikh.sam@corp.example", roster)).toEqual([]);
  });

  it("ends a match at any non-word character", () => {
    expect(parseMentions("hey @Sam!", roster)).toEqual(["u2"]);
    // "@Sammy.khan" still starts with a boundary-anchored @Sammy, so Sammy is
    // named; the trailing handle is not part of the match.
    expect(parseMentions("@Sammy-Khan", roster)).toEqual(["u1"]);
  });

  it("is case-insensitive and reports each member once, in roster order", () => {
    expect(parseMentions("@SAMMY and sam ali and @Sam Ali", roster)).toEqual(["u1", "u2"]);
  });

  it("needs an @ before any roster scan", () => {
    expect(parseMentions("no symbols here", roster)).toEqual([]);
    expect(parseMentions(null, roster)).toEqual([]);
    expect(parseMentions(undefined, roster)).toEqual([]);
  });
});

describe("mayInvite", () => {
  const settings = (whoCanInvite: GroupSettings["whoCanInvite"]): GroupSettings => ({
    visibility: "PRIVATE",
    whoCanSend: "ALL",
    whoCanEdit: "ALL",
    whoCanInvite,
    announceOnly: false,
    requireApproval: false,
  });

  it("shares the link with members when invitations are open to all", () => {
    expect(mayInvite("MEMBER", settings("ALL"))).toBe(true);
    expect(mayInvite("ADMIN", settings("ALL"))).toBe(true);
  });

  it("withholds it from members when only admins may invite", () => {
    expect(mayInvite("MEMBER", settings("ADMINS"))).toBe(false);
    expect(mayInvite("ADMIN", settings("ADMINS"))).toBe(true);
  });

  it("never shows the link to a non-member", () => {
    expect(mayInvite(null, settings("ALL"))).toBe(false);
    expect(mayInvite(null, settings("ADMINS"))).toBe(false);
  });
});

interface GroupRowOptions {
  storageKey?: string | null;
  avatarUrl?: string | null;
  inviteCode?: string | null;
}

/** A conversation shaped like the `group: true, members: true` read. */
function groupConv(options: GroupRowOptions = {}): ConversationWithGroup {
  return {
    id: "g1",
    type: "GROUP",
    title: "Weekend trip crew",
    // A group created before 5E keeps the plain url column; newer ones sign a key.
    avatarUrl: options.avatarUrl ?? null,
    createdAt: NOW,
    group: {
      conversationId: "g1",
      about: "Two nights, one cabin",
      inviteCode: options.inviteCode ?? "abcdef12",
      avatarStorageKey: options.storageKey ?? null,
      visibility: "PRIVATE",
      whoCanSend: "ALL",
      whoCanEdit: "ALL",
      whoCanInvite: "ALL",
      announceOnly: false,
      requireApproval: true,
    },
    members: [
      { userId: "u1", role: "ADMIN", joinState: "ACTIVE", leftAt: null },
      { userId: "u2", role: "MEMBER", joinState: "ACTIVE", leftAt: null },
      { userId: "u3", role: "MEMBER", joinState: "PENDING", leftAt: null },
      { userId: "u4", role: "MEMBER", joinState: "ACTIVE", leftAt: NOW },
    ],
  } as unknown as ConversationWithGroup;
}

describe("summaryOf", () => {
  it("signs a fresh URL for an uploaded group icon", () => {
    const summary = summaryOf(groupConv({ storageKey: "key-123" }), "MEMBER", true, mediaUrl);
    expect(summary.avatarUrl).toBe("https://cdn.test/key-123");
  });

  it("falls back to the stored avatarUrl when no key was uploaded", () => {
    const summary = summaryOf(
      groupConv({ storageKey: null, avatarUrl: "https://example.test/a.png" }),
      "MEMBER",
      true,
      mediaUrl,
    );
    expect(summary.avatarUrl).toBe("https://example.test/a.png");
  });

  it("answers with initials-only null when the group has no icon at all", () => {
    expect(summaryOf(groupConv(), "MEMBER", true, mediaUrl).avatarUrl).toBeNull();
  });

  it("only includes the invite code when the caller may share it", () => {
    expect(summaryOf(groupConv(), "MEMBER", true, mediaUrl).inviteCode).toBe("abcdef12");
    expect(summaryOf(groupConv(), "MEMBER", false, mediaUrl).inviteCode).toBeNull();
  });

  it("counts active members, excluding pending requests and people who left", () => {
    expect(summaryOf(groupConv(), "MEMBER", true, mediaUrl).memberCount).toBe(2);
  });
});

type MessageRow = Parameters<typeof serializeMessage>[0];

/** A message row shaped like `messageInclude`, with only 5E relations filled. */
function messageRow(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: "m1",
    conversationId: "c1",
    senderId: "u2",
    clientMessageId: "cm1",
    type: "TEXT",
    body: "hi",
    replyToId: null,
    editedAt: null,
    deletedAt: null,
    viewOnce: false,
    createdAt: NOW,
    reactions: [],
    receipts: [],
    starredBy: [],
    attachments: [],
    forwardedFrom: null,
    viewOnceViews: [],
    mentions: [],
    pin: null,
    ...overrides,
  } as unknown as MessageRow;
}

describe("serializeMessage 5E fields", () => {
  it("exposes mention ids and marks the viewer's own mention", () => {
    const row = messageRow({ mentions: [{ userId: "u1" }, { userId: "u2" }] });
    expect(serializeMessage(row, "u1", mediaUrl).mentionedMe).toBe(true);
    expect(serializeMessage(row, "u1", mediaUrl).mentions).toEqual(["u1", "u2"]);
    expect(serializeMessage(row, "u9", mediaUrl).mentionedMe).toBe(false);
  });

  it("carries the shared pin with its author, or null when unpinned", () => {
    const pinned = messageRow({
      pin: { pinnedById: "u1", pinnedAt: NOW, user: { displayName: "Sam Ali" } },
    });
    expect(serializeMessage(pinned, "u2", mediaUrl).pinned).toEqual({
      userId: "u1",
      displayName: "Sam Ali",
      pinnedAt: "2026-09-29T10:00:00.000Z",
    });
    // Pins are shared state, so every viewer sees the same one.
    expect(serializeMessage(pinned, "u1", mediaUrl).pinned).not.toBeNull();
    expect(serializeMessage(messageRow(), "u1", mediaUrl).pinned).toBeNull();
  });
});

interface PinCalls {
  upserts: { create?: unknown; update?: unknown }[];
  deletes: unknown[];
  published: { userIds: string[]; event: unknown }[];
}

function pinDeps(options: { member: boolean; pinned?: boolean }) {
  const calls: PinCalls = { upserts: [], deletes: [], published: [] };
  const loaded = messageRow({
    pin:
      options.pinned === false
        ? null
        : { pinnedById: "u1", pinnedAt: NOW, user: { displayName: "Sam Ali" } },
  });
  const db = {
    message: {
      findUnique: async () => ({ id: "m1", conversationId: "c1", deletedAt: null }),
      findUniqueOrThrow: async () => loaded,
    },
    conversationMember: {
      findFirst: async () => (options.member ? { userId: "u1" } : null),
      findMany: async () => [{ userId: "u1" }, { userId: "u2" }],
    },
    messagePin: {
      upsert: async (args: { create: unknown; update: unknown }) => {
        calls.upserts.push(args);
        return args.create;
      },
      deleteMany: async (args: unknown) => {
        calls.deletes.push(args);
        return { count: 1 };
      },
    },
  } as unknown as PrismaClient;
  const hub = {
    publishToUsers: (userIds: string[], event: unknown) => calls.published.push({ userIds: [...userIds], event }),
  } as unknown as ConversationDeps["hub"];
  return { deps: { db, hub, mediaUrl } as unknown as ConversationDeps, calls };
}

describe("setMessagePinned", () => {
  it("pins for everyone and fans the change out to all members", async () => {
    const { deps, calls } = pinDeps({ member: true });
    const message = await setMessagePinned(deps, "u1", "m1", true);
    expect(message.pinned?.userId).toBe("u1");
    expect(calls.upserts).toEqual([
      {
        where: { messageId: "m1" },
        create: { messageId: "m1", pinnedById: "u1" },
        // Empty update: the first pin keeps its author and timestamp.
        update: {},
      },
    ]);
    expect(calls.published).toHaveLength(1);
    expect(calls.published[0]?.userIds).toEqual(["u1", "u2"]);
    expect(calls.published[0]?.event).toMatchObject({ type: "message.pin", messageId: "m1" });
  });

  it("unpins by removing the row and broadcasting a null pin", async () => {
    const { deps, calls } = pinDeps({ member: true, pinned: false });
    const message = await setMessagePinned(deps, "u1", "m1", false);
    expect(message.pinned).toBeNull();
    expect(calls.deletes).toEqual([{ where: { messageId: "m1" } }]);
    expect(calls.published[0]?.event).toMatchObject({ type: "message.pin", pin: null });
  });

  it("refuses people who are not in the chat", async () => {
    const { deps, calls } = pinDeps({ member: false });
    await expect(setMessagePinned(deps, "u9", "m1", true)).rejects.toThrow();
    expect(calls.upserts).toHaveLength(0);
    expect(calls.published).toHaveLength(0);
  });
});

describe("listPinned", () => {
  function pinnedDeps(rows: { id: string; pinnedAt: Date; body: string }[]) {
    const db = {
      conversationMember: { findFirst: async () => ({ userId: "u1", clearedAt: null }) },
      messagePin: {
        findMany: async ({ take }: { take: number }) =>
          rows.slice(0, take).map((row) => ({
            id: row.id,
            pinnedById: "u1",
            pinnedAt: row.pinnedAt,
            message: messageRow({ id: row.id, body: row.body, pin: { pinnedById: "u1", pinnedAt: row.pinnedAt, user: { displayName: "Sam Ali" } } }),
          })),
      },
    } as unknown as PrismaClient;
    return { db, mediaUrl } as unknown as ConversationDeps;
  }

  it("pages by pin recency and hands back the oldest pin as the cursor", async () => {
    const deps = pinnedDeps([
      { id: "p1", pinnedAt: new Date(NOW.getTime() + 2000), body: "newest" },
      { id: "p2", pinnedAt: new Date(NOW.getTime() + 1000), body: "second" },
      { id: "p3", pinnedAt: NOW, body: "third" },
    ]);
    const page = await listPinned(deps, "u1", "c1", { limit: 2 });
    expect(page.pins.map((pin) => pin.message.body)).toEqual(["newest", "second"]);
    expect(page.pins[0]?.pin.pinnedAt).toBe(new Date(NOW.getTime() + 2000).toISOString());
    expect(page.nextCursor).toBe("p3");
  });

  it("stops paging once the page is not overfull", async () => {
    const deps = pinnedDeps([{ id: "p1", pinnedAt: NOW, body: "only" }]);
    const page = await listPinned(deps, "u1", "c1", { limit: 2 });
    expect(page.pins).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
  });
});
