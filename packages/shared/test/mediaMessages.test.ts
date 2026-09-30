import { describe, expect, it } from "vitest";
import {
  attachmentInputSchema,
  attachmentSchema,
  forwardMessagesRequestSchema,
  listSharedMediaQuerySchema,
  messageSchema,
  sendMessageRequestSchema,
  viewOnceOpenResultSchema,
  wsServerEventSchema,
} from "../src/chats";

const KEY = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jpg";

const attachmentBase = {
  id: "a1",
  kind: "IMAGE",
  mimeType: "image/jpeg",
  fileName: "photo.jpg",
  sizeBytes: 1234,
  width: 1080,
  height: 1920,
  durationMs: null,
  mediaUrl: "https://cdn.test/photo.jpg",
};

describe("attachmentInputSchema (client → server)", () => {
  it("accepts a storage key with optional metadata", () => {
    expect(attachmentInputSchema.parse({ storageKey: KEY })).toEqual({ storageKey: KEY });
  });

  it("rejects keys that are not stored-object names", () => {
    expect(attachmentInputSchema.safeParse({ storageKey: "photo.jpg" }).success).toBe(false);
    expect(attachmentInputSchema.safeParse({ storageKey: `${KEY}/../../etc/passwd` }).success).toBe(
      false,
    );
  });

  it("strips path separators from a display name and keeps its tail", () => {
    const parsed = attachmentInputSchema.parse({
      storageKey: KEY,
      fileName: "  C:\\Users\\me\\Holiday.jpg  ",
    });
    expect(parsed.fileName).toBe("C:UsersmeHoliday.jpg");
    expect(attachmentInputSchema.parse({ storageKey: KEY, fileName: "x".repeat(200) }).fileName)
      .toHaveLength(160);
    expect(attachmentInputSchema.safeParse({ storageKey: KEY, fileName: "x".repeat(300) }).success)
      .toBe(false);
  });

  it("bounds image dimensions and clip length", () => {
    expect(attachmentInputSchema.safeParse({ storageKey: KEY, width: 30001 }).success).toBe(false);
    expect(attachmentInputSchema.safeParse({ storageKey: KEY, height: -1 }).success).toBe(false);
    expect(
      attachmentInputSchema.safeParse({ storageKey: KEY, durationMs: 25 * 60 * 60 * 1000 }).success,
    ).toBe(false);
  });
});

describe("sendMessageRequestSchema with media", () => {
  const base = { clientMessageId: "3f2b7a1e-8a3d-4f1c-9b2e-6d5c4a3b2a19" };

  it("accepts text-only, media-only, and both together", () => {
    expect(sendMessageRequestSchema.parse({ ...base, body: "hi" }).body).toBe("hi");
    expect(sendMessageRequestSchema.parse({ ...base, attachments: [{ storageKey: KEY }] }).attachments)
      .toHaveLength(1);
    expect(
      sendMessageRequestSchema.parse({ ...base, body: "look", attachments: [{ storageKey: KEY }] }),
    ).toMatchObject({ body: "look" });
  });

  it("rejects an empty message and an empty attachment list", () => {
    expect(sendMessageRequestSchema.safeParse(base).success).toBe(false);
    expect(sendMessageRequestSchema.safeParse({ ...base, attachments: [] }).success).toBe(false);
  });

  it("requires media before a message can be view-once", () => {
    expect(sendMessageRequestSchema.safeParse({ ...base, body: "hi", viewOnce: true }).success).toBe(
      false,
    );
    expect(
      sendMessageRequestSchema.parse({ ...base, viewOnce: true, attachments: [{ storageKey: KEY }] })
        .viewOnce,
    ).toBe(true);
  });

  it("defaults viewOnce off and caps a batch at ten attachments", () => {
    expect(sendMessageRequestSchema.parse({ ...base, body: "hi" }).viewOnce).toBe(false);
    const eleven = Array.from({ length: 11 }, () => ({ storageKey: KEY }));
    expect(sendMessageRequestSchema.safeParse({ ...base, attachments: eleven }).success).toBe(false);
  });
});

