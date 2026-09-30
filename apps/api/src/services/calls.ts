import { createHmac } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  ApiErrorCode,
  type CallEndReason,
  type CallPeer,
  type CallSignalPayload,
  type CallStatus,
  type CallSummary,
  type IceConfig,
  type IceServer,
  type ListCallsQuery,
  type MissedCallCount,
  type NotificationItem,
  type StartCallRequest,
  type StartCallResponse,
} from "@convo/shared";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import type { RealtimeHub } from "./realtime.js";

/**
 * Calling (Phase 5F): voice and video over self-hosted WebRTC.
 *
 * The server never carries media. It owns three things: the call *record*
 * (so a missed call survives in history), the state machine that decides who
 * may answer or hang up, and the signaling relay that shuttles SDP/ICE between
 * exactly the two members of a 1-1 chat. Every transition is written to
 * `CallEvent` before it is broadcast, so a dropped socket can be replayed.
 *
 * Ringing is expired by a sweep rather than a timer: a call whose caller dies
 * mid-ring still has to become a missed call after a restart.
 */

export interface CallSettings {
  stunUrls: string[];
  turnUrls: string[];
  turnSecret?: string;
  credentialTtlSeconds: number;
  ringTimeoutSeconds: number;
}

export interface CallDeps {
  db: PrismaClient;
  hub: RealtimeHub;
  settings: CallSettings;
  /** Phase 5G: notify each peer about a missed call. */
  notifyRecipient?: (
    userId: string,
    type: "CALL_MISSED",
    title: string,
    body: string | null,
    actorId: string,
    conversationId: string,
    callId: string,
  ) => Promise<NotificationItem | null>;
}

/** Comma-separated env lists → the shape the service reads. */
export function callSettingsOf(env: {
  STUN_URLS: string;
  TURN_URLS: string;
  TURN_SECRET?: string;
  TURN_CREDENTIAL_TTL_SECONDS: number;
  CALL_RING_TIMEOUT_SECONDS: number;
}): CallSettings {
  const list = (v: string): string[] =>
    v
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  return {
    stunUrls: list(env.STUN_URLS),
    turnUrls: list(env.TURN_URLS),
    turnSecret: env.TURN_SECRET,
    credentialTtlSeconds: env.TURN_CREDENTIAL_TTL_SECONDS,
    ringTimeoutSeconds: env.CALL_RING_TIMEOUT_SECONDS,
  };
}

/** Env → service deps, so the REST routes and the socket share one wiring. */
export function callService(deps: {
  db: PrismaClient;
  hub: RealtimeHub;
  config: Parameters<typeof callSettingsOf>[0];
}): CallDeps {
  return { db: deps.db, hub: deps.hub, settings: callSettingsOf(deps.config) };
}

const peerFields = {
  id: true,
  displayName: true,
  avatarUrl: true,
} satisfies Prisma.UserSelect;

const callInclude = {
  caller: { select: peerFields },
  participants: { include: { user: { select: peerFields } } },
} satisfies Prisma.CallInclude;

type CallRow = Prisma.CallGetPayload<{ include: typeof callInclude }>;

function peerCard(user: { id: string; displayName: string | null; avatarUrl: string | null }): CallPeer {
  return { userId: user.id, displayName: user.displayName, avatarUrl: user.avatarUrl };
}

/** The other human in a 1-1 call; the caller's row is never a peer of itself. */
function peerIdsOf(call: CallRow, userId: string): string[] {
  return call.participants.filter((p) => p.userId !== userId).map((p) => p.userId);
}

function calleeOf(call: CallRow): CallPeer {
  const row = call.participants.find((p) => p.userId !== call.callerId);
  if (!row) throw notFound("Call not found");
  return peerCard(row.user);
}

export function serializeCall(call: CallRow, viewerId: string): CallSummary {
  const durationSeconds =
    call.connectedAt && call.endedAt
      ? Math.max(0, Math.round((call.endedAt.getTime() - call.connectedAt.getTime()) / 1000))
      : null;
  return {
    id: call.id,
    conversationId: call.conversationId,
    mediaType: call.mediaType,
    status: call.status,
    direction: call.callerId === viewerId ? "OUTGOING" : "INCOMING",
    caller: peerCard(call.caller),
    callee: calleeOf(call),
    createdAt: call.createdAt.toISOString(),
    connectedAt: call.connectedAt ? call.connectedAt.toISOString() : null,
    endedAt: call.endedAt ? call.endedAt.toISOString() : null,
    durationSeconds,
    endReason: call.declineReason,
  };
}

