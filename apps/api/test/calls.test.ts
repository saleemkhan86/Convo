import { createHmac } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { WsServerEvent } from "@convo/shared";
import { describe, expect, it, vi } from "vitest";
import {
  acceptCall,
  buildIceConfig,
  callSettingsOf,
  declineCall,
  hangUpCall,
  listCalls,
  missedCallCount,
  relayCallSignal,
  serializeCall,
  startCall,
  sweepStuckRings,
  type CallDeps,
} from "../src/services/calls";
import type { RealtimeHub } from "../src/services/realtime";

/**
 * Phase 5F unit coverage for the call state machine with a stubbed client: who
 * may answer, what each exit writes to the log, which socket frames each side
 * is told about, and how a ring expires. No database, no media.
 */

const CALLER = "u1";
const CALLEE = "u2";
const person = (id: string, displayName: string | null) => ({ id, displayName, avatarUrl: null });

function callRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "call1",
    conversationId: "c1",
    callerId: CALLER,
    mediaType: "VOICE",
    status: "RINGING",
    createdAt: new Date("2026-09-29T10:00:00.000Z"),
    connectedAt: null,
    endedAt: null,
    declineReason: null,
    caller: person(CALLER, "Sammy Khan"),
    participants: [
      { userId: CALLER, user: person(CALLER, "Sammy Khan") },
      { userId: CALLEE, user: person(CALLEE, null) },
    ],
    ...overrides,
  };
}

function conversationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "c1",
    type: "DIRECT",
    members: [
      { userId: CALLER, user: person(CALLER, "Sammy Khan") },
      { userId: CALLEE, user: person(CALLEE, null) },
    ],
    ...overrides,
  };
}

/** The relations the service writes through `update`, which the stubs flatten. */
const RELATIONS = new Set(["participants", "events"]);

function depsOf(rows: Record<string, unknown>): CallDeps {
  const db = {
    conversation: { findUnique: vi.fn().mockResolvedValue(rows.conversation ?? conversationRow()) },
    blockedUser: { findFirst: vi.fn().mockResolvedValue(rows.blocked ? { id: "b1" } : null) },
    call: {
      findFirst: vi.fn().mockResolvedValue(rows.first ?? null),
      findMany: vi.fn().mockResolvedValue(rows.many ?? []),
      findUnique: vi.fn().mockResolvedValue(rows.call ?? callRow()),
      create: vi.fn().mockResolvedValue(rows.created ?? callRow()),
      // Mirrors Prisma's return value: the stored row with the written columns
      // replaced, so a test can assert the transition instead of the mock.
      update: vi.fn().mockImplementation(async (arg: { data: Record<string, unknown> }) => {
        const fixture = (rows.updated ?? rows.call ?? {}) as Record<string, unknown>;
        const row = callRow(fixture);
        for (const [key, value] of Object.entries(arg.data)) {
          if (!RELATIONS.has(key)) row[key] = value;
        }
        return row;
      }),
    },
    callParticipant: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    callEvent: { create: vi.fn().mockResolvedValue({ id: "e1" }) },
    conversationMember: { findMany: vi.fn().mockResolvedValue(rows.members ?? []) },
  } as unknown as PrismaClient;

  return {
    db,
    hub: { publishToUsers: vi.fn() } as unknown as RealtimeHub,
    settings: {
      stunUrls: ["stun:stun.l.google.com:19302"],
      turnUrls: [],
      credentialTtlSeconds: 3600,
      ringTimeoutSeconds: 45,
    },
  };
}

const published = (deps: CallDeps): WsServerEvent[] =>
  (deps.hub.publishToUsers as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[1] as WsServerEvent);

const callWrites = (deps: CallDeps) =>
  (deps.db.call.update as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].data as Record<string, unknown>);

describe("callSettingsOf", () => {
  it("splits comma lists and drops blanks", () => {
    const settings = callSettingsOf({
      STUN_URLS: "stun:a.example:19302, ,stun:b.example:19302",
      TURN_URLS: "turn:relay.example:3478?transport=udp",
      TURN_SECRET: "s3cret-value",
      TURN_CREDENTIAL_TTL_SECONDS: 600,
      CALL_RING_TIMEOUT_SECONDS: 30,
    });
    expect(settings.stunUrls).toEqual(["stun:a.example:19302", "stun:b.example:19302"]);
    expect(settings.turnUrls).toEqual(["turn:relay.example:3478?transport=udp"]);
    expect(settings.ringTimeoutSeconds).toBe(30);
  });
});

