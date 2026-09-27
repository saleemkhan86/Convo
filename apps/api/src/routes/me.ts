import type { FastifyInstance, FastifyRequest } from "fastify";
import { updateProfileRequestSchema } from "@convo/shared";
import type { AppDeps } from "../deps.js";
import { unauthorized } from "../lib/errors.js";
import { parse } from "../lib/validation.js";
import { authenticatePreHandler } from "../plugins/auth.js";
import { getAccount, updateProfile } from "../services/profile.js";

export async function meRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.addHook("preHandler", authenticatePreHandler(deps.db));

  app.get("/me", async (request) => {
    return getAccount(deps.db, requireUserId(request));
  });

  app.patch("/me/profile", async (request) => {
    const patch = parse(updateProfileRequestSchema, request.body);
    return updateProfile(deps.db, requireUserId(request), patch);
  });
}

function requireUserId(request: FastifyRequest): string {
  if (!request.currentUser) throw unauthorized();
  return request.currentUser.id;
}
