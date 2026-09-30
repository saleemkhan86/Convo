import { messageSchema } from "@convo/shared";
import { describe, expect, it } from "vitest";
import { serializeMessage } from "../src/services/conversations";

type Row = Parameters<typeof serializeMessage>[0];
type ReactionRow = Row["reactions"][number];
type ReceiptRow = Row["receipts"][number];
type StarRow = Row["starredBy"][number];
type AttachmentRow = Row["attachments"][number];

const created = new Date("2026-09-29T10:00:00.000Z");
const mediaUrl = (key: string) => `https://cdn.test/${key}`;

/** A row shaped like the `messageInclude` read, with every relation empty. */
function row(overrides: Partial<Row> = {}): Row {
  return {
    id: "m1",
    conversationId: "c1",
    senderId: "u1",
    clientMessageId: "cm1",
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
    ...overrides,
  } as Row;
}

const reaction = (userId: string, emoji: string): ReactionRow =>
  ({ id: `${userId}${emoji}`, messageId: "m1", userId, emoji, createdAt: created }) as ReactionRow;

const receipt = (userId: string, deliveredAt: Date | null, readAt: Date | null): ReceiptRow =>
  ({ id: `r-${userId}`, messageId: "m1", userId, deliveredAt, readAt }) as ReceiptRow;

const star = (userId: string): StarRow =>
  ({ id: `s-${userId}`, messageId: "m1", userId, createdAt: created }) as StarRow;

const attachment = (overrides: Partial<AttachmentRow> = {}): AttachmentRow =>
  ({
    id: "a1",
    messageId: "m1",
    kind: "IMAGE",
    mimeType: "image/jpeg",
    sizeBytes: 1234n,
    storageKey: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jpg",
    fileName: "photo.jpg",
    width: 1080,
    height: 1920,
    durationMs: null,
    createdAt: created,
    ...overrides,
  }) as AttachmentRow;

describe("serializeMessage star + receipt state", () => {
  it("marks a star only for the viewer who starred it", () => {
    const starred = row({ starredBy: [star("u1")] });
    expect(serializeMessage(starred, "u1", mediaUrl).starredByMe).toBe(true);
    expect(serializeMessage(starred, "u2", mediaUrl).starredByMe).toBe(false);
    expect(serializeMessage(row(), "u1", mediaUrl).starredByMe).toBe(false);
  });

  it("walks the tick forward only for the caller's own messages", () => {
    expect(
      serializeMessage(row({ receipts: [receipt("u2", null, null)] }), "u1", mediaUrl).deliveryStatus,
    ).toBe("SENT");
    expect(
      serializeMessage(row({ receipts: [receipt("u2", created, null)] }), "u1", mediaUrl)
        .deliveryStatus,
    ).toBe("DELIVERED");
    expect(
      serializeMessage(row({ receipts: [receipt("u2", created, created)] }), "u1", mediaUrl)
        .deliveryStatus,
    ).toBe("READ");
    // A read receipt on someone else's message never shows a tick.
    const theirs = row({ senderId: "u2", receipts: [receipt("u1", created, created)] });
    expect(serializeMessage(theirs, "u1", mediaUrl).deliveryStatus).toBeNull();
  });

  it("collapses per-user reactions into tallies with a viewer flag", () => {
    const merged = row({ reactions: [reaction("u2", "👍"), reaction("u3", "👍"), reaction("u1", "❤️")] });
    expect(serializeMessage(merged, "u1", mediaUrl).reactions).toEqual([
      { emoji: "👍", count: 2, reactedByMe: false },
      { emoji: "❤️", count: 1, reactedByMe: true },
    ]);
  });

  it("keeps deleted and edited markers as ISO strings", () => {
    const payload = serializeMessage(
      row({ editedAt: created, deletedAt: created, replyToId: "m0" }),
      "u1",
      mediaUrl,
    );
    expect(payload.editedAt).toBe(created.toISOString());
    expect(payload.deletedAt).toBe(created.toISOString());
    expect(payload.createdAt).toBe(created.toISOString());
    expect(payload.replyToId).toBe("m0");
  });

  it("produces a payload the shared contract accepts", () => {
    expect(messageSchema.parse(serializeMessage(row(), "u1", mediaUrl)).starredByMe).toBe(false);
  });

  it("marks a status reply with its status id (Phase 5D)", () => {
    expect(serializeMessage(row(), "u1", mediaUrl).statusReply).toBeNull();
    expect(serializeMessage(row({ statusReplyId: "s1" }), "u1", mediaUrl).statusReply).toEqual({
      statusId: "s1",
    });
  });
});

