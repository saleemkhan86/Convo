import { describe, expect, it } from "vitest";
import {
  chatLinkListSchema,
  chatPinListSchema,
  conversationSummarySchema,
  messageSchema,
  wsServerEventSchema,
} from "../src/chats";
import {
  createGroupRequestSchema,
  groupDetailSchema,
  groupSettingsSchema,
  updateGroupRequestSchema,
} from "../src/groups";

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
  createdAt: "2026-09-29T10:00:00.000Z",
};

const summaryBase = {
  id: "c1",
  type: "DIRECT",
  title: null,
  avatarUrl: null,
  peer: null,
  group: null,
  lastMessage: null,
  unreadCount: 0,
  pinned: false,
  archived: false,
  mutedUntil: null,
  lastReadAt: null,
  lastMessageAt: null,
};

describe("messageSchema 5E fields", () => {
  it("defaults mentions and pins so pre-5E payloads still parse", () => {
    const parsed = messageSchema.parse(messageBase);
    expect(parsed.mentions).toEqual([]);
    expect(parsed.mentionedMe).toBe(false);
    expect(parsed.pinned).toBeNull();
  });

  it("carries server-resolved mention ids and the shared pin", () => {
    const parsed = messageSchema.parse({
      ...messageBase,
      mentions: ["u2", "u3"],
      mentionedMe: true,
      pinned: { userId: "u2", displayName: "Sam Ali", pinnedAt: "2026-09-29T10:05:00.000Z" },
    });
    expect(parsed.mentions).toEqual(["u2", "u3"]);
    expect(parsed.pinned?.pinnedAt).toBe("2026-09-29T10:05:00.000Z");
  });

  it("rejects a pin without a timestamp", () => {
    expect(
      messageSchema.safeParse({ ...messageBase, pinned: { userId: "u2", displayName: null } }).success,
    ).toBe(false);
  });
});

describe("conversationSummarySchema unread mentions", () => {
  it("defaults the badge count to zero", () => {
    expect(conversationSummarySchema.parse(summaryBase).unreadMentions).toBe(0);
  });

  it("keeps a positive count", () => {
    expect(conversationSummarySchema.parse({ ...summaryBase, unreadMentions: 3 }).unreadMentions).toBe(3);
  });

  it("refuses a negative count", () => {
    expect(conversationSummarySchema.safeParse({ ...summaryBase, unreadMentions: -1 }).success).toBe(false);
  });
});

describe("chat pin and link list contracts", () => {
  it("parses a page of pinned messages with their pin metadata", () => {
    const parsed = chatPinListSchema.parse({
      pins: [{ message: messageBase, pin: { userId: "u1", displayName: null, pinnedAt: "2026-09-29T10:05:00.000Z" } }],
      nextCursor: null,
    });
    expect(parsed.pins[0]?.message.pinned).toBeNull();
    expect(parsed.pins[0]?.pin.userId).toBe("u1");
  });

  it("parses the links tab, including cards without a title", () => {
    const parsed = chatLinkListSchema.parse({
      links: [
        {
          messageId: "m1",
          conversationId: "c1",
          senderId: "u1",
          senderDisplayName: null,
          url: "https://example.test/a",
          title: null,
          description: null,
          image: null,
          siteName: "example.test",
          createdAt: "2026-09-29T10:00:00.000Z",
        },
      ],
      nextCursor: "m1",
    });
    expect(parsed.links[0]?.siteName).toBe("example.test");
    expect(parsed.nextCursor).toBe("m1");
  });

  it("requires a url on every link card", () => {
    expect(
      chatLinkListSchema.safeParse({
        links: [
          {
            messageId: "m1",
            conversationId: "c1",
            senderId: null,
            senderDisplayName: null,
            title: null,
            description: null,
            image: null,
            siteName: null,
            createdAt: "2026-09-29T10:00:00.000Z",
          },
        ],
        nextCursor: null,
      }).success,
    ).toBe(false);
  });
});

describe("message.pin websocket event", () => {
  it("accepts a pin and an unpin", () => {
    const pinned = wsServerEventSchema.safeParse({
      type: "message.pin",
      conversationId: "c1",
      messageId: "m1",
      pin: { userId: "u1", displayName: "Sam Ali", pinnedAt: "2026-09-29T10:05:00.000Z" },
    });
    expect(pinned.success).toBe(true);
    const unpinned = wsServerEventSchema.safeParse({
      type: "message.pin",
      conversationId: "c1",
      messageId: "m1",
      pin: null,
    });
    expect(unpinned.success).toBe(true);
  });

  it("requires the pin key, so a client cannot send a partial event", () => {
    expect(
      wsServerEventSchema.safeParse({ type: "message.pin", conversationId: "c1", messageId: "m1" }).success,
    ).toBe(false);
  });
});

describe("group settings and icon contracts", () => {
  const settingsBase = {
    visibility: "PRIVATE",
    whoCanSend: "ALL",
    whoCanEdit: "ALL",
    announceOnly: false,
    requireApproval: true,
  };

  it("defaults invitation rights to everyone", () => {
    expect(groupSettingsSchema.parse(settingsBase).whoCanInvite).toBe("ALL");
    expect(groupSettingsSchema.parse({ ...settingsBase, whoCanInvite: "ADMINS" }).whoCanInvite).toBe("ADMINS");
  });

  it("rejects an unknown invitation audience", () => {
    expect(groupSettingsSchema.safeParse({ ...settingsBase, whoCanInvite: "OWNER" }).success).toBe(false);
  });

  it("lets a settings patch change only the invitation rule", () => {
    const parsed = groupSettingsSchema.partial().parse({ whoCanInvite: "ADMINS" });
    expect(parsed.whoCanInvite).toBe("ADMINS");
    expect(parsed.visibility).toBeUndefined();
  });

  it("accepts an uploaded icon key and clears it with null", () => {
    const key = "3f2a6b1e-9d4c-4a77-8f31-2b6d0d1c55aa";
    expect(updateGroupRequestSchema.parse({ avatarStorageKey: key }).avatarStorageKey).toBe(key);
    expect(updateGroupRequestSchema.parse({ avatarStorageKey: null }).avatarStorageKey).toBeNull();
  });

  it("refuses a non-uuid storage key", () => {
    expect(updateGroupRequestSchema.safeParse({ avatarStorageKey: "not-a-key" }).success).toBe(false);
  });

  it("bounds the group description on create and patch", () => {
    expect(createGroupRequestSchema.parse({ name: "Crew", about: "Two nights" }).about).toBe("Two nights");
    expect(createGroupRequestSchema.safeParse({ name: "Crew", about: "x".repeat(201) }).success).toBe(false);
    expect(updateGroupRequestSchema.parse({ about: null }).about).toBeNull();
  });

  it("parses a group detail carrying the icon and invitation rule", () => {
    const detail = groupDetailSchema.parse({
      conversationId: "g1",
      name: "Crew",
      avatarUrl: "https://cdn.test/key",
      about: "Two nights",
      memberCount: 2,
      settings: { ...settingsBase, whoCanInvite: "ADMINS" },
      myRole: "ADMIN",
      inviteCode: "abcdef12",
      createdAt: "2026-09-29T10:00:00.000Z",
      members: [],
      joinRequests: [],
    });
    expect(detail.settings.whoCanInvite).toBe("ADMINS");
    expect(detail.avatarUrl).toBe("https://cdn.test/key");
  });
});
