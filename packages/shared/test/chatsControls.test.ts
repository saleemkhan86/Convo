import { describe, expect, it } from "vitest";
import {
  conversationSummarySchema,
  listConversationsQuerySchema,
  listMessagesQuerySchema,
  messageSchema,
  starMessageRequestSchema,
  starredMessageListSchema,
  updateConversationRequestSchema,
} from "../src/chats";

const messageBase = {
  id: "m1",
  conversationId: "c1",
  senderId: "u1",
  clientMessageId: "cm1",
  type: "TEXT",
  body: "hi",
  replyToId: null,
  editedAt: null,
  deletedAt: null,
  createdAt: new Date().toISOString(),
};

describe("updateConversationRequestSchema", () => {
  it("needs at least one control to change", () => {
    expect(updateConversationRequestSchema.safeParse({}).success).toBe(false);
    expect(updateConversationRequestSchema.safeParse({ pinned: false }).success).toBe(true);
  });

  it("accepts WhatsApp's mute presets and 0 for unmute", () => {
    for (const muteHours of [0, 8, 168, 8760]) {
      expect(updateConversationRequestSchema.parse({ muteHours }).muteHours).toBe(muteHours);
    }
  });

  it("rejects out-of-range or fractional mute windows", () => {
    expect(updateConversationRequestSchema.safeParse({ muteHours: -1 }).success).toBe(false);
    expect(updateConversationRequestSchema.safeParse({ muteHours: 8761 }).success).toBe(false);
    expect(updateConversationRequestSchema.safeParse({ muteHours: 8.5 }).success).toBe(false);
  });

  it("combines pin, archive and mute in one patch", () => {
    const parsed = updateConversationRequestSchema.parse({
      pinned: true,
      archived: false,
      muteHours: 8,
    });
    expect(parsed).toEqual({ pinned: true, archived: false, muteHours: 8 });
  });
});

describe("starMessageRequestSchema", () => {
  it("stars when the client sends no flag", () => {
    expect(starMessageRequestSchema.parse({}).starred).toBe(true);
    expect(starMessageRequestSchema.parse({ starred: false }).starred).toBe(false);
  });

  it("only accepts booleans", () => {
    expect(starMessageRequestSchema.safeParse({ starred: "true" }).success).toBe(false);
  });
});

describe("listConversationsQuerySchema", () => {
  it("reads the archive only for archived=true", () => {
    expect(listConversationsQuerySchema.parse({ archived: "true" }).archived).toBe(true);
    expect(listConversationsQuerySchema.parse({ archived: "false" }).archived).toBe(false);
    expect(listConversationsQuerySchema.parse({}).archived).toBeUndefined();
  });

  it("rejects other truthy spellings instead of guessing", () => {
    expect(listConversationsQuerySchema.safeParse({ archived: "yes" }).success).toBe(false);
  });

  it("keeps the shared cursor paging defaults", () => {
    expect(listConversationsQuerySchema.parse({}).limit).toBe(50);
    expect(listConversationsQuerySchema.parse({ limit: "25" }).limit).toBe(25);
    expect(listConversationsQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
  });
});

describe("listMessagesQuerySchema", () => {
  it("supports in-chat text search and the starred filter together", () => {
    const parsed = listMessagesQuerySchema.parse({ q: "  invoice  ", starred: "true" });
    expect(parsed.q).toBe("invoice");
    expect(parsed.starred).toBe(true);
  });

  it("ignores an empty query rather than matching everything", () => {
    expect(listMessagesQuerySchema.safeParse({ q: "   " }).success).toBe(false);
    expect(listMessagesQuerySchema.safeParse({ q: "x".repeat(101) }).success).toBe(false);
  });

  it("leaves both filters undefined for a plain history page", () => {
    const parsed = listMessagesQuerySchema.parse({ cursor: "abc" });
    expect(parsed.q).toBeUndefined();
    expect(parsed.starred).toBeUndefined();
    expect(parsed.cursor).toBe("abc");
  });
});

describe("messageSchema star state", () => {
  it("defaults starredByMe to false for payloads from before 5A", () => {
    expect(messageSchema.parse(messageBase).starredByMe).toBe(false);
  });

  it("keeps a per-viewer star and a reaction tally", () => {
    const parsed = messageSchema.parse({
      ...messageBase,
      starredByMe: true,
      reactions: [{ emoji: "👍", count: 2, reactedByMe: true }],
    });
    expect(parsed.starredByMe).toBe(true);
    expect(parsed.reactions[0]).toEqual({ emoji: "👍", count: 2, reactedByMe: true });
  });
});

describe("conversationSummarySchema control flags", () => {
  const summaryBase = {
    id: "c1",
    type: "DIRECT",
    title: null,
    avatarUrl: null,
    peer: null,
    lastMessage: null,
    unreadCount: 0,
    pinned: false,
    archived: false,
    mutedUntil: null,
    lastReadAt: null,
    lastMessageAt: null,
  };

  it("always reports the three per-viewer controls", () => {
    const parsed = conversationSummarySchema.parse(summaryBase);
    expect(parsed).toMatchObject({ pinned: false, archived: false, mutedUntil: null, group: null });
  });

  it("requires explicit flags so a stale client cannot hide an archive", () => {
    const { pinned, ...rest } = summaryBase;
    expect(conversationSummarySchema.safeParse(rest).success).toBe(false);
    expect(conversationSummarySchema.safeParse({ ...summaryBase, pinned: "true" }).success).toBe(
      false,
    );
    expect(pinned).toBe(false);
  });

  it("carries a mute deadline as an ISO timestamp", () => {
    const until = new Date(Date.now() + 8 * 3600_000).toISOString();
    expect(conversationSummarySchema.parse({ ...summaryBase, mutedUntil: until }).mutedUntil).toBe(
      until,
    );
    expect(conversationSummarySchema.safeParse({ ...summaryBase, mutedUntil: "8 hours" }).success).toBe(
      false,
    );
  });
});

describe("starredMessageListSchema", () => {
  it("groups each starred message with its chat", () => {
    const parsed = starredMessageListSchema.parse({
      items: [
        { message: messageBase, conversationId: "c1", conversationName: "Sam" },
        { message: messageBase, conversationId: "c2", conversationName: null },
      ],
      nextCursor: null,
    });
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0]?.message.starredByMe).toBe(false);
    expect(parsed.items[1]?.conversationName).toBeNull();
  });

  it("needs a cursor field so paging stays explicit", () => {
    expect(starredMessageListSchema.safeParse({ items: [] }).success).toBe(false);
  });
});
