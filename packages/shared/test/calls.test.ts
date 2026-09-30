import { describe, expect, it } from "vitest";
import {
  callParticipantStateRequestSchema,
  callSignalPayloadSchema,
  callSummarySchema,
  iceConfigSchema,
  listCallsQuerySchema,
  startCallRequestSchema,
  wsCallClientEventSchema,
} from "../src/calls";
import { wsClientEventSchema, wsServerEventSchema } from "../src/chats";

/**
 * Phase 5F contract tests: the call log, the signaling payload both clients
 * pass through untouched, and the socket union both ends speak. The interesting
 * cases are the ones a hostile or confused client can produce — a second dial
 * after the first is clamped, an empty SDP, a control patch with nothing in it.
 */

const callBase = {
  id: "call1",
  conversationId: "c1",
  mediaType: "VOICE",
  status: "RINGING",
  direction: "OUTGOING",
  caller: { userId: "u1", displayName: "Sammy Khan", avatarUrl: null },
  callee: { userId: "u2", displayName: null, avatarUrl: null },
  createdAt: "2026-09-29T10:00:00.000Z",
  connectedAt: null,
  endedAt: null,
  durationSeconds: null,
  endReason: null,
};

describe("callSummarySchema", () => {
  it("accepts a ringing record with both peers resolved", () => {
    const parsed = callSummarySchema.parse(callBase);
    expect(parsed.direction).toBe("OUTGOING");
    expect(parsed.callee.displayName).toBeNull();
  });

  it("requires ISO timestamps — the clients diff them for the log", () => {
    expect(callSummarySchema.safeParse({ ...callBase, createdAt: "yesterday" }).success).toBe(false);
  });

  it("only knows the eight statuses the state machine can reach", () => {
    expect(callSummarySchema.safeParse({ ...callBase, status: "WAITING" }).success).toBe(false);
    expect(callSummarySchema.safeParse({ ...callBase, status: "MISSED" }).success).toBe(true);
  });

  it("rejects an end reason the schema never stores", () => {
    expect(callSummarySchema.safeParse({ ...callBase, endReason: "NOPE" }).success).toBe(false);
  });
});

