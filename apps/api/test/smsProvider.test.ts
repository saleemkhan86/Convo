import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config";
import type { EmailProvider, OutgoingEmail } from "../src/email/provider";
import { AppError } from "../src/lib/errors";
import { createSmsProvider } from "../src/sms/index";
import type { SmsProvider } from "../src/sms/provider";
import { createChallenge } from "../src/services/challenges";

/** Minimal challenge-store double: cooldown lookup, expiry, then insert. */
function fakeDb(): PrismaClient {
  const challenges = {
    findFirst: async () => null,
    updateMany: async () => ({ count: 0 }),
    create: async () => ({ id: "ch1" }),
  };
  return {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ verificationChallenge: challenges }),
    verificationChallenge: challenges,
  } as unknown as PrismaClient;
}

const config = (overrides: Record<string, string> = {}) =>
  loadConfig({
    NODE_ENV: "development",
    DATABASE_URL: "postgresql://user@localhost:5432/convo_test",
    JWT_SECRET: "x".repeat(32),
    ...overrides,
  } as NodeJS.ProcessEnv);

const spySms = (): SmsProvider & { sent: Parameters<SmsProvider["sendSms"]>[0][] } => {
  const sent: Parameters<SmsProvider["sendSms"]>[0][] = [];
  return { name: "spy", sent, sendSms: async (m) => { sent.push(m); return { accepted: true }; } };
};

const spyEmail = (): EmailProvider & { sent: OutgoingEmail[] } => {
  const sent: OutgoingEmail[] = [];
  return {
    name: "spy",
    sent,
    sendEmail: async (e) => { sent.push(e); return { accepted: e.to, rejected: [] }; },
    parseEmail: async () => { throw new Error("unused"); },
    handleWebhook: async () => [],
  };
};

describe("createSmsProvider", () => {
  it("logs instead of sending outside production", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const provider = createSmsProvider(config());
    expect(provider.name).toBe("console");
    await expect(provider.sendSms({ to: "+919800000001", body: "123456" })).resolves.toEqual({ accepted: true });
    expect(log).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });

  it("refuses to claim a code was sent when production has no vendor", async () => {
    const provider = createSmsProvider(
      config({ NODE_ENV: "production", API_PUBLIC_URL: "https://api.convo.test" }),
    );
    expect(provider.name).toBe("unconfigured");
    const err = await provider.sendSms({ to: "+919800000001", body: "123456" }).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(503);
  });
});

describe("createChallenge dispatch", () => {
  it("routes a PHONE code through the SmsProvider, not the email transport", async () => {
    const sms = spySms();
    const email = spyEmail();
    const result = await createChallenge(fakeDb(), config(), { email, sms }, {
      channel: "PHONE",
      purpose: "LOGIN",
      target: "+919800000001",
      ctx: { ip: "203.0.113.9" },
    });

    expect(result.challengeId).toBe("ch1");
    expect(email.sent).toHaveLength(0);
    expect(sms.sent).toHaveLength(1);
    expect(sms.sent[0]!.to).toBe("+919800000001");
    expect(sms.sent[0]!.body).toMatch(/123456|\d{6}/);
    expect(sms.sent[0]!.ref).toEqual({ challengeId: "ch1", ip: "203.0.113.9" });
  });

  it("keeps EMAIL codes on the email transport", async () => {
    const sms = spySms();
    const email = spyEmail();
    await createChallenge(fakeDb(), config(), { email, sms }, {
      channel: "EMAIL",
      purpose: "LOGIN",
      target: "someone@example.com",
    });

    expect(sms.sent).toHaveLength(0);
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]!.to).toEqual(["someone@example.com"]);
  });

  it("surfaces a provider failure to the caller instead of reporting success", async () => {
    const failing: SmsProvider = {
      name: "failing",
      sendSms: () => Promise.reject(new AppError(503, "INTERNAL_ERROR", "SMS delivery is not configured")),
    };
    await expect(
      createChallenge(fakeDb(), config(), { email: spyEmail(), sms: failing }, {
        channel: "PHONE",
        purpose: "LOGIN",
        target: "+919800000001",
      }),
    ).rejects.toBeInstanceOf(AppError);
  });
});
