import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  registerDeviceRequestSchema,
  setTwoFactorRequestSchema,
  updateProfileRequestSchema,
} from "@convo/shared";
import type { AppDeps } from "../deps.js";
import { unauthorized } from "../lib/errors.js";
import { parse } from "../lib/validation.js";
import { authenticatePreHandler } from "../plugins/auth.js";
import { getAccount, updateProfile } from "../services/profile.js";
import {
  cancelAccountDeletion,
  deleteDevice,
  disableTwoFactor,
  listDevices,
  listSessions,
  requestAccountDeletion,
  revokeOtherSessions,
  revokeSession,
  setTwoFactorPin,
  twoFactorEnabled,
  upsertDevice,
} from "../services/security.js";

export async function meRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.addHook("preHandler", authenticatePreHandler(deps.db));

  const sec = { db: deps.db, config: deps.config };

  app.get("/me", async (request) => {
    return getAccount(deps.db, requireUserId(request));
  });

  app.patch("/me/profile", async (request) => {
    const patch = parse(updateProfileRequestSchema, request.body);
    return updateProfile(deps.db, requireUserId(request), patch);
  });

  // ── two-step verification (Phase 5C) ──

  app.get("/me/two-factor", async (request) => ({
    enabled: twoFactorEnabled(requireUser(request)),
  }));

  /** Setting a PIN is idempotent: a second PUT simply replaces it. */
  app.put("/me/two-factor", async (request) => {
    const { pin } = parse(setTwoFactorRequestSchema, request.body);
    await setTwoFactorPin(deps.db, requireUserId(request), pin);
    return { enabled: true };
  });

  app.delete("/me/two-factor", async (request) => {
    await disableTwoFactor(deps.db, requireUserId(request));
    return { enabled: false };
  });

  // ── active sessions ──

  app.get("/me/sessions", async (request) =>
    listSessions(deps.db, requireUserId(request), request.currentSessionId),
  );

  app.delete("/me/sessions/:id", async (request) => {
    const { id } = request.params as { id: string };
    await revokeSession(deps.db, requireUserId(request), id);
    return { ok: true };
  });

  app.post("/me/sessions/revoke-others", async (request) => {
    const revoked = await revokeOtherSessions(
      deps.db,
      requireUserId(request),
      request.currentSessionId,
    );
    return { revoked };
  });

  // ── linked devices (push registrations) ──

  app.get("/me/devices", async (request) => listDevices(deps.db, requireUserId(request)));

  app.post("/me/devices", async (request) => {
    const body = parse(registerDeviceRequestSchema, request.body);
    return upsertDevice(deps.db, requireUserId(request), body);
  });

  app.delete("/me/devices/:id", async (request) => {
    const { id } = request.params as { id: string };
    await deleteDevice(deps.db, requireUserId(request), id);
    return { ok: true };
  });

  // ── account deletion (Phase 5C, spec §34) ──

  app.post(
    "/me/delete-account",
    { config: { rateLimit: { max: 5, timeWindow: "1 hour" } } },
    async (request) => requestAccountDeletion(sec, requireUserId(request)),
  );

  /** Backing out of the grace window is always available until it elapses. */
  app.delete("/me/delete-account", async (request) => {
    await cancelAccountDeletion(deps.db, requireUserId(request));
    return { ok: true };
  });
}

function requireUserId(request: FastifyRequest): string {
  if (!request.currentUser) throw unauthorized();
  return request.currentUser.id;
}

function requireUser(request: FastifyRequest) {
  if (!request.currentUser) throw unauthorized();
  return request.currentUser;
}
