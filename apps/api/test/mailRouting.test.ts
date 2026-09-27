import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { resolveMailRoute } from "../src/services/mailRouting";

function fakeDb(identity: { userId: string } | null): PrismaClient {
  return {
    emailIdentity: {
      findUnique: async ({ where }: { where: { email: string } }) => {
        // the resolver must normalize before lookup
        expect(where.email).toBe(where.email.toLowerCase());
        return identity;
      },
    },
  } as unknown as PrismaClient;
}

describe("resolveMailRoute", () => {
  it("routes Convo email identities internally", async () => {
    const decision = await resolveMailRoute(fakeDb({ userId: "u1" }), "bob@example.com");
    expect(decision).toEqual({ route: "CONVO_INTERNAL", convoUserId: "u1" });
  });

  it("routes unknown addresses to external SMTP", async () => {
    const decision = await resolveMailRoute(fakeDb(null), "bob@gmail.com");
    expect(decision).toEqual({ route: "EXTERNAL_SMTP" });
  });

  it("normalizes case and whitespace before lookup", async () => {
    const decision = await resolveMailRoute(fakeDb({ userId: "u2" }), "  Bob@Example.com ");
    expect(decision.route).toBe("CONVO_INTERNAL");
  });
});
