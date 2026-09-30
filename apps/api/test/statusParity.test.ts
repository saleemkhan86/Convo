import type { PrismaClient } from "@prisma/client";
import {
  createStatusRequestSchema,
  messageSchema,
  replyToStatusRequestSchema,
  statusItemSchema,
  statusMuteListSchema,
} from "@convo/shared";
import { describe, expect, it } from "vitest";
import {
  createStatus,
  listStatusMutes,
  listStatuses,
  markStatusViewed,
  muteStatusAuthor,
  replyToStatus,
  type StatusDeps,
} from "../src/services/statuses";

/**
 * Phase 5D unit coverage for the status-parity rules that need no database:
 * mute filtering in the feed and on the live push, the read-receipt promise,
 * the reply guards, and the shared contracts both clients parse.
 */

const NOW = new Date();
const FUTURE = new Date(NOW.getTime() + 3600_000);
const PAST = new Date(NOW.getTime() - 3600_000);
const CLIENT_ID = "3f2a6b1e-9d4c-4a77-8f31-2b6d0d1c55aa";

interface FakeRow {
  id: string;
  authorId: string;
  kind: string;
  text: string | null;
  storageKey: string | null;
  mimeType: string | null;
  visibility: string;
  audience: string[];
  excluded: string[];
  shareReadReceipts: boolean;
  createdAt: Date;
  expiresAt: Date;
  views: { userId: string }[];
  author: { id: string; displayName: string | null; avatarUrl: string | null; status: string };
}

function status(overrides: Partial<FakeRow> = {}): FakeRow {
  const authorId = overrides.authorId ?? "author1";
  return {
    id: "s1",
    authorId,
    kind: "TEXT",
    text: "hello",
    storageKey: null,
    mimeType: null,
    visibility: "EVERYONE",
    audience: [],
    excluded: [],
    shareReadReceipts: true,
    createdAt: NOW,
    expiresAt: FUTURE,
    views: [],
    author: { id: authorId, displayName: "Author", avatarUrl: null, status: "ACTIVE" },
    ...overrides,
  };
}

/** The `statusSelect` shape the feed reads: counts plus the viewer's own view row. */
function shaped(row: FakeRow) {
  return { ...row, _count: { views: row.views.length } };
}

interface FakeOptions {
  statuses?: FakeRow[];
  contacts?: { ownerId: string; convoUserId: string | null }[];
  mutes?: { userId: string; authorId: string }[];
  users?: { id: string; status: string }[];
  existingView?: boolean;
}