describe("forwardMessagesRequestSchema", () => {
  it("needs at least one message and one destination chat", () => {
    expect(forwardMessagesRequestSchema.safeParse({ messageIds: ["m1"], conversationIds: [] }).success)
      .toBe(false);
    expect(forwardMessagesRequestSchema.safeParse({ messageIds: [], conversationIds: ["c1"] }).success)
      .toBe(false);
  });

  it("caps both lists at twenty", () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `id${i}`);
    expect(forwardMessagesRequestSchema.safeParse({ messageIds: twenty, conversationIds: twenty }).success)
      .toBe(true);
    expect(
      forwardMessagesRequestSchema.safeParse({
        messageIds: [...twenty, "extra"],
        conversationIds: twenty,
      }).success,
    ).toBe(false);
  });
});

describe("listSharedMediaQuerySchema", () => {
  it("defaults to the whole grid and accepts one kind", () => {
    expect(listSharedMediaQuerySchema.parse({}).kind).toBe("ALL");
    expect(listSharedMediaQuerySchema.parse({ kind: "VIDEO" }).kind).toBe("VIDEO");
  });

  it("rejects kinds that are not attachment buckets", () => {
    expect(listSharedMediaQuerySchema.safeParse({ kind: "LINK" }).success).toBe(false);
    expect(listSharedMediaQuerySchema.safeParse({ kind: "OTHER" }).success).toBe(false);
  });

  it("coerces a cursor page size from a query string", () => {
    expect(listSharedMediaQuerySchema.parse({ limit: "60" }).limit).toBe(60);
    expect(listSharedMediaQuerySchema.parse({}).limit).toBe(50);
    expect(listSharedMediaQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
  });
});

describe("message media fields", () => {
  const base = {
    id: "m1",
    conversationId: "c1",
    senderId: "u1",
    clientMessageId: "cm1",
    type: "IMAGE",
    body: null,
    replyToId: null,
    editedAt: null,
    deletedAt: null,
    reactions: [],
    createdAt: "2026-09-30T10:00:00.000Z",
  };

  it("defaults every 5B field for old payloads", () => {
    const parsed = messageSchema.parse(base);
    expect(parsed.attachments).toEqual([]);
    expect(parsed.viewOnce).toBe(false);
    expect(parsed.viewOnceOpened).toBe(false);
    expect(parsed.forwardedFrom).toBeNull();
    expect(parsed.replyPreview).toBeNull();
  });

  it("allows a URL-less view-once attachment the viewer has not opened", () => {
    const parsed = messageSchema.parse({
      ...base,
      viewOnce: true,
      attachments: [{ ...attachmentBase, mediaUrl: null }],
    });
    expect(parsed.attachments[0]?.mediaUrl).toBeNull();
    expect(parsed.viewOnceOpened).toBe(false);
  });

  it("reports a forward and its reply quote snapshot", () => {
    const parsed = messageSchema.parse({
      ...base,
      forwardedFrom: { userId: "u3", displayName: "Sam" },
      replyPreview: {
        messageId: "m0",
        senderId: "u2",
        senderName: "Sam",
        type: "TEXT",
        body: "original",
        kind: null,
        fileName: null,
        mediaUrl: null,
      },
    });
    expect(parsed.forwardedFrom?.userId).toBe("u3");
    expect(parsed.replyPreview?.body).toBe("original");
  });

  it("rejects an attachment without a kind or size", () => {
    const { kind: _kind, sizeBytes: _size, ...rest } = attachmentBase;
    expect(viewOnceOpenResultSchema.safeParse({ attachments: [rest] }).success).toBe(false);
    expect(attachmentSchema.parse(attachmentBase).sizeBytes).toBe(1234);
  });
});

describe("message.viewOnceOpened socket event", () => {
  it("parses the privacy signal with an ISO timestamp", () => {
    const event = {
      type: "message.viewOnceOpened",
      conversationId: "c1",
      messageId: "m1",
      userId: "u2",
      viewedAt: "2026-09-30T10:00:00.000Z",
    };
    expect(wsServerEventSchema.parse(event)).toEqual(event);
  });

  it("needs to say who opened it", () => {
    expect(
      wsServerEventSchema.safeParse({
        type: "message.viewOnceOpened",
        conversationId: "c1",
        messageId: "m1",
        viewedAt: "2026-09-30T10:00:00.000Z",
      }).success,
    ).toBe(false);
  });
});
