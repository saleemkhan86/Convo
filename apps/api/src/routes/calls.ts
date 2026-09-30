import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  callParticipantStateRequestSchema,
  endCallRequestSchema,
  listCallsQuerySchema,
  startCallRequestSchema,
} from "@convo/shared";
import type { AppDeps } from "../deps.js";
import { unauthorized } from "../lib/errors.js";
import { parse } from "../lib/validation.js";
import { authenticatePreHandler } from "../plugins/auth.js";
import { notifyUser, type NotifyDeps as NotificationDeps } from "../services/notifications.js";
import {
  acceptCall,
  buildIceConfig,
  callService,
  declineCall,
  hangUpCall,
  listCalls,
  missedCallCount,
  setCallParticipantState,
  startCall,
  type CallDeps,
} from "../services/calls.js";

/**
 * Call API (Phase 5F): the call log and the state machine around it. Media and
 * signaling are not here — signaling rides the already-authenticated `/ws`
 * socket, so a ring never waits on an HTTP round trip.
 */
export async function callRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.addHook("preHandler", authenticatePreHandler(deps.db));
  const notifySvc: NotificationDeps = { db: deps.db, hub: deps.hub, push: deps.push };
  const svc: CallDeps = {
    ...callService(deps),
    // Phase 5G: notify each peer about a missed call.
    notifyRecipient: (userId, type, title, body, actorId, conversationId, callId) =>
      notifyUser(notifySvc, { userId, type, title, body, actorId, conversationId, callId }),
  };

  app.post(
    "/calls",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request) => {
      const body = parse(startCallRequestSchema, request.body);
      return startCall(svc, requireUserId(request), body);
    },
  );

  /** The callee needs TURN credentials too, and it cannot read them from the
   * caller's response — the socket event carries no secrets. */
  app.get("/calls/ice-config", async (request) => buildIceConfig(svc, requireUserId(request)));

  app.get("/calls", async (request) => {
    const query = parse(listCallsQuerySchema, request.query);
    return listCalls(svc, requireUserId(request), query);
  });

  app.get("/calls/missed-count", async (request) => missedCallCount(svc, requireUserId(request)));

  app.post("/calls/:id/accept", async (request) =>
    acceptCall(svc, requireUserId(request), callId(request)),
  );

  app.post("/calls/:id/decline", async (request) => {
    const body = parse(endCallRequestSchema, request.body ?? {});
    const reason = body.reason === "BUSY" ? "BUSY" : "DECLINED";
    return declineCall(svc, requireUserId(request), callId(request), reason);
  });

  app.post("/calls/:id/hang-up", async (request) =>
    hangUpCall(svc, requireUserId(request), callId(request)),
  );

  app.patch("/calls/:id/me", async (request) => {
    const body = parse(callParticipantStateRequestSchema, request.body);
    return setCallParticipantState(svc, requireUserId(request), callId(request), body);
  });
}

function callId(request: FastifyRequest): string {
  return (request.params as { id: string }).id;
}

function requireUserId(request: FastifyRequest): string {
  if (!request.currentUser) throw unauthorized();
  return request.currentUser.id;
}