function build(options: FakeOptions) {
  const rows = options.statuses ?? [];
  const mutes = options.mutes ?? [];
  const calls = {
    viewCreates: [] as { statusId: string; userId: string }[],
    published: [] as { userIds: string[]; event: unknown }[],
    muteWrites: [] as { userId: string; authorId: string }[],
  };

  const byId = (id: string) => rows.find((s) => s.id === id) ?? null;

  const db = {
    status: {
      create: async ({ data }: { data: Record<string, any> }) =>
        shaped(
          status({
            id: "posted",
            authorId: data.authorId,
            kind: data.kind,
            text: data.text,
            visibility: data.visibility,
            audience: data.audience,
            excluded: data.excluded,
            shareReadReceipts: data.shareReadReceipts,
          }),
        ),
      findMany: async ({ where }: { where: Record<string, any> }) => {
        const authorId = where.authorId;
        const window = where.expiresAt ?? {};
        return rows
          .filter((s) => {
            if (typeof authorId === "string" && s.authorId !== authorId) return false;
            if (authorId?.not !== undefined && s.authorId === authorId.not) return false;
            if (window.lt && !(s.expiresAt < window.lt)) return false;
            if (window.gte && !(s.expiresAt >= window.gte)) return false;
            if (where.author?.status && s.author.status !== where.author.status) return false;
            return true;
          })
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .map(shaped);
      },
      findUnique: async ({ where }: { where: { id: string } }) => {
        const row = byId(where.id);
        return row ? shaped(row) : null;
      },
      deleteMany: async () => ({ count: 0 }),
    },
    contact: {
      findMany: async ({ where }: { where: Record<string, any> }) => {
        const all = options.contacts ?? [];
        if (where.OR) {
          const [byOwner, byConvo] = where.OR as [{ ownerId: string }, { convoUserId: string }];
          return all
            .filter((c) => c.ownerId === byOwner.ownerId || c.convoUserId === byConvo.convoUserId)
            .map((c) => ({ ownerId: c.ownerId, convoUserId: c.convoUserId }));
        }
        return all
          .filter((c) => c.ownerId === where.ownerId && c.convoUserId !== where.convoUserId?.not)
          .map((c) => ({ convoUserId: c.convoUserId }));
      },
    },
    statusView: {
      findUnique: async () => (options.existingView ? { userId: "viewer" } : null),
      findMany: async () => [],
      create: async ({ data }: { data: { statusId: string; userId: string } }) => {
        calls.viewCreates.push(data);
        return { ...data, viewedAt: NOW, user: { id: data.userId, displayName: "Viewer", avatarUrl: null } };
      },
    },
    statusMute: {
      findMany: async ({ where, include }: { where: Record<string, any>; include?: { author?: unknown } }) => {
        if (where.authorId !== undefined) {
          const online: string[] = where.userId?.in ?? [];
          return mutes
            .filter((m) => m.authorId === where.authorId && online.includes(m.userId))
            .map((m) => ({ userId: m.userId }));
        }
        if (include?.author) {
          return mutes
            .filter((m) => m.userId === where.userId)
            .map((m) => ({
              createdAt: NOW,
              author: { id: m.authorId, displayName: "Author", avatarUrl: null },
            }));
        }
        return mutes.filter((m) => m.userId === where.userId).map((m) => ({ authorId: m.authorId }));
      },
      upsert: async ({ create }: { create: { userId: string; authorId: string } }) => {
        calls.muteWrites.push(create);
        return create;
      },
      deleteMany: async () => ({ count: 1 }),
    },
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const found = (options.users ?? []).find((u) => u.id === where.id);
        return found ? { id: found.id, status: found.status } : null;
      },
      findMany: async () => (options.users ?? []).map((u) => ({ id: u.id })),
    },
  };

  const hub = {
    isOnline: () => true,
    publishToUsers: (userIds: string[], event: unknown) => calls.published.push({ userIds, event }),
  };

  return {
    deps: {
      db: db as unknown as PrismaClient,
      hub: hub as unknown as StatusDeps["hub"],
      mediaUrl: (key: string) => `https://cdn.test/${key}`,
    } as unknown as StatusDeps,
    calls,
  };
}

describe("status feed muting", () => {
  it("hides a muted author's statuses without touching the viewer's own", async () => {
    const { deps } = build({
      statuses: [
        status({ id: "s1", authorId: "author1" }),
        status({ id: "s2", authorId: "author2" }),
        status({ id: "mine", authorId: "viewer", text: "mine" }),
      ],
      mutes: [{ userId: "viewer", authorId: "author2" }],
    });
    const list = await listStatuses(deps, "viewer");
    expect(list.mine.map((s) => s.id)).toEqual(["mine"]);
    expect(list.others.map((s) => s.id)).toEqual(["s1"]);
  });

  it("shows every author again when nothing is muted", async () => {
    const { deps } = build({
      statuses: [
        status({ id: "s2", authorId: "author2", createdAt: new Date(NOW.getTime() + 1000) }),
        status({ id: "s1", authorId: "author1" }),
      ],
    });
    const list = await listStatuses(deps, "viewer");
    expect(list.others.map((s) => s.id)).toEqual(["s2", "s1"]);
  });

  it("keeps a muted author's new post out of the live push too", async () => {
    const { deps, calls } = build({ mutes: [{ userId: "viewer", authorId: "author1" }] });
    await createStatus(deps, "author1", {
      ...createStatusRequestSchema.parse({ kind: "TEXT", text: "hi", visibility: "CUSTOM", userIds: ["viewer"] }),
    });
    expect(calls.published).toHaveLength(0);
  });

  it("pushes a post to a viewer who has not muted the author", async () => {
    const { deps, calls } = build({ mutes: [] });
    await createStatus(deps, "author1", {
      ...createStatusRequestSchema.parse({ kind: "TEXT", text: "hi", visibility: "CUSTOM", userIds: ["viewer"] }),
    });
    expect(calls.published[0]?.userIds).toEqual(["viewer"]);
  });

  it("carries the receipts flag through to the client payload", async () => {
    const { deps } = build({
      statuses: [status({ id: "mine", authorId: "viewer", shareReadReceipts: false })],
    });
    const list = await listStatuses(deps, "viewer");
    expect(list.mine[0]?.shareReadReceipts).toBe(false);
    expect(statusItemSchema.parse(list.mine[0]).shareReadReceipts).toBe(false);
  });
});

