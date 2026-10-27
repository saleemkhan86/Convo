import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  MailTokenCipher,
  MailTokenCryptoError,
  mailTokenAad,
  oauthCodeVerifierAad,
} from "../src/mail/crypto";
import { createPkcePair } from "../src/mail/oauthState";

const KEY = Buffer.alloc(32, 7).toString("base64");
const OLD_KEY = Buffer.alloc(32, 9).toString("base64");

describe("MailTokenCipher", () => {
  it("round-trips a token bound to its AAD", () => {
    const cipher = MailTokenCipher.fromOptions({ key: KEY, keyVersion: 1 });
    const aad = mailTokenAad("conn_1", "GOOGLE", "refresh_token");
    const envelope = cipher.encrypt("refresh-secret", aad);
    expect(envelope.keyVersion).toBe(1);
    expect(cipher.decrypt(envelope, aad)).toBe("refresh-secret");
  });

  it("rejects a ciphertext moved to another field or connection", () => {
    const cipher = MailTokenCipher.fromOptions({ key: KEY, keyVersion: 1 });
    const envelope = cipher.encrypt(
      "token",
      mailTokenAad("conn_1", "GOOGLE", "access_token"),
    );
    expect(() =>
      cipher.decrypt(envelope, mailTokenAad("conn_2", "GOOGLE", "access_token")),
    ).toThrow(MailTokenCryptoError);
    expect(() =>
      cipher.decrypt(envelope, mailTokenAad("conn_1", "GOOGLE", "refresh_token")),
    ).toThrow(MailTokenCryptoError);
  });

  it("rejects tampered ciphertext", () => {
    const cipher = MailTokenCipher.fromOptions({ key: KEY, keyVersion: 1 });
    const aad = oauthCodeVerifierAad("abc");
    const envelope = cipher.encrypt("verifier", aad);
    const ciphertext = Buffer.from(envelope.ciphertext);
    ciphertext[0] = ciphertext[0]! ^ 0xff;
    expect(() => cipher.decrypt({ ...envelope, ciphertext }, aad)).toThrow(
      MailTokenCryptoError,
    );
  });

  it("decrypts envelopes from the previous key during rotation", () => {
    const oldCipher = MailTokenCipher.fromOptions({ key: OLD_KEY, keyVersion: 1 });
    const aad = mailTokenAad("conn_1", "GOOGLE", "access_token");
    const oldEnvelope = oldCipher.encrypt("old-token", aad);

    const rotated = MailTokenCipher.fromOptions({
      key: KEY,
      keyVersion: 2,
      previousKey: OLD_KEY,
      previousKeyVersion: 1,
    });
    expect(rotated.decrypt(oldEnvelope, aad)).toBe("old-token");
    expect(rotated.encrypt("new-token", aad).keyVersion).toBe(2);
  });

  it("refuses a key version it does not hold", () => {
    const cipher = MailTokenCipher.fromOptions({ key: KEY, keyVersion: 2 });
    const envelope = { ciphertext: Buffer.from("x"), iv: Buffer.alloc(12), tag: Buffer.alloc(16), keyVersion: 1 };
    expect(() => cipher.decrypt(envelope, "aad")).toThrow(/version 1/);
  });

  it("rejects keys that are not 32 bytes", () => {
    expect(() =>
      MailTokenCipher.fromOptions({ key: Buffer.alloc(16, 1).toString("base64"), keyVersion: 1 }),
    ).toThrow(/32 bytes/);
  });

  it("requires a version for the previous key", () => {
    expect(() =>
      MailTokenCipher.fromOptions({ key: KEY, keyVersion: 2, previousKey: OLD_KEY }),
    ).toThrow(/key version/);
  });
});

describe("createPkcePair", () => {
  it("derives an S256 challenge from a URL-safe verifier", () => {
    const { verifier, challenge } = createPkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(
      createHash("sha256").update(verifier).digest("base64url"),
    );
  });
});