describe("serializeMessage media (Phase 5B)", () => {
  it("signs a URL per attachment and reports the stored size", () => {
    const media = serializeMessage(
      row({ type: "IMAGE", attachments: [attachment()] }),
      "u1",
      mediaUrl,
    );
    expect(media.attachments).toHaveLength(1);
    expect(media.attachments[0]).toMatchObject({
      id: "a1",
      kind: "IMAGE",
      sizeBytes: 1234,
      mediaUrl: "https://cdn.test/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jpg",
    });
  });

  it("keeps view-once media URL-less for everyone until it is opened", () => {
    const sent = row({ type: "IMAGE", viewOnce: true, attachments: [attachment()] });
    expect(serializeMessage(sent, "u2", mediaUrl).attachments[0]?.mediaUrl).toBeNull();
    expect(serializeMessage(sent, "u2", mediaUrl).viewOnceOpened).toBe(false);
  });

  it("flags the viewer who already burned their single view", () => {
    const viewed = row({
      type: "IMAGE",
      viewOnce: true,
      attachments: [attachment()],
      viewOnceViews: [{ userId: "u2" }],
    });
    expect(serializeMessage(viewed, "u2", mediaUrl).viewOnceOpened).toBe(true);
    expect(serializeMessage(viewed, "u1", mediaUrl).viewOnceOpened).toBe(false);
  });

  it("carries the forwarded-from label", () => {
    const forwarded = row({ forwardedFrom: { id: "u3", displayName: "Sam" } });
    expect(serializeMessage(forwarded, "u1", mediaUrl).forwardedFrom).toEqual({
      userId: "u3",
      displayName: "Sam",
    });
  });

  it("rebuilds the reply quote from its snapshot, so it survives deletion", () => {
    const reply = row({
      replyToId: "m0",
      replyPreview: {
        messageId: "m0",
        senderId: "u2",
        senderName: "Sam",
        type: "IMAGE",
        body: null,
        kind: "IMAGE",
        storageKey: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff.jpg",
        fileName: "map.jpg",
      },
    });
    expect(serializeMessage(reply, "u1", mediaUrl).replyPreview).toMatchObject({
      senderName: "Sam",
      kind: "IMAGE",
      fileName: "map.jpg",
      mediaUrl: "https://cdn.test/bbbbbbbb-cccc-dddd-eeee-ffffffffffff.jpg",
    });
  });

  it("gives a view-once quote no URL either", () => {
    const reply = row({
      replyPreview: {
        messageId: "m0",
        senderId: "u2",
        senderName: "Sam",
        type: "IMAGE",
        body: null,
        kind: "IMAGE",
        storageKey: null,
        fileName: null,
      },
    });
    expect(serializeMessage(reply, "u1", mediaUrl).replyPreview?.mediaUrl).toBeNull();
  });

  it("produces a media payload the shared contract accepts", () => {
    const parsed = messageSchema.parse(
      serializeMessage(row({ type: "IMAGE", attachments: [attachment()] }), "u1", mediaUrl),
    );
    expect(parsed.attachments[0]?.kind).toBe("IMAGE");
    expect(parsed.viewOnce).toBe(false);
  });
});