describe("status read receipts", () => {
  it("records and publishes a view while receipts are on", async () => {
    const { deps, calls } = build({ statuses: [status({ id: "s1", authorId: "author1" })] });
    await expect(markStatusViewed(deps, "viewer", "s1")).resolves.toEqual({ ok: true });
    expect(calls.viewCreates).toEqual([{ statusId: "s1", userId: "viewer" }]);
    expect(calls.published[0]?.userIds).toEqual(["author1"]);
  });

  it("never records a view once the author turns receipts off", async () => {
    const { deps, calls } = build({
      statuses: [status({ id: "s1", authorId: "author1", shareReadReceipts: false })],
    });
    await expect(markStatusViewed(deps, "viewer", "s1")).resolves.toEqual({ ok: true });
    expect(calls.viewCreates).toHaveLength(0);
    expect(calls.published).toHaveLength(0);
  });

  it("does not record the author watching their own status", async () => {
    const { deps, calls } = build({ statuses: [status({ id: "s1", authorId: "author1" })] });
    await markStatusViewed(deps, "author1", "s1");
    expect(calls.viewCreates).toHaveLength(0);
  });

  it("leaves an existing view alone instead of double-counting", async () => {
    const { deps, calls } = build({
      statuses: [status({ id: "s1", authorId: "author1" })],
      existingView: true,
    });
    await markStatusViewed(deps, "viewer", "s1");
    expect(calls.viewCreates).toHaveLength(0);
  });
});

describe("status reply guards", () => {
  const reply = { clientMessageId: CLIENT_ID, body: "nice shot" };

  it("rejects an unknown status", async () => {
    const { deps } = build({ statuses: [] });
    await expect(replyToStatus(deps, "viewer", "missing", reply)).rejects.toThrow("Status not found");
  });

  it("rejects an expired status the same way, so expiry is not leaked", async () => {
    const { deps } = build({ statuses: [status({ id: "s1", authorId: "author1", expiresAt: PAST })] });
    const expired = await replyToStatus(deps, "viewer", "s1", reply).catch((e: Error) => e.message);
    const missing = await replyToStatus(deps, "viewer", "missing", reply).catch((e: Error) => e.message);
    expect(expired).toBe(missing);
  });

  it("refuses to answer your own status", async () => {
    const { deps } = build({ statuses: [status({ id: "s1", authorId: "viewer" })] });
    await expect(replyToStatus(deps, "viewer", "s1", reply)).rejects.toThrow(
      "You cannot reply to your own status",
    );
  });

  it("hides a status you were never in the audience for", async () => {
    const { deps } = build({
      statuses: [
        status({ id: "s1", authorId: "author1", visibility: "CUSTOM", audience: ["someoneelse"] }),
      ],
    });
    await expect(replyToStatus(deps, "viewer", "s1", reply)).rejects.toThrow("Status not found");
  });

  it("lets a saved contact answer their contacts-only status", async () => {
    const { deps } = build({
      statuses: [status({ id: "s1", authorId: "author1", visibility: "CONTACTS" })],
      contacts: [{ ownerId: "author1", convoUserId: "viewer" }],
    });
    // Passing the audience check means reaching the chat-open step, which the
    // fake has no tables for; the failure is about chats, not about the status.
    const message = await replyToStatus(deps, "viewer", "s1", reply).catch((e: Error) => e.message);
    expect(message).not.toBe("Status not found");
  });
});

