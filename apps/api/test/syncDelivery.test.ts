import { describe, expect, it } from "vitest";
import { markDeviceDelivered, syncConversation } from "../src/services/delivery";
import type { PrismaClient } from "@prisma/client";

const created = new Date("2026-10-01T10:00:00.000Z");
const mediaUrl = (key: string) => `https://cdn.test/${key}`;

/** A message row shaped like the `syncConversation` include. */
function messageRow(sequenceNumber: number) {
  return {
    id: `m${sequenceNumber}`,
    conversationId: "c1",
    senderId: "u2",
    clientMessageId: `cm${sequenceNumber}`,
    sequenceNumber,
    type: "TEXT",
    body: "hi",
    replyToId: null,
    editedAt: null,
    deletedAt: null,
    viewOnce: false,
    createdAt: created,
    reactions: [],
    receipts: [],
    starredBy: [],
    attachments: [],
    forwardedFrom: null,
    viewOnceViews: [],
    mentions: [],
    pin: null,
    statusReplyId: null,
  };
}

interface Calls {
  cursorWrites: Array<{ deviceId: string; via: string }>;
}

/**
 * Device rows are keyed by a real registration, but `/sync` callers may present
 * a transient id. Writes must therefore be tolerant: an `update` on a missing
 * row throws P2025 and turns a working sync into a 500.
 */
function fakeDb(opts: { memberships: number; messages: ReturnType<typeof messageRow>[] }): {
  db: PrismaClient;
  calls: Calls;
} {
  const calls: Calls = { cursorWrites: [] };
  const db = {
    conversationMember: {
      findFirst: async () => (opts.memberships > 0 ? { id: "member1" } : null),
      findMany: async () => Array.from({ length: opts.memberships }, (_, i) => ({ conversationId: `c${i + 1}` })),
    },
    message: {
      findMany: async () => opts.messages,
    },
    device: {
      // Any use of `update` is the regression this file exists to catch.
      update: async () => {
        throw Object.assign(new Error("Record not found"), { code: "P2025" });
      },
      updateMany: async ({ where }: { where: { id: string } }) => {
        calls.cursorWrites.push({ deviceId: where.id, via: "updateMany" });
        return { count: 0 };
      },
    },
    deviceMessageDelivery: { updateMany: async () => ({ count: 0 }) },
    messageReceipt: { updateMany: async () => ({ count: 0 }) },
  } as unknown as PrismaClient;
  return { db, calls };
}

const svc = (db: PrismaClient) => ({ db, hub: undefined as never, mediaUrl });

describe("syncConversation device cursor", () => {
  it("returns missed messages for an unknown device instead of throwing", async () => {
    const { db, calls } = fakeDb({ memberships: 1, messages: [messageRow(4), messageRow(5)] });
    const result = await syncConversation(svc(db), "u1", "sync-1730000000000", "c1", 3);
    expect(result.messages.map((m) => m.id)).toEqual(["m4", "m5"]);
    expect(result.nextSequence).toBe(5);
    expect(calls.cursorWrites).toHaveLength(1);
  });

  it("leaves the cursor untouched when there is nothing new", async () => {
    const { db, calls } = fakeDb({ memberships: 1, messages: [] });
    const result = await syncConversation(svc(db), "u1", "sync-1", "c1", 9);
    expect(result.messages).toEqual([]);
    expect(result.nextSequence).toBe(9);
    expect(calls.cursorWrites).toEqual([]);
  });

  it("returns an empty page for a conversation the caller is not in", async () => {
    const { db } = fakeDb({ memberships: 0, messages: [messageRow(1)] });
    const result = await syncConversation(svc(db), "u1", "sync-1", "cX", null);
    expect(result).toEqual({ messages: [], nextSequence: null });
  });
});

describe("markDeviceDelivered", () => {
  it("tolerates a transient device id", async () => {
    const { db, calls } = fakeDb({ memberships: 1, messages: [] });
    await expect(markDeviceDelivered(svc(db), "m1", "u1", "device-1730000000000")).resolves.toBeUndefined();
    expect(calls.cursorWrites[0]?.via).toBe("updateMany");
  });
});
