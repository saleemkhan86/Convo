import { describe, expect, it } from "vitest";
import {
  createGroupRequestSchema,
  discoverGroupsQuerySchema,
  joinByCodeRequestSchema,
} from "../src/groups";
import {
  createStatusRequestSchema,
  createStatusRequestSchemaChecked,
  statusItemSchema,
} from "../src/statuses";

describe("createStatusRequestSchema", () => {
  it("defaults to a 24-hour public status", () => {
    const parsed = createStatusRequestSchema.parse({ kind: "TEXT", text: "hello" });
    expect(parsed.durationHours).toBe(24);
    expect(parsed.visibility).toBe("EVERYONE");
    expect(parsed.userIds).toEqual([]);
  });

  it("caps the lifetime at one week", () => {
    expect(() => createStatusRequestSchema.parse({ kind: "TEXT", text: "hi", durationHours: 169 })).toThrow();
    expect(createStatusRequestSchema.parse({ kind: "TEXT", text: "hi", durationHours: 168 }).durationHours).toBe(168);
  });

  it("requires text for text and URL statuses", () => {
    expect(createStatusRequestSchemaChecked.safeParse({ kind: "TEXT" }).success).toBe(false);
    expect(createStatusRequestSchemaChecked.safeParse({ kind: "URL", text: "https://example.com" }).success).toBe(true);
  });

  it("rejects non-http(s) and malformed links", () => {
    expect(createStatusRequestSchemaChecked.safeParse({ kind: "URL", text: "javascript:alert(1)" }).success).toBe(false);
    expect(createStatusRequestSchemaChecked.safeParse({ kind: "URL", text: "not a link" }).success).toBe(false);
  });

  it("requires an uploaded media key for photo and video statuses", () => {
    expect(createStatusRequestSchemaChecked.safeParse({ kind: "IMAGE" }).success).toBe(false);
    expect(
      createStatusRequestSchemaChecked.safeParse({ kind: "IMAGE", storageKey: "ab/abcdef.jpg" }).success,
    ).toBe(true);
  });
});

describe("statusItemSchema", () => {
  const base = {
    id: "s1",
    author: { userId: "u1", displayName: "Sam", avatarUrl: null },
    kind: "TEXT",
    text: "hi",
    mediaUrl: null,
    visibility: "EVERYONE",
    createdAt: new Date().toISOString(),
    expiresAt: new Date().toISOString(),
    isMine: true,
  };

  it("keeps author-only view counters null for other people's statuses", () => {
    const parsed = statusItemSchema.parse(base);
    expect(parsed.viewCount).toBeNull();
    expect(parsed.hasViews).toBeNull();
    expect(parsed.seenByMe).toBe(false);
  });

  it("rejects non-ISO timestamps", () => {
    expect(statusItemSchema.safeParse({ ...base, createdAt: "yesterday" }).success).toBe(false);
  });
});

describe("group request contracts", () => {
  it("requires a name and defaults private groups to private", () => {
    expect(createGroupRequestSchema.safeParse({ name: "  " }).success).toBe(false);
    expect(createGroupRequestSchema.parse({ name: "Team" }).visibility).toBe("PRIVATE");
    expect(() => createGroupRequestSchema.parse({ name: "x".repeat(81) })).toThrow();
  });

  it("only accepts E.164 numbers for bulk adds", () => {
    expect(createGroupRequestSchema.safeParse({ name: "Team", phones: ["07700900123"] }).success).toBe(false);
    expect(createGroupRequestSchema.safeParse({ name: "Team", phones: ["+447700900123"] }).success).toBe(true);
  });

  it("needs a full-length invite code before hitting the join endpoint", () => {
    expect(joinByCodeRequestSchema.safeParse({ code: "short" }).success).toBe(false);
    expect(joinByCodeRequestSchema.safeParse({ code: "abcdefgh" }).success).toBe(true);
  });

  it("caps discovery results", () => {
    expect(discoverGroupsQuerySchema.parse({ q: "team" }).limit).toBe(20);
    expect(discoverGroupsQuerySchema.safeParse({ q: "team", limit: 500 }).success).toBe(false);
  });
});