describe("muting an author", () => {
  it("refuses to mute yourself", async () => {
    const { deps, calls } = build({ users: [{ id: "viewer", status: "ACTIVE" }] });
    await expect(muteStatusAuthor(deps, "viewer", "viewer")).rejects.toThrow(
      "You cannot mute your own statuses",
    );
    expect(calls.muteWrites).toHaveLength(0);
  });

  it("mutes an active account and nothing else", async () => {
    const { deps, calls } = build({ users: [{ id: "author1", status: "BLOCKED" }] });
    await expect(muteStatusAuthor(deps, "viewer", "author1")).rejects.toThrow("Status not found");
    expect(calls.muteWrites).toHaveLength(0);

    const { deps: ok, calls: okCalls } = build({ users: [{ id: "author1", status: "ACTIVE" }] });
    await expect(muteStatusAuthor(ok, "viewer", "author1")).resolves.toEqual({ ok: true });
    expect(okCalls.muteWrites).toEqual([{ userId: "viewer", authorId: "author1" }]);
  });

  it("lists mutes as the author, for the settings sheet", async () => {
    const { deps } = build({ mutes: [{ userId: "viewer", authorId: "author2" }] });
    const list = await listStatusMutes(deps, "viewer");
    expect(list).toEqual([
      { userId: "author2", displayName: "Author", avatarUrl: null, mutedAt: NOW.toISOString() },
    ]);
    expect(statusMuteListSchema.parse({ items: list }).items).toHaveLength(1);
  });
});

describe("5D shared contracts", () => {
  it("accepts a reply only with a client id and a trimmed body", () => {
    expect(replyToStatusRequestSchema.parse({ clientMessageId: CLIENT_ID, body: "  hi  " }).body).toBe("hi");
    expect(() => replyToStatusRequestSchema.parse({ clientMessageId: "nope", body: "hi" })).toThrow();
    expect(() => replyToStatusRequestSchema.parse({ clientMessageId: CLIENT_ID, body: "   " })).toThrow();
    expect(() =>
      replyToStatusRequestSchema.parse({ clientMessageId: CLIENT_ID, body: "x".repeat(4097) }),
    ).toThrow();
  });

  it("defaults receipts on for posts", () => {
    expect(
      createStatusRequestSchema.parse({ kind: "TEXT", text: "hi", visibility: "EVERYONE" }).shareReadReceipts,
    ).toBe(true);
    expect(
      createStatusRequestSchema.parse({
        kind: "TEXT",
        text: "hi",
        visibility: "EVERYONE",
        shareReadReceipts: false,
      }).shareReadReceipts,
    ).toBe(false);
  });

  it("gives a plain message a null status reply marker", () => {
    const parsed = messageSchema.parse({
      id: "m1",
      conversationId: "c1",
      senderId: "u1",
      type: "TEXT",
      body: "hi",
      clientMessageId: CLIENT_ID,
      replyToId: null,
      editedAt: null,
      deletedAt: null,
      createdAt: NOW.toISOString(),
      attachments: [],
      reactions: [],
      starredByMe: false,
      deliveryStatus: null,
    });
    expect(parsed.statusReply).toBeNull();
    expect(messageSchema.parse({ ...parsed, statusReply: { statusId: "s1" } }).statusReply).toEqual({
      statusId: "s1",
    });
  });
});
