import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { matchesAudience } from "../src/services/statuses";

const contacts = new Set(["friend1", "friend2"]);

describe("matchesAudience", () => {
  it("always shows an author their own status", () => {
    expect(
      matchesAudience({ visibility: "CUSTOM", audience: [], excluded: [], authorId: "me" }, "me", contacts),
    ).toBe(true);
  });

  it("shows EVERYONE statuses to any account", () => {
    const status = { visibility: "EVERYONE", audience: [], excluded: [], authorId: "author" };
    expect(matchesAudience(status, "stranger", contacts)).toBe(true);
  });

  it("restricts CONTACTS statuses to the author's contacts", () => {
    const status = { visibility: "CONTACTS", audience: [], excluded: [], authorId: "author" };
    expect(matchesAudience(status, "friend1", contacts)).toBe(true);
    expect(matchesAudience(status, "stranger", contacts)).toBe(false);
  });

  it("shows CUSTOM statuses only to the allow-list", () => {
    const status = { visibility: "CUSTOM", audience: ["friend2"], excluded: [], authorId: "author" };
    expect(matchesAudience(status, "friend2", contacts)).toBe(true);
    expect(matchesAudience(status, "friend1", contacts)).toBe(false);
  });

  it("shows CONTACTS_EXCEPT statuses to contacts minus the block-list", () => {
    const status = { visibility: "CONTACTS_EXCEPT", audience: [], excluded: ["friend1"], authorId: "author" };
    expect(matchesAudience(status, "friend2", contacts)).toBe(true);
    expect(matchesAudience(status, "friend1", contacts)).toBe(false);
    // a non-contact stays out even when they are not explicitly excluded
    expect(matchesAudience(status, "stranger", contacts)).toBe(false);
  });

  it("denies unknown visibility values", () => {
    const status = { visibility: "SOMEDAY", audience: [], excluded: [], authorId: "author" };
    expect(matchesAudience(status, "friend1", contacts)).toBe(false);
  });
});