describe("buildIceConfig", () => {
  it("offers STUN only when no relay is configured", () => {
    const config = buildIceConfig(depsOf({}), CALLER);
    expect(config.iceServers).toEqual([{ urls: ["stun:stun.l.google.com:19302"] }]);
    expect(config.ttlSeconds).toBe(3600);
  });

  it("mints a time-limited coturn credential instead of sending the secret", () => {
    const deps = depsOf({});
    deps.settings.turnUrls = ["turn:relay.example:3478"];
    deps.settings.turnSecret = "s3cret-value";
    const turn = buildIceConfig(deps, CALLER).iceServers[1]!;
    const expiry = Number(turn.username!.split(":")[0]);
    expect(expiry).toBeGreaterThan(Math.floor(Date.now() / 1000) + 3500);
    expect(turn.username).toBe(`${expiry}:${CALLER}`);
    expect(turn.credential).toBe(
      createHmac("sha1", "s3cret-value").update(turn.username!).digest("base64"),
    );
    expect(JSON.stringify(turn)).not.toContain("s3cret-value");
  });

  it("never hands out a relay without a secret to sign with", () => {
    const deps = depsOf({});
    deps.settings.turnUrls = ["turn:relay.example:3478"];
    expect(buildIceConfig(deps, CALLER).iceServers).toHaveLength(1);
  });
});

describe("serializeCall", () => {
  it("states direction from whoever is reading", () => {
    const row = callRow() as never;
    expect(serializeCall(row, CALLER).direction).toBe("OUTGOING");
    expect(serializeCall(row, CALLEE).direction).toBe("INCOMING");
  });

  it("names the callee from the participants, since only the caller is a column", () => {
    expect(serializeCall(callRow() as never, CALLER).callee.userId).toBe(CALLEE);
  });

  it("reports seconds only between connect and end", () => {
    const live = serializeCall(
      callRow({
        status: "ENDED",
        connectedAt: new Date("2026-09-29T10:00:10.000Z"),
        endedAt: new Date("2026-09-29T10:01:00.000Z"),
      }) as never,
      CALLER,
    );
    expect(live.durationSeconds).toBe(50);
    expect(serializeCall(callRow() as never, CALLER).durationSeconds).toBeNull();
  });
});

