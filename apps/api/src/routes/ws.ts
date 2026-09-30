import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { wsClientEventSchema, type WsCallClientEvent } from "@convo/shared";
import type { AppDeps } from "../deps.js";
import { markRead, recordLastSeen } from "../services/conversations.js";
import {
  acceptCall,
  callService,
  declineCall,
  hangUpCall,
  relayCallSignal,
  setCallParticipantState,
} from "../services/calls.js";

const UNAUTHORIZED_CLOSE = 4401;

/**
 * Realtime gateway (spec §22). Downstream events (message.new, message.read,
 * typing, presence) flow over the socket; sending messages stays on HTTP so
 * retries are idempotent even across reconnects.
 *
 * Auth: the access token is passed as `?token=` because browsers cannot set
 * headers on WebSocket handshakes. The token is short-lived (15 min); clients
 * reconnect with a refreshed token on 4401.
 */
export async function wsRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get("/ws", { websocket: true }, (socket: WebSocket, request) => {
    void handleSocket(app, deps, socket, request.query as { token?: string });
  });
}

async function handleSocket(
  app: FastifyInstance,
  deps: AppDeps,
  socket: WebSocket,
  query: { token?: string },
): Promise<void> {
  let payload: { sub?: string };
  try {
    payload = app.jwt.verify<{ sub: string }>(query.token ?? "");
  } catch {
    socket.close(UNAUTHORIZED_CLOSE, "unauthorized");
    return;
  }
  if (!payload.sub) {
    socket.close(UNAUTHORIZED_CLOSE, "unauthorized");
    return;
  }
  const user = await deps.db.user.findUnique({ where: { id: payload.sub } });
  if (!user || user.status !== "ACTIVE") {
    socket.close(UNAUTHORIZED_CLOSE, "unauthorized");
    return;
  }
  const userId = user.id;

  deps.hub.add(userId, socket);
  socket.send(JSON.stringify({ type: "ready", userId }));

  socket.on("message", (raw: Buffer | string) => {
    void onClientEvent(deps, socket, userId, raw);
  });

  socket.on("close", () => {
    onDisconnect(deps, socket, userId);
  });
  socket.on("error", () => {
    onDisconnect(deps, socket, userId);
  });
}

function onDisconnect(deps: AppDeps, socket: WebSocket, userId: string): void {
  deps.hub.unwatchAll(socket);
  deps.hub.remove(userId, socket);
  // Last socket for this user closed → record when they went offline.
  if (!deps.hub.isOnline(userId)) {
    void recordLastSeen(deps.db, userId).catch(() => {});
  }
}

async function onClientEvent(
  deps: AppDeps,
  socket: WebSocket,
  userId: string,
  raw: Buffer | string,
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString());
  } catch {
    return;
  }
  const result = wsClientEventSchema.safeParse(parsed);
  if (!result.success) return;
  const event = result.data;

  switch (event.type) {
    case "ping":
      socket.send(JSON.stringify({ type: "pong" }));
      return;
    case "watch":
      deps.hub.watch(socket, event.userIds);
      return;
    case "typing": {
      if (!(await isMember(deps, userId, event.conversationId))) return;
      const others = await peerIds(deps, userId, event.conversationId);
      deps.hub.publishToUsers(others, {
        type: "typing",
        conversationId: event.conversationId,
        userId,
        isTyping: event.isTyping,
      });
      return;
    }
    case "read":
      try {
        await markRead({ db: deps.db, hub: deps.hub }, userId, event.conversationId, event.messageId);
      } catch {
        // Membership or message validation failed; ignore on the socket.
      }
      return;
    case "call.accept":
    case "call.reject":
    case "call.cancel":
    case "call.hangUp":
    case "call.signal":
    case "call.state":
      await handleCallEvent(deps, userId, event);
      return;
  }
}

/**
 * Call control and signaling (Phase 5F). Everything here is best-effort from
 * the socket's point of view: a rejected transition (already answered, call
 * over, not a participant) is dropped silently, because the client's own REST
 * view plus the next `call.ended` frame is what makes its UI correct.
 */
async function handleCallEvent(
  deps: AppDeps,
  userId: string,
  event: WsCallClientEvent,
): Promise<void> {
  const svc = callService(deps);
  try {
    switch (event.type) {
      case "call.accept":
        await acceptCall(svc, userId, event.callId);
        return;
      case "call.reject":
        await declineCall(svc, userId, event.callId, event.reason);
        return;
      // `call.cancel` (caller) and `call.hangUp` (either side) are the same
      // client intent: the state machine picks cancel/decline/end by status.
      case "call.cancel":
      case "call.hangUp":
        await hangUpCall(svc, userId, event.callId);
        return;
      case "call.signal":
        await relayCallSignal(svc, userId, event.callId, event.payload);
        return;
      case "call.state":
        await setCallParticipantState(svc, userId, event.callId, {
          muted: event.muted,
          cameraOff: event.cameraOff,
        });
        return;
    }
  } catch {
    // Invalid transition — the terminal `call.ended` frame already told the
    // truth, so there is nothing to report back over the socket.
  }
}

async function isMember(deps: AppDeps, userId: string, conversationId: string): Promise<boolean> {
  const member = await deps.db.conversationMember.findFirst({
    where: { userId, conversationId, leftAt: null },
    select: { id: true },
  });
  return member !== null;
}

async function peerIds(deps: AppDeps, userId: string, conversationId: string): Promise<string[]> {
  const others = await deps.db.conversationMember.findMany({
    where: { conversationId, leftAt: null, userId: { not: userId } },
    select: { userId: true },
  });
  return others.map((m) => m.userId);
}
