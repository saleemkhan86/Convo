import {
  appLockSettingsSchema,
  twoFactorPinSchema,
  updateEphemeralRequestSchema,
  verifyTwoFactorRequestSchema,
} from "@convo/shared";
import { describe, expect, it } from "vitest";
import { sharedEphemeralDefault } from "../src/services/conversations";
import {
  excludedIds,
  fieldVisibleTo,
  visibilityFor,
  type PrivacyOwner,
} from "../src/services/privacy";
import { hashPin, twoFactorEnabled, verifyPinHash } from "../src/services/security";

/**
 * Phase 5C unit coverage for the pure decisions the privacy/security layer
 * makes. Everything here runs without a database: the DB-backed guards reuse
 * these functions, so pinning their semantics pins the guards too.
 */

const DAY = 86_400;

function owner(overrides: Partial<PrivacyOwner> = {}): PrivacyOwner {
  return {
    avatarVisibility: "EVERYONE",
    aboutVisibility: "EVERYONE",
    onlineVisibility: "EVERYONE",
    ...overrides,
  };
}

describe("profile field visibility", () => {
  it("reads each field from its own column", () => {
    const o = owner({ aboutVisibility: "NONE", onlineVisibility: "CONTACTS" });
    expect(visibilityFor(o, "avatar")).toBe("EVERYONE");
    expect(visibilityFor(o, "about")).toBe("NONE");
    expect(visibilityFor(o, "online")).toBe("CONTACTS");
  });

  it("EVERYONE shows to strangers, NONE shows to nobody", () => {
    const stranger = { savedViewer: false, excluded: false };
    expect(fieldVisibleTo("EVERYONE", stranger)).toBe(true);
    expect(fieldVisibleTo("NONE", { savedViewer: true, excluded: false })).toBe(false);
  });

  it("CONTACTS tracks the address book, contact and non-contact alike", () => {
    expect(fieldVisibleTo("CONTACTS", { savedViewer: true, excluded: false })).toBe(true);
    expect(fieldVisibleTo("CONTACTS", { savedViewer: false, excluded: false })).toBe(false);
  });

  it("CONTACTS_EXCEPT hides even from a saved contact on the exception list", () => {
    expect(fieldVisibleTo("CONTACTS_EXCEPT", { savedViewer: true, excluded: true })).toBe(false);
    expect(fieldVisibleTo("CONTACTS_EXCEPT", { savedViewer: true, excluded: false })).toBe(true);
    // The exclusion list never grants access to someone who isn't a contact.
    expect(fieldVisibleTo("CONTACTS_EXCEPT", { savedViewer: false, excluded: false })).toBe(false);
  });

  it("treats a corrupt exclusion column as 'nobody hidden'", () => {
    expect(excludedIds(null).size).toBe(0);
    expect(excludedIds("not-json").size).toBe(0);
    expect(excludedIds({ a: 1 }).size).toBe(0);
  });

  it("keeps only string ids from a JSON array", () => {
    const ids = excludedIds(["u1", 42, null, "u2"]);
    expect([...ids].sort()).toEqual(["u1", "u2"]);
  });
});

describe("sharedEphemeralDefault", () => {
  it("stays off when either side has no timer", () => {
    expect(sharedEphemeralDefault(0, DAY)).toBe(0);
    expect(sharedEphemeralDefault(DAY, 0)).toBe(0);
    expect(sharedEphemeralDefault(0, 0)).toBe(0);
  });

  it("picks the shorter of the two timers", () => {
    expect(sharedEphemeralDefault(DAY, 7 * DAY)).toBe(DAY);
    expect(sharedEphemeralDefault(7 * DAY, DAY)).toBe(DAY);
    expect(sharedEphemeralDefault(7 * DAY, 7 * DAY)).toBe(7 * DAY);
  });

  it("never lets a negative stored value disable the timer", () => {
    expect(sharedEphemeralDefault(-1, DAY)).toBe(0);
  });
});

describe("login PIN hashing", () => {
  it("verifies the PIN that was hashed", async () => {
    const stored = await hashPin("248157");
    expect(await verifyPinHash("248157", stored)).toBe(true);
  });

  it("rejects a wrong PIN", async () => {
    const stored = await hashPin("248157");
    expect(await verifyPinHash("248158", stored)).toBe(false);
  });

  it("salts per account, so the same PIN hashes differently", async () => {
    expect(await hashPin("111111")).not.toBe(await hashPin("111111"));
  });

  it("stores salt and hash hex, never the PIN", async () => {
    const stored = await hashPin("248157");
    const [salt, hash] = stored.split(":");
    expect(salt).toMatch(/^[0-9a-f]{32}$/);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored).not.toContain("248157");
  });

  it("refuses malformed stored values instead of throwing", async () => {
    expect(await verifyPinHash("248157", "")).toBe(false);
    expect(await verifyPinHash("248157", "no-colon")).toBe(false);
    expect(await verifyPinHash("248157", "zz:yy")).toBe(false);
  });

  it("reports 2FA from the presence of a hash", () => {
    expect(twoFactorEnabled({ twoFactorHash: null })).toBe(false);
    expect(twoFactorEnabled({ twoFactorHash: "a:b" })).toBe(true);
  });
});

describe("5C request contracts", () => {
  it("accepts only the four disappearing timers", () => {
    for (const seconds of [0, DAY, 7 * DAY, 90 * DAY]) {
      expect(updateEphemeralRequestSchema.safeParse({ seconds }).success).toBe(true);
    }
    for (const seconds of [1, 60, 3600, 2 * DAY, -1, 365 * DAY]) {
      expect(updateEphemeralRequestSchema.safeParse({ seconds }).success).toBe(false);
    }
  });

  it("requires a 6-digit PIN on both 2FA calls", () => {
    expect(twoFactorPinSchema.safeParse("248157").success).toBe(true);
    for (const pin of ["24815", "2481571", "abcdef", "24 157", ""]) {
      expect(twoFactorPinSchema.safeParse(pin).success).toBe(false);
    }
    expect(verifyTwoFactorRequestSchema.safeParse({ twoFactorToken: "t", pin: "248157" }).success).toBe(
      true,
    );
    expect(verifyTwoFactorRequestSchema.safeParse({ twoFactorToken: "t", pin: "1234" }).success).toBe(
      false,
    );
  });

  it("defaults an app-lock mirror to a disabled, keyless state", () => {
    const parsed = appLockSettingsSchema.parse({});
    expect(parsed).toEqual({ enabled: false, biometric: false, timeoutSeconds: 0, pinHash: null, salt: null });
  });

  it("keeps the app-lock timeout within an hour", () => {
    expect(appLockSettingsSchema.safeParse({ timeoutSeconds: 3600 }).success).toBe(true);
    expect(appLockSettingsSchema.safeParse({ timeoutSeconds: 3601 }).success).toBe(false);
    expect(appLockSettingsSchema.safeParse({ timeoutSeconds: -1 }).success).toBe(false);
  });
});
