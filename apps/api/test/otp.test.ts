import { describe, expect, it } from "vitest";
import { generateOtp, hashCode, verifyCodeHash } from "../src/lib/otp";

describe("otp", () => {
  it("generates 6 numeric digits by default", () => {
    for (let i = 0; i < 50; i++) {
      expect(generateOtp()).toMatch(/^\d{6}$/);
    }
  });

  it("generates varying codes", () => {
    const codes = new Set(Array.from({ length: 20 }, () => generateOtp()));
    expect(codes.size).toBeGreaterThan(1);
  });

  it("verifies a correct code against its hash", () => {
    const code = generateOtp();
    expect(verifyCodeHash(code, hashCode(code))).toBe(true);
  });

  it("rejects an incorrect code", () => {
    expect(verifyCodeHash("000000", hashCode("123456"))).toBe(false);
  });

  it("hashes deterministically and not reversibly", () => {
    expect(hashCode("123456")).toBe(hashCode("123456"));
    expect(hashCode("123456")).not.toContain("123456");
  });
});
