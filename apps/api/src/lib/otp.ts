import { createHash, randomInt, timingSafeEqual } from "node:crypto";

export function generateOtp(length = 6): string {
  let code = "";
  for (let i = 0; i < length; i++) {
    code += randomInt(0, 10).toString();
  }
  return code;
}

export function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

export function verifyCodeHash(code: string, hash: string): boolean {
  const candidate = Buffer.from(hashCode(code));
  const expected = Buffer.from(hash);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}