/**
 * ICE servers for one client. TURN uses coturn's time-limited REST credential:
 * `username` is `expiry:userId` and `credential` is the HMAC of that string, so
 * the shared secret itself is never sent and a leaked credential dies on its
 * own. With no TURN configured the call is host-and-server-reflexive only,
 * which still works on the same LAN.
 */
export function buildIceConfig(deps: CallDeps, userId: string): IceConfig {
  const { settings } = deps;
  const servers: IceServer[] = [];
  if (settings.stunUrls.length > 0) servers.push({ urls: [...settings.stunUrls] });
  if (settings.turnUrls.length > 0 && settings.turnSecret) {
    const expiresAt = Math.floor(Date.now() / 1000) + settings.credentialTtlSeconds;
    const username = `${expiresAt}:${userId}`;
    servers.push({
      urls: [...settings.turnUrls],
      username,
      credential: createHmac("sha1", settings.turnSecret).update(username).digest("base64"),
    });
  }
  return { iceServers: servers, ttlSeconds: settings.credentialTtlSeconds };
}

/** One ACTIVE DIRECT chat, its caller member and the peer across from them. */
async function loadDirectPair(db: PrismaClient, userId: string, conversationId: string) {
  const conversation = await db.conversation.findUnique({
    where: { id: conversationId },
    include: {
      members: {
        where: { leftAt: null, joinState: "ACTIVE" },
        include: { user: { select: peerFields } },
      },
    },
  });
  if (!conversation) throw notFound("Conversation not found");
  if (conversation.type !== "DIRECT") {
    throw badRequest("Calls are available in 1-1 chats only");
  }
  if (!conversation.members.some((m) => m.userId === userId)) {
    throw notFound("Conversation not found");
  }
  const peer = conversation.members.find((m) => m.userId !== userId);
  if (!peer) throw badRequest("This chat has no one to call");
  return { peer: peer.userId };
}

/** Blocking cuts both ways and is never explained (5A's rule). */
async function assertNotBlocked(db: PrismaClient, a: string, b: string): Promise<void> {
  const blocked = await db.blockedUser.findFirst({
    where: { OR: [{ userId: a, blockedUserId: b }, { userId: b, blockedUserId: a }] },
    select: { id: true },
  });
  if (blocked) throw forbidden("Calls are not available in this chat");
}

async function requireCall(db: PrismaClient, userId: string, callId: string): Promise<CallRow> {
  const call = await db.call.findUnique({ where: { id: callId }, include: callInclude });
  if (!call) throw notFound("Call not found");
  if (!call.participants.some((p) => p.userId === userId)) {
    throw forbidden("You are not in this call");
  }
  return call;
}

/** Terminal transition: write it, then tell both sides with their own view. */
async function finalizeCall(
  deps: CallDeps,
  callId: string,
  actorId: string,
  status: CallStatus,
  endReason: CallEndReason,
  peerEvent: "call.rejected" | "call.busy" | "call.canceled" | "call.hangUp" | null,
): Promise<CallSummary> {
  const { db } = deps;
  const endedAt = new Date();
  const updated = await db.call.update({
    where: { id: callId },
    data: {
      status,
      declineReason: endReason,
      endedAt,
      participants: { updateMany: { where: { userId: actorId }, data: { leftAt: endedAt } } },
      events: { create: { userId: actorId, event: status.toLowerCase() } },
    },
    include: callInclude,
  });

  const peers = peerIdsOf(updated, actorId);
  if (peerEvent) {
    deps.hub.publishToUsers(peers, {
      type: peerEvent,
      callId: updated.id,
      conversationId: updated.conversationId,
      by: actorId,
    });
  }
  // `call.ended` is the terminal frame for every device in the chat, and
  // `direction` is viewer-relative, so each side gets its own serialization.
  deps.hub.publishToUsers([actorId], {
    type: "call.ended",
    call: serializeCall(updated, actorId),
  });
  for (const peerId of peers) {
    deps.hub.publishToUsers([peerId], {
      type: "call.ended",
      call: serializeCall(updated, peerId),
    });
  }

  // Phase 5G: missed-call notification for each peer who didn't answer.
  if (status === "MISSED" && deps.notifyRecipient) {
    const title = "Missed call";
    for (const peerId of peers) {
      void deps.notifyRecipient(peerId, "CALL_MISSED", title, null, actorId, updated.conversationId, updated.id).catch(() => {});
    }
  }

  return serializeCall(updated, actorId);
}

