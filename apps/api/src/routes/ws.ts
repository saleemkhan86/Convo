import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { wsClientEventSchema } from "@convo/shared";
import type { AppDeps } from "../deps.js";
import { markRead } from "../services/conversations.js";

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
    deps.hub.unwatchAll(socket);
    deps.hub.remove(userId, socket);
  });
  socket.on("error", () => {
    deps.hub.unwatchAll(socket);
    deps.hub.remove(userId, socket);
  });
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
