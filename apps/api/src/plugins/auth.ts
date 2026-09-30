import type { FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { unauthorized } from "../lib/errors.js";
import { userWithIdentities, type UserWithIdentities } from "../services/account.js";

declare module "fastify" {
  interface FastifyRequest {
    currentUser?: UserWithIdentities;
    /** Refresh-token row backing this access token, for the sessions list. */
    currentSessionId?: string;
  }
}

export function authenticatePreHandler(db: PrismaClient) {
  return async function authenticate(request: FastifyRequest): Promise<void> {
    const token = extractBearerToken(request.headers.authorization);
    if (!token) throw unauthorized();

    let payload: { sub?: string; sid?: string };
    try {
      payload = request.server.jwt.verify<{ sub: string; sid?: string }>(token);
    } catch {
      throw unauthorized("Session expired. Please sign in again.");
    }
    if (!payload.sub) throw unauthorized();
    request.currentSessionId = payload.sid;

    const user = await db.user.findUnique({
      where: { id: payload.sub },
      ...userWithIdentities,
    });
    if (!user || user.status !== "ACTIVE") throw unauthorized();
    request.currentUser = user;
  };
}

function extractBearerToken(header: string | undefined): string | null {
  if (!header?.toLowerCase().startsWith("bearer ")) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}
