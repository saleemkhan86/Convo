import { describe, expect, it } from "vitest";
import {
  decodeRfc2047,
  encodeHeaderValue,
  formatAddress,
  isBounceSender,
  parseAddressList,
  parseMessageIdList,
  sanitizeHeaderValue,
} from "../src/mail/providers/address";

describe("address parsing", () => {
  it("parses display names, quoted commas, and bare addresses", () => {
    const parsed = parseAddressList(
      '"Doe, Jane" <Jane@Example.com>, bob@example.com, Jane@example.com',
    );
    expect(parsed).toEqual([
      { address: "jane@example.com", name: "Doe, Jane" },
      { address: "bob@example.com" },
    ]);
  });

  it("decodes RFC 2047 words", () => {
    const subject = decodeRfc2047("=?UTF-8?B?SMOpbGxv?= =?UTF-8?Q?_world?=");
    expect(subject).toBe("Héllo world");
  });

  it("formats names that contain address specials", () => {
    expect(formatAddress({ address: "a@example.com", name: "Doe, Jane" })).toBe(
      '"Doe, Jane" <a@example.com>',
    );
    expect(formatAddress({ address: "a@example.com", name: "Jane Doe" })).toBe(
      "Jane Doe <a@example.com>",
    );
  });

  it("encodes non-ASCII headers and folds long words", () => {
    const encoded = encodeHeaderValue("Héllo".repeat(30));
    expect(encoded).toContain("=?UTF-8?B?");
    expect(encoded).toContain("\r\n ");
    for (const line of encoded.split("\r\n")) {
      expect(line.length).toBeLessThanOrEqual(75);
    }
  });

  it("never lets CRLF through a header value", () => {
    expect(sanitizeHeaderValue("Hi\r\nBcc: victim@example.com")).toBe(
      "Hi Bcc: victim@example.com",
    );
  });

  it("extracts Message-IDs", () => {
    expect(parseMessageIdList("<a@x> <b@y>")).toEqual(["<a@x>", "<b@y>"]);
  });

  it("recognizes bounce senders", () => {
    expect(isBounceSender("MAILER-DAEMON@example.com")).toBe(true);
    expect(isBounceSender("postmaster@example.com")).toBe(true);
    expect(isBounceSender("alice@example.com")).toBe(false);
  });
});
