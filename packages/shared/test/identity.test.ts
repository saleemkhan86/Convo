import { describe, expect, it } from "vitest";
import {
  capabilitiesOf,
  emailAddressSchema,
  e164PhoneSchema,
  identityStateOf,
} from "../src/identity";

describe("identityStateOf", () => {
  it("maps identity presence to states", () => {
    expect(identityStateOf({ phone: null, email: null })).toBe("none");
    expect(identityStateOf({ phone: {}, email: null })).toBe("phone_only");
    expect(identityStateOf({ phone: null, email: {} })).toBe("email_only");
    expect(identityStateOf({ phone: {}, email: {} })).toBe("both");
  });
});

describe("capabilitiesOf", () => {
  it("chats requires phone, mail requires email", () => {
    expect(capabilitiesOf("none")).toEqual({ chats: false, mail: false });
    expect(capabilitiesOf("phone_only")).toEqual({ chats: true, mail: false });
    expect(capabilitiesOf("email_only")).toEqual({ chats: false, mail: true });
    expect(capabilitiesOf("both")).toEqual({ chats: true, mail: true });
  });
});

describe("e164PhoneSchema", () => {
  it("accepts valid E.164 numbers", () => {
    expect(e164PhoneSchema.parse("+919876543210")).toBe("+919876543210");
    expect(e164PhoneSchema.parse("+14155550123")).toBe("+14155550123");
  });

  it("rejects invalid numbers", () => {
    expect(() => e164PhoneSchema.parse("9876543210")).toThrow();
    expect(() => e164PhoneSchema.parse("+0123456789")).toThrow();
    expect(() => e164PhoneSchema.parse("+123456")).toThrow();
    expect(() => e164PhoneSchema.parse("+91987654321012345")).toThrow();
  });
});

describe("emailAddressSchema", () => {
  it("normalizes to lowercase and trims", () => {
    expect(emailAddressSchema.parse("  Alice@Example.COM ")).toBe("alice@example.com");
  });

  it("rejects invalid addresses", () => {
    expect(() => emailAddressSchema.parse("not-an-email")).toThrow();
    expect(() => emailAddressSchema.parse("a@b")).toThrow();
  });
});