/**
 * `POST /calls`. Retrying a start while the caller's own call is still live
 * returns that call instead of a second row — a client that loses the response
 * must never create two log entries for one dial.
 */
export async function startCall(
  deps: CallDeps,
  userId: string,
  req: StartCallRequest,
): Promise<StartCallResponse> {
  const { db } = deps;
  const { peer } = await loadDirectPair(db, userId, req.conversationId);
  await assertNotBlocked(db, userId, peer);

  const live = await db.call.findFirst({
    where: {
      conversationId: req.conversationId,
      status: { in: ["RINGING", "CONNECTED"] },
      participants: { some: { userId } },
    },
    include: callInclude,
  });
  if (live) return { call: serializeCall(live, userId), ice: buildIceConfig(deps, userId) };

  // The peer is busy elsewhere: the caller learns it here rather than having a
  // ringing overlay that no device will ever answer.
  const peerBusy = await db.call.findFirst({
    where: { status: { in: ["RINGING", "CONNECTED"] }, participants: { some: { userId: peer } } },
    select: { id: true },
  });
  if (peerBusy) throw conflict(ApiErrorCode.Conflict, "They're already on a call");

  const now = new Date();
  const call = await db.call.create({
    data: {
      conversationId: req.conversationId,
      callerId: userId,
      mediaType: req.mediaType,
      status: "RINGING",
      participants: {
        create: [
          // The caller has "joined" the moment they dial; the invitee's row
          // stays unanswered until they accept.
          { userId, answered: true, joinedAt: now },
          { userId: peer },
        ],
      },
      events: { create: [{ userId, event: "ring" }] },
    },
    include: callInclude,
  });

  deps.hub.publishToUsers([peer], {
    type: "call.incoming",
    call: serializeCall(call, peer),
  });
  return { call: serializeCall(call, userId), ice: buildIceConfig(deps, userId) };
}

/** `POST /calls/:id/accept` — only the invitee, and only while it rings. */
export async function acceptCall(
  deps: CallDeps,
  userId: string,
  callId: string,
): Promise<CallSummary> {
  const { db } = deps;
  const call = await requireCall(db, userId, callId);
  if (call.callerId === userId) throw badRequest("You placed this call");
  if (call.status !== "RINGING") throw badRequest("This call is no longer ringing");

  const now = new Date();
  const updated = await db.call.update({
    where: { id: callId },
    data: {
      status: "CONNECTED",
      connectedAt: now,
      participants: { updateMany: { where: { userId }, data: { answered: true, joinedAt: now } } },
      events: { create: { userId, event: "accept" } },
    },
    include: callInclude,
  });

  // The caller's devices stop ringing; the answerer's other devices close
  // their copy of the incoming modal too.
  deps.hub.publishToUsers([userId, updated.callerId], {
    type: "call.accepted",
    callId,
    conversationId: updated.conversationId,
    acceptedBy: userId,
    acceptedAt: now.toISOString(),
  });
  return serializeCall(updated, userId);
}

/**
 * `POST /calls/:id/decline`. BUSY and DECLINED are separate statuses because
 * the caller's log shows them differently ("busy" is not "they rejected me").
 */
export async function declineCall(
  deps: CallDeps,
  userId: string,
  callId: string,
  reason: "DECLINED" | "BUSY" = "DECLINED",
): Promise<CallSummary> {
  const call = await requireCall(deps.db, userId, callId);
  if (call.callerId === userId) throw badRequest("You placed this call");
  if (call.status !== "RINGING") throw badRequest("This call is no longer ringing");
  return finalizeCall(
    deps,
    callId,
    userId,
    reason,
    reason,
    reason === "BUSY" ? "call.busy" : "call.rejected",
  );
}

/**
 * `POST /calls/:id/hang-up` — one verb for "I'm done", whichever side of the
 * state machine the client is on: cancel a ring, decline an incoming call, or
 * end a live one. An already-finished call answers with its record unchanged.
 */
export async function hangUpCall(
  deps: CallDeps,
  userId: string,
  callId: string,
): Promise<CallSummary> {
  const call = await requireCall(deps.db, userId, callId);
  if (call.status === "ENDED") return serializeCall(call, userId);
  if (call.status === "RINGING") {
    return call.callerId === userId
      ? finalizeCall(deps, callId, userId, "CANCELED", "CANCELED", "call.canceled")
      : finalizeCall(deps, callId, userId, "DECLINED", "DECLINED", "call.rejected");
  }
  return finalizeCall(deps, callId, userId, "ENDED", "HANG_UP", "call.hangUp");
}

