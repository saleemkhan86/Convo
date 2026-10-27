import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM envelope for provider tokens and PKCE verifiers.
 *
 * Every envelope carries the key version that produced it, so rotation is a
 * matter of adding a new active key and keeping the old one decryptable.
 * The AAD binds a ciphertext to its exact location and purpose: moving a
 * refresh token into another connection (or another field) makes it fail
 * authentication rather than silently decrypt.
 */

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface EncryptedToken {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  tag: Uint8Array;
  keyVersion: number;
}

export type TokenField = "access_token" | "refresh_token" | "code_verifier";

export class MailTokenCryptoError extends Error {
  readonly code: "INVALID_KEY" | "DECRYPT_FAILED" | "UNKNOWN_KEY_VERSION";

  constructor(code: MailTokenCryptoError["code"], message: string) {
    super(message);
    this.name = "MailTokenCryptoError";
    this.code = code;
  }
}

export interface MailTokenCipherOptions {
  /** Active key, base64/base64url or 64-char hex. */
  key: string;
  keyVersion: number;
  /** Retired key still accepted for decryption during rotation. */
  previousKey?: string;
  previousKeyVersion?: number;
}

export class MailTokenCipher {
  private readonly keys: ReadonlyMap<number, Buffer>;
  readonly activeKeyVersion: number;

  private constructor(keys: ReadonlyMap<number, Buffer>, activeKeyVersion: number) {
    this.keys = keys;
    this.activeKeyVersion = activeKeyVersion;
  }

  static fromOptions(options: MailTokenCipherOptions): MailTokenCipher {
    const keys = new Map<number, Buffer>();
    keys.set(options.keyVersion, parseKey(options.key));
    if (options.previousKey !== undefined) {
      if (options.previousKeyVersion === undefined) {
        throw new MailTokenCryptoError(
          "INVALID_KEY",
          "A previous mail token key requires its key version",
        );
      }
      if (options.previousKeyVersion === options.keyVersion) {
        throw new MailTokenCryptoError(
          "INVALID_KEY",
          "Previous and active mail token key versions must differ",
        );
      }
      keys.set(options.previousKeyVersion, parseKey(options.previousKey));
    }
    return new MailTokenCipher(keys, options.keyVersion);
  }

  static fromEnv(env: {
    MAIL_TOKEN_ENC_KEY?: string | undefined;
    MAIL_TOKEN_KEY_VERSION: number;
    MAIL_TOKEN_ENC_KEY_PREVIOUS?: string | undefined;
    MAIL_TOKEN_KEY_VERSION_PREVIOUS?: number | undefined;
  }): MailTokenCipher {
    if (!env.MAIL_TOKEN_ENC_KEY) {
      throw new MailTokenCryptoError(
        "INVALID_KEY",
        "MAIL_TOKEN_ENC_KEY is not configured; mailbox connections cannot be stored",
      );
    }
    return MailTokenCipher.fromOptions({
      key: env.MAIL_TOKEN_ENC_KEY,
      keyVersion: env.MAIL_TOKEN_KEY_VERSION,
      previousKey: env.MAIL_TOKEN_ENC_KEY_PREVIOUS,
      previousKeyVersion: env.MAIL_TOKEN_KEY_VERSION_PREVIOUS,
    });
  }

  /** True when `keyVersion` can still be decrypted (active or previous). */
  canDecrypt(keyVersion: number): boolean {
    return this.keys.has(keyVersion);
  }

  encrypt(plaintext: string, aad: string): EncryptedToken {    const key = this.keys.get(this.activeKeyVersion);
    if (!key) throw new MailTokenCryptoError("INVALID_KEY", "Active mail token key is missing");
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(plaintext, "utf8")),
      cipher.final(),
    ]);
    return {
      ciphertext,
      iv,
      tag: cipher.getAuthTag(),
      keyVersion: this.activeKeyVersion,
    };
  }

  decrypt(envelope: EncryptedToken, aad: string): string {
    const key = this.keys.get(envelope.keyVersion);
    if (!key) {
      throw new MailTokenCryptoError(
        "UNKNOWN_KEY_VERSION",
        `No mail token key available for version ${envelope.keyVersion}`,
      );
    }
    const iv = Buffer.from(envelope.iv);
    const tag = Buffer.from(envelope.tag);
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
      throw new MailTokenCryptoError("DECRYPT_FAILED", "Invalid token envelope");
    }
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(Buffer.from(aad, "utf8"));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext)),
        decipher.final(),
      ]);
      return plaintext.toString("utf8");
    } catch {
      // Never surface auth-tag/key details.
      throw new MailTokenCryptoError("DECRYPT_FAILED", "Token envelope could not be opened");
    }
  }
}

function parseKey(raw: string): Buffer {
  const value = raw.trim();
  const hex = /^[0-9a-fA-F]{64}$/.test(value) ? Buffer.from(value, "hex") : undefined;
  if (hex && hex.length === KEY_BYTES) return hex;
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) || normalized.length % 4 !== 0) {
    throw new MailTokenCryptoError(
      "INVALID_KEY",
      "Mail token key must be 32 bytes encoded as base64/base64url or 64 hex characters",
    );
  }
  const decoded = Buffer.from(normalized, "base64");
  if (decoded.length !== KEY_BYTES) {
    throw new MailTokenCryptoError(
      "INVALID_KEY",
      "Mail token key must decode to exactly 32 bytes",
    );
  }
  return decoded;
}

/** AAD for a token stored on a MailConnection row. */
export function mailTokenAad(
  connectionId: string,
  provider: string,
  field: TokenField,
): string {
  return `mail-token:${connectionId}:${provider}:${field}`;
}

/** AAD for the PKCE verifier stored on a MailOAuthState row. */
export function oauthCodeVerifierAad(stateHash: string): string {
  return `mail-oauth-state:${stateHash}:code_verifier`;
}