describe("listCallsQuerySchema", () => {
  it("defaults to the first page of fifty", () => {
    expect(listCallsQuerySchema.parse({})).toEqual({ limit: 50 });
  });

  it("coerces the query string and refuses an oversized page", () => {
    expect(listCallsQuerySchema.parse({ limit: "12" }).limit).toBe(12);
    expect(listCallsQuerySchema.safeParse({ limit: 5000 }).success).toBe(false);
    expect(listCallsQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
  });

  it("reads missedOnly from the query string, not from a bare flag", () => {
    expect(listCallsQuerySchema.parse({ missedOnly: "true" }).missedOnly).toBe(true);
    expect(listCallsQuerySchema.parse({ missedOnly: "false" }).missedOnly).toBe(false);
    expect(listCallsQuerySchema.safeParse({ missedOnly: "yes" }).success).toBe(false);
  });

  it("accepts a direction filter of one or both sides", () => {
    expect(listCallsQuerySchema.parse({ direction: ["INCOMING"] }).direction).toEqual(["INCOMING"]);
    expect(listCallsQuerySchema.parse({ direction: ["INCOMING", "OUTGOING"] }).direction).toEqual([
      "INCOMING",
      "OUTGOING",
    ]);
    // A query string carrying one value gives a bare string, not a one-item array.
    expect(listCallsQuerySchema.parse({ direction: "OUTGOING" }).direction).toEqual(["OUTGOING"]);
    expect(listCallsQuerySchema.safeParse({ direction: ["SIDEWAYS"] }).success).toBe(false);
    expect(listCallsQuerySchema.safeParse({ direction: "SIDEWAYS" }).success).toBe(false);
  });
});

describe("startCallRequestSchema", () => {
  it("dials a voice call when the client does not say otherwise", () => {
    expect(startCallRequestSchema.parse({ conversationId: "c1" })).toEqual({
      conversationId: "c1",
      mediaType: "VOICE",
    });
  });

  it("has no way to ask for anything but voice or video", () => {
    expect(startCallRequestSchema.safeParse({ conversationId: "c1", mediaType: "SCREEN" }).success).toBe(false);
  });
});

describe("callSignalPayloadSchema", () => {
  it("carries an SDP blob through untouched", () => {
    const payload = callSignalPayloadSchema.parse({ kind: "offer", sdp: "v=0\r\n" });
    expect(payload).toEqual({ kind: "offer", sdp: "v=0\r\n" });
  });

  it("refuses an empty or oversized SDP — the relay must not buffer junk", () => {
    expect(callSignalPayloadSchema.safeParse({ kind: "offer", sdp: "" }).success).toBe(false);
    expect(callSignalPayloadSchema.safeParse({ kind: "answer", sdp: "x".repeat(262145) }).success).toBe(false);
  });

  it("fills in the optional ICE fields as null so clients can pass them straight through", () => {
    const parsed = callSignalPayloadSchema.parse({ kind: "ice", candidate: "candidate:1 1 udp 4128" });
    expect(parsed).toEqual({
      kind: "ice",
      candidate: "candidate:1 1 udp 4128",
      sdpMid: null,
      sdpMLineIndex: null,
    });
  });

  it("rejects a negative media-line index", () => {
    expect(
      callSignalPayloadSchema.safeParse({ kind: "ice", candidate: "candidate:1", sdpMLineIndex: -1 }).success,
    ).toBe(false);
  });

  it("does not invent new signal kinds", () => {
    expect(callSignalPayloadSchema.safeParse({ kind: "restart", sdp: "v=0" }).success).toBe(false);
  });
});

describe("callParticipantStateRequestSchema", () => {
  it("takes each control on its own", () => {
    expect(callParticipantStateRequestSchema.parse({ muted: true })).toEqual({ muted: true });
    expect(callParticipantStateRequestSchema.parse({ cameraOff: false })).toEqual({ cameraOff: false });
  });

  it("rejects an empty patch rather than writing a no-op row", () => {
    expect(callParticipantStateRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe("iceConfigSchema", () => {
  it("accepts both the string and array forms of urls, as RTCPeerConnection does", () => {
    const parsed = iceConfigSchema.parse({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }, { urls: ["turn:a.example", "turn:b.example"], username: "1:u", credential: "c" }],
      ttlSeconds: 3600,
    });
    expect(parsed.iceServers).toHaveLength(2);
  });

  it("requires a positive lifetime so clients know when to refetch", () => {
    expect(iceConfigSchema.safeParse({ iceServers: [], ttlSeconds: 0 }).success).toBe(false);
  });
});

describe("call socket events", () => {
  it("accepts every client control frame", () => {
    expect(wsCallClientEventSchema.parse({ type: "call.accept", callId: "call1" }).type).toBe("call.accept");
    expect(wsCallClientEventSchema.parse({ type: "call.reject", callId: "call1" }).type).toBe("call.reject");
    expect(wsCallClientEventSchema.parse({ type: "call.hangUp", callId: "call1" }).type).toBe("call.hangUp");
    expect(wsCallClientEventSchema.parse({ type: "call.cancel", callId: "call1" }).type).toBe("call.cancel");
  });

  it("defaults a rejection to DECLINED, with BUSY as the only alternative", () => {
    expect(wsCallClientEventSchema.parse({ type: "call.reject", callId: "call1" })).toEqual({
      type: "call.reject",
      callId: "call1",
      reason: "DECLINED",
    });
    expect(
      wsCallClientEventSchema.safeParse({ type: "call.reject", callId: "call1", reason: "MISSED" }).success,
    ).toBe(false);
  });

  it("lets a signaling frame ride the same union as typing and receipts", () => {
    const parsed = wsClientEventSchema.parse({
      type: "call.signal",
      callId: "call1",
      payload: { kind: "ice", candidate: "candidate:1" },
    });
    expect(parsed.type).toBe("call.signal");
  });

  it("delivers the ringing record to the callee and the terminal record to both", () => {
    const incoming = wsServerEventSchema.parse({ type: "call.incoming", call: callBase });
    expect(incoming.type).toBe("call.incoming");
    const ended = wsServerEventSchema.parse({
      type: "call.ended",
      call: { ...callBase, status: "ENDED", endReason: "HANG_UP", durationSeconds: 42 },
    });
    expect(ended.type).toBe("call.ended");
  });

  it("never trusts a client-sent server frame", () => {
    expect(wsClientEventSchema.safeParse({ type: "call.incoming", call: callBase }).success).toBe(false);
  });
});