describe("startCall", () => {
  it("rings the peer and hands the caller an ICE config", async () => {
    const deps = depsOf({});
    const result = await startCall(deps, CALLER, { conversationId: "c1", mediaType: "VOICE" });
    expect(result.call.status).toBe("RINGING");
    expect(result.call.direction).toBe("OUTGOING");
    expect(result.ice.iceServers.length).toBeGreaterThan(0);

    const created = (deps.db.call.create as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      data: { status: string; participants: { create: { userId: string; answered?: boolean }[] } };
    };
    expect(created.data.status).toBe("RINGING");
    expect(created.data.participants.create[0]).toMatchObject({ userId: CALLER, answered: true });
    expect(created.data.participants.create[1]).toEqual({ userId: CALLEE });

    const frames = published(deps);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.type).toBe("call.incoming");
    expect((frames[0] as Extract<WsServerEvent, { type: "call.incoming" }>).call.direction).toBe("INCOMING");
  });

  it("returns the live call on a retry instead of writing a second row", async () => {
    const deps = depsOf({ first: callRow({ status: "CONNECTED" }) });
    const result = await startCall(deps, CALLER, { conversationId: "c1", mediaType: "VOICE" });
    expect(result.call.id).toBe("call1");
    expect(deps.db.call.create).not.toHaveBeenCalled();
    expect(published(deps)).toHaveLength(0);
  });

  it("refuses to ring someone who is already on a call", async () => {
    const deps = depsOf({ first: null });
    (deps.db.call.findFirst as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "call-other" });
    await expect(startCall(deps, CALLER, { conversationId: "c1", mediaType: "VOICE" })).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("cuts both ways when either side blocked the other, and says nothing useful", async () => {
    const deps = depsOf({ blocked: true });
    await expect(startCall(deps, CALLER, { conversationId: "c1", mediaType: "VOICE" })).rejects.toMatchObject({
      statusCode: 403,
      message: "Calls are not available in this chat",
    });
  });

  it("keeps groups out of 1-1 calling", async () => {
    const deps = depsOf({ conversation: conversationRow({ type: "GROUP" }) });
    await expect(startCall(deps, CALLER, { conversationId: "c1", mediaType: "VOICE" })).rejects.toMatchObject({
      statusCode: 400,
      message: "Calls are available in 1-1 chats only",
    });
  });

  it("answers a stranger with 404, not with the conversation's existence", async () => {
    const deps = depsOf({});
    await expect(startCall(deps, "u9", { conversationId: "c1", mediaType: "VOICE" })).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe("acceptCall", () => {
  it("connects the callee and tells both ends", async () => {
    const deps = depsOf({});
    const summary = await acceptCall(deps, CALLEE, "call1");
    expect(summary.status).toBe("CONNECTED");
    expect(summary.direction).toBe("INCOMING");
    expect(callWrites(deps)[0]).toMatchObject({ status: "CONNECTED" });
    const frames = published(deps);
    expect(frames[0]!.type).toBe("call.accepted");
    expect((deps.hub.publishToUsers as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toEqual([
      CALLEE,
      CALLER,
    ]);
  });

  it("will not let the caller answer their own ring", async () => {
    const deps = depsOf({});
    await expect(acceptCall(deps, CALLER, "call1")).rejects.toMatchObject({ statusCode: 400 });
  });

  it("will not let a non-participant in", async () => {
    const deps = depsOf({});
    await expect(acceptCall(deps, "u9", "call1")).rejects.toMatchObject({ statusCode: 403 });
  });

  it("refuses a call that already finished", async () => {
    const deps = depsOf({ call: callRow({ status: "ENDED" }) });
    await expect(acceptCall(deps, CALLEE, "call1")).rejects.toMatchObject({
      statusCode: 400,
      message: "This call is no longer ringing",
    });
  });
});

describe("declineCall", () => {
  it("writes DECLINED and rejects the ring", async () => {
    const deps = depsOf({});
    const summary = await declineCall(deps, CALLEE, "call1", "DECLINED");
    expect(summary.status).toBe("DECLINED");
    expect(published(deps).map((e) => e.type)).toEqual(["call.rejected", "call.ended", "call.ended"]);
  });

  it("keeps BUSY a separate outcome from being turned down", async () => {
    const deps = depsOf({});
    await declineCall(deps, CALLEE, "call1", "BUSY");
    expect(callWrites(deps)[0]).toMatchObject({ status: "BUSY", declineReason: "BUSY" });
    expect(published(deps)[0]!.type).toBe("call.busy");
  });

  it("lets the caller never decline — that is what cancel is for", async () => {
    const deps = depsOf({});
    await expect(declineCall(deps, CALLER, "call1")).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("hangUpCall", () => {
  it("cancels a ring the caller placed", async () => {
    const deps = depsOf({});
    await hangUpCall(deps, CALLER, "call1");
    expect(callWrites(deps)[0]).toMatchObject({ status: "CANCELED", declineReason: "CANCELED" });
    expect(published(deps)[0]!.type).toBe("call.canceled");
  });

  it("declines an incoming ring the callee walks away from", async () => {
    const deps = depsOf({});
    await hangUpCall(deps, CALLEE, "call1");
    expect(callWrites(deps)[0]).toMatchObject({ status: "DECLINED" });
    expect(published(deps)[0]!.type).toBe("call.rejected");
  });

  it("ends a live call and records the hang-up", async () => {
    // The service stamps `endedAt` with the wall clock, so the logged
    // duration is only checkable against a frozen one.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-29T10:00:40.000Z"));
    try {
      const deps = depsOf({
        call: callRow({ status: "CONNECTED", connectedAt: new Date("2026-09-29T10:00:10.000Z") }),
      });
      const summary = await hangUpCall(deps, CALLER, "call1");
      expect(summary.status).toBe("ENDED");
      expect(summary.durationSeconds).toBe(30);
      expect(published(deps).map((e) => e.type)).toEqual(["call.hangUp", "call.ended", "call.ended"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is idempotent — a second hang-up re-reads the record and writes nothing", async () => {
    const deps = depsOf({ call: callRow({ status: "ENDED", declineReason: "HANG_UP" }) });
    const summary = await hangUpCall(deps, CALLER, "call1");
    expect(summary.status).toBe("ENDED");
    expect(deps.db.call.update).not.toHaveBeenCalled();
    expect(published(deps)).toHaveLength(0);
  });

  it("sends each side its own view of the ended call", async () => {
    const deps = depsOf({ updated: callRow({ status: "ENDED", declineReason: "HANG_UP" }) });
    await hangUpCall(deps, CALLER, "call1");
    const ended = published(deps).filter((e) => e.type === "call.ended");
    expect(ended.map((e) => (e as Extract<WsServerEvent, { type: "call.ended" }>).call.direction)).toEqual([
      "OUTGOING",
      "INCOMING",
    ]);
  });
});

describe("relayCallSignal", () => {
  it("stores SDP and forwards it to the peer only", async () => {
    const deps = depsOf({ call: callRow({ status: "CONNECTED" }) });
    await relayCallSignal(deps, CALLEE, "call1", { kind: "answer", sdp: "v=0\r\n" });
    expect(deps.db.callEvent.create).toHaveBeenCalledOnce();
    const targets = (deps.hub.publishToUsers as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(targets).toEqual([CALLER]);
    expect(published(deps)[0]!.type).toBe("call.signal");
  });

  it("never persists ICE candidates, but still relays them", async () => {
    const deps = depsOf({ call: callRow({ status: "CONNECTED" }) });
    await relayCallSignal(deps, CALLEE, "call1", {
      kind: "ice",
      candidate: "candidate:1 1 udp 4128",
      sdpMid: "0",
      sdpMLineIndex: 0,
    });
    expect(deps.db.callEvent.create).not.toHaveBeenCalled();
    expect(published(deps)).toHaveLength(1);
  });

  it("drops signaling for a call that is over", async () => {
    const deps = depsOf({ call: callRow({ status: "ENDED" }) });
    await expect(
      relayCallSignal(deps, CALLEE, "call1", { kind: "offer", sdp: "v=0\r\n" }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(published(deps)).toHaveLength(0);
  });
});

describe("listCalls", () => {
  it("pages with a cursor set to the oldest row it dropped", async () => {
    const rows = [callRow({ id: "c" }), callRow({ id: "b" }), callRow({ id: "a" })];
    const deps = depsOf({ many: rows });
    const page = await listCalls(deps, CALLER, { limit: 2 });
    expect(page.items.map((i) => i.id)).toEqual(["c", "b"]);
    expect(page.nextCursor).toBe("a");
  });

  it("stops without a cursor once the tail is reached", async () => {
    const deps = depsOf({ many: [callRow()] });
    const page = await listCalls(deps, CALLER, { limit: 2 });
    expect(page.nextCursor).toBeNull();
  });

  it("filters a missed-calls view down to MISSED rows", async () => {
    const deps = depsOf({ many: [] });
    await listCalls(deps, CALLER, { limit: 50, missedOnly: true });
    const where = (deps.db.call.findMany as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      where: { status: string };
    };
    expect(where.where.status).toBe("MISSED");
  });
});

describe("missedCallCount", () => {
  const missed = (id: string, conversationId: string, at: string) => ({
    id,
    conversationId,
    createdAt: new Date(at),
  });

  it("counts unseen missed calls per chat against the read watermark", async () => {
    const deps = depsOf({
      many: [missed("m1", "c1", "2026-09-29T10:00:00.000Z"), missed("m2", "c1", "2026-09-29T09:00:00.000Z")],
      members: [{ conversationId: "c1", lastReadAt: new Date("2026-09-29T09:30:00.000Z") }],
    });
    expect(await missedCallCount(deps, CALLEE)).toEqual({ count: 1 });
  });

  it("ignores calls the viewer placed themselves", async () => {
    const deps = depsOf({ many: [] });
    await missedCallCount(deps, CALLEE);
    const where = (deps.db.call.findMany as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      where: { status: string; callerId: { not: string } };
    };
    expect(where.where).toMatchObject({ status: "MISSED", callerId: { not: CALLEE } });
  });

  it("is zero when nothing missed exists, without touching the members table", async () => {
    const deps = depsOf({ many: [] });
    expect(await missedCallCount(deps, CALLEE)).toEqual({ count: 0 });
    expect(deps.db.conversationMember.findMany).not.toHaveBeenCalled();
  });
});

describe("sweepStuckRings", () => {
  it("expires an unanswered ring as a missed call", async () => {
    const stale = callRow({ createdAt: new Date(Date.now() - 60_000) });
    const deps = depsOf({ many: [stale], updated: { ...stale, status: "MISSED", declineReason: "MISSED" } });
    expect(await sweepStuckRings(deps)).toBe(1);
    expect(callWrites(deps)[0]).toMatchObject({ status: "MISSED", declineReason: "MISSED" });
    // No control frame: the caller's own devices learn through `call.ended`.
    expect(published(deps).map((e) => e.type)).toEqual(["call.ended", "call.ended"]);
  });

  it("leaves a ring that is still inside the timeout alone", async () => {
    const deps = depsOf({ many: [] });
    expect(await sweepStuckRings(deps)).toBe(0);
    const where = (deps.db.call.findMany as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      where: { status: string };
    };
    expect(where.where.status).toBe("RINGING");
  });
});