/** `PATCH /calls/:id/me` — mic/camera state, recorded for the call log only. */
export async function setCallParticipantState(
  deps: CallDeps,
  userId: string,
  callId: string,
  patch: { muted?: boolean; cameraOff?: boolean },
): Promise<CallSummary> {
  const { db } = deps;
  const call = await requireCall(db, userId, callId);
  const data: Prisma.CallParticipantUpdateManyMutationInput = {};
  if (patch.muted !== undefined) data.muted = patch.muted;
  if (patch.cameraOff !== undefined) data.cameraOff = patch.cameraOff;
  if (Object.keys(data).length > 0) {
    await db.callParticipant.updateMany({ where: { callId, userId }, data });
  }
  return serializeCall(call, userId);
}

/**
 * Signaling relay (`call.signal` on the socket). SDP is written to `CallEvent`
 * for disputes and reconnects; ICE candidates are not — they arrive in bursts
 * of dozens and a candidate that lands after the call is over is simply
 * dropped, which is why the status check happens before the send.
 */
export async function relayCallSignal(
  deps: CallDeps,
  userId: string,
  callId: string,
  payload: CallSignalPayload,
): Promise<void> {
  const { db } = deps;
  const call = await requireCall(db, userId, callId);
  if (call.status !== "RINGING" && call.status !== "CONNECTED") {
    throw badRequest("This call has already ended");
  }
  if (payload.kind !== "ice") {
    await db.callEvent.create({ data: { callId, userId, event: payload.kind } });
  }
  deps.hub.publishToUsers(peerIdsOf(call, userId), {
    type: "call.signal",
    callId,
    conversationId: call.conversationId,
    from: userId,
    payload,
  });
}

/** `GET /calls` — the call log, newest first. */
export async function listCalls(
  deps: CallDeps,
  userId: string,
  query: ListCallsQuery,
): Promise<{ items: CallSummary[]; nextCursor: string | null }> {
  const where: Prisma.CallWhereInput = {
    OR: [{ callerId: userId }, { participants: { some: { userId } } }],
    ...(query.conversationId ? { conversationId: query.conversationId } : {}),
    ...(query.missedOnly ? { status: "MISSED" as const } : {}),
    ...(query.direction && query.direction.length === 1
      ? { callerId: query.direction[0] === "OUTGOING" ? userId : { not: userId } }
      : {}),
  };

  const rows = await deps.db.call.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: query.limit + 1,
    include: callInclude,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const oldest = rows[rows.length - 1];
  return {
    items: page.map((row) => serializeCall(row, userId)),
    nextCursor: hasMore && oldest ? oldest.id : null,
  };
}

/**
 * Unseen missed calls. The watermark is the chat's own `lastReadAt` — the 5E
 * precedent — so opening the chat clears the badge on every device, and calls
 * the caller placed never count against them.
 */
export async function missedCallCount(
  deps: CallDeps,
  userId: string,
): Promise<MissedCallCount> {
  const { db } = deps;
  const rows = await db.call.findMany({
    where: {
      status: "MISSED",
      callerId: { not: userId },
      participants: { some: { userId } },
    },
    select: { conversationId: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  if (rows.length === 0) return { count: 0 };

  const members = await db.conversationMember.findMany({
    where: { userId, conversationId: { in: [...new Set(rows.map((r) => r.conversationId))] } },
    select: { conversationId: true, lastReadAt: true },
  });
  const readAt = new Map(members.map((m) => [m.conversationId, m.lastReadAt]));

  let count = 0;
  for (const row of rows) {
    const seen = readAt.get(row.conversationId);
    if (!seen || row.createdAt > seen) count += 1;
  }
  return { count };
}

/**
 * Sweep: a ring nobody answered becomes a missed call. Driven by the interval
 * in `server.ts` rather than a per-call timer so a restart mid-ring still
 * expires, and so a caller who closed the tab doesn't leave a live modal on the
 * callee's phone forever.
 */
export async function sweepStuckRings(deps: CallDeps): Promise<number> {
  const cutoff = new Date(Date.now() - deps.settings.ringTimeoutSeconds * 1000);
  const stale = await deps.db.call.findMany({
    where: { status: "RINGING", createdAt: { lt: cutoff } },
    include: callInclude,
    take: 50,
  });
  for (const call of stale) {
    await finalizeCall(deps, call.id, call.callerId, "MISSED", "MISSED", null);
  }
  return stale.length;
}
