import { describe, expect, it } from "vitest";
import {
  blockRequestSchema,
  contactSchema,
  globalSearchQuerySchema,
  reportRequestSchema,
  upsertContactRequestSchema,
  userCardSchema,
} from "../src/contacts";

const contactBase = {
  id: "c1",
  displayName: "Sam Riley",
  phone: "+447700900123",
  email: null,
  avatarUrl: null,
  source: "MANUAL",
  convoUserId: null,
  createdAt: new Date().toISOString(),
};

describe("contactSchema", () => {
  it("keeps an unresolved address-book entry valid", () => {
    expect(contactSchema.parse(contactBase).convoUserId).toBeNull();
  });

  it("only links chats when an account was resolved", () => {
    expect(contactSchema.parse({ ...contactBase, convoUserId: "u9" }).convoUserId).toBe("u9");
    expect(contactSchema.safeParse({ ...contactBase, source: "PHONEBOOK" }).success).toBe(false);
  });
});

describe("upsertContactRequestSchema", () => {
  it("requires some address to key the contact by", () => {
    expect(upsertContactRequestSchema.safeParse({ displayName: "Sam" }).success).toBe(false);
  });

  it("accepts a phone or an email contact", () => {
    expect(
      upsertContactRequestSchema.safeParse({ displayName: "Sam", phone: "+447700900123" }).success,
    ).toBe(true);
    expect(
      upsertContactRequestSchema.safeParse({ displayName: "Sam", email: "sam@example.com" }).success,
    ).toBe(true);
  });

  it("normalizes emails and trims names", () => {
    const parsed = upsertContactRequestSchema.parse({
      displayName: "  Sam Riley  ",
      email: "Sam@Example.com",
    });
    expect(parsed.displayName).toBe("Sam Riley");
    expect(parsed.email).toBe("sam@example.com");
  });

  it("rejects unverified-looking names and loose phone formats", () => {
    expect(upsertContactRequestSchema.safeParse({ displayName: "   ", phone: "+447700900123" }).success).toBe(
      false,
    );
    expect(upsertContactRequestSchema.safeParse({ displayName: "Sam", phone: "07700900123" }).success).toBe(
      false,
    );
  });
});

describe("blockRequestSchema", () => {
  it("blocks exactly one target", () => {
    expect(blockRequestSchema.safeParse({ userId: "u1" }).success).toBe(true);
    expect(blockRequestSchema.safeParse({ phone: "+447700900123" }).success).toBe(true);
    expect(blockRequestSchema.safeParse({}).success).toBe(false);
    expect(blockRequestSchema.safeParse({ userId: "u1", phone: "+447700900123" }).success).toBe(false);
  });

  it("still needs an E.164 number for phone blocks", () => {
    expect(blockRequestSchema.safeParse({ phone: "447700900123" }).success).toBe(false);
  });
});

describe("reportRequestSchema", () => {
  it("never blocks alongside a report unless the caller asks", () => {
    const parsed = reportRequestSchema.parse({
      targetType: "MESSAGE",
      targetId: "m1",
      reason: "SPAM",
    });
    expect(parsed.blockAfterReport).toBe(false);
    expect(reportRequestSchema.parse({
      targetType: "MESSAGE",
      targetId: "m1",
      reason: "SPAM",
      blockAfterReport: true,
    }).blockAfterReport).toBe(true);
  });

  it("only accepts known reasons and targets", () => {
    const base = { targetId: "m1", reason: "SPAM" };
    expect(reportRequestSchema.safeParse({ ...base, targetType: "EMAIL" }).success).toBe(false);
    expect(reportRequestSchema.safeParse({ ...base, targetType: "USER", reason: "ANNOYING" }).success).toBe(
      false,
    );
    expect(reportRequestSchema.safeParse({ ...base, targetType: "USER", targetId: "" }).success).toBe(false);
  });

  it("caps free-text details", () => {
    const base = { targetType: "USER", targetId: "u1", reason: "HARASSMENT" };
    expect(reportRequestSchema.safeParse({ ...base, details: "a".repeat(2000) }).success).toBe(true);
    expect(reportRequestSchema.safeParse({ ...base, details: "a".repeat(2001) }).success).toBe(false);
  });
});

describe("userCardSchema", () => {
  const cardBase = {
    userId: "u1",
    displayName: "Sam",
    avatarUrl: null,
    bio: null,
    phone: null,
    lastSeenAt: null,
    blockedByMe: false,
    sharedConversationId: null,
  };

  it("hides missing fields as null instead of failing", () => {
    expect(userCardSchema.parse(cardBase)).toEqual(cardBase);
  });

  it("only exposes a chat handle when one is actually shared", () => {
    expect(userCardSchema.parse({ ...cardBase, phone: "+447700900123" }).phone).toBe("+447700900123");
    expect(userCardSchema.safeParse({ ...cardBase, sharedConversationId: 42 }).success).toBe(false);
    expect(userCardSchema.safeParse({ ...cardBase, blockedByMe: "true" }).success).toBe(false);
  });
});

describe("globalSearchQuerySchema", () => {
  it("requires a trimmed term", () => {
    expect(globalSearchQuerySchema.parse({ q: "  invoice " }).q).toBe("invoice");
    expect(globalSearchQuerySchema.safeParse({ q: "   " }).success).toBe(false);
    expect(globalSearchQuerySchema.safeParse({ q: "a".repeat(101) }).success).toBe(false);
  });

  it("coerces and bounds the per-section limit", () => {
    expect(globalSearchQuerySchema.parse({ q: "a" }).limit).toBe(10);
    expect(globalSearchQuerySchema.parse({ q: "a", limit: "5" }).limit).toBe(5);
    expect(globalSearchQuerySchema.safeParse({ q: "a", limit: 31 }).success).toBe(false);
    expect(globalSearchQuerySchema.safeParse({ q: "a", limit: 0 }).success).toBe(false);
    expect(globalSearchQuerySchema.safeParse({ q: "a", limit: "abc" }).success).toBe(false);
  });
});
