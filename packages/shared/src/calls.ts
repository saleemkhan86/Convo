import { z } from "zod";

/**
 * Calling contracts (Phase 5F). Media flows peer-to-peer over WebRTC; the
 * server only owns the call *record* and relays signaling on the existing
 * `/ws` socket. SDP offers/answers and ICE candidates are treated as opaque
 * JSON so a client upgrade never needs a protocol release.
 *
 * Starting and ending a call is REST (retry-safe, and the log must survive a
 * client that dies mid-ring); everything time-critical is the socket.
 */

export const callMediaTypeSchema = z.enum(["VOICE", "VIDEO"]);
export type CallMediaType = z.infer<typeof callMediaTypeSchema>;

export const callStatusSchema = z.enum([
  "RINGING",
  "CONNECTED",
  "ENDED",
  "MISSED",
  "DECLINED",
  "CANCELED",
  "BUSY",
  "FAILED",
]);
export type CallStatus = z.infer<typeof callStatusSchema>;

export const callEndReasonSchema = z.enum([
  "HANG_UP",
  "DECLINED",
  "MISSED",
  "BUSY",
  "CANCELED",
  "DISCONNECTED",
  "FAILED",
]);
export type CallEndReason = z.infer<typeof callEndReasonSchema>;

/** Whose call log entry this is: always derived from the caller, never stored. */
export const callDirectionSchema = z.enum(["INCOMING", "OUTGOING"]);
export type CallDirection = z.infer<typeof callDirectionSchema>;

export const callPeerSchema = z.object({
  userId: z.string(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
});
export type CallPeer = z.infer<typeof callPeerSchema>;

export const callSummarySchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  mediaType: callMediaTypeSchema,
  status: callStatusSchema,
  /** Relative to the reading account, so the same row renders differently in
   * each side's history. */
  direction: callDirectionSchema,
  caller: callPeerSchema,
  callee: callPeerSchema,
  createdAt: z.string().datetime(),
  connectedAt: z.string().datetime().nullable(),
  endedAt: z.string().datetime().nullable(),
  /** Seconds of media; null until the call is over. */
  durationSeconds: z.number().int().nonnegative().nullable(),
  endReason: callEndReasonSchema.nullable(),
});
export type CallSummary = z.infer<typeof callSummarySchema>;

export const callListSchema = z.object({
  items: z.array(callSummarySchema),
  nextCursor: z.string().nullable(),
});
export type CallList = z.infer<typeof callListSchema>;

/** `GET /calls` — the call log, newest first, optionally filtered to one chat. */
export const listCallsQuerySchema = z.object({
  cursor: z.string().max(128).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  conversationId: z.string().optional(),
  /** One filter arrives as a bare query value, several as a repeated param, so
   * both parse into the same array the service reads. */
  direction: z
    .union([z.array(callDirectionSchema), callDirectionSchema])
    .transform((v) => (Array.isArray(v) ? v : [v]))
    .optional(),
  missedOnly: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
});
export type ListCallsQuery = z.infer<typeof listCallsQuerySchema>;

export const missedCallCountSchema = z.object({ count: z.number().int().nonnegative() });
export type MissedCallCount = z.infer<typeof missedCallCountSchema>;

/**
 * ICE servers for one session, minted by the server. TURN entries carry a
 * short-lived, per-call credential — static secrets never leave the API.
 */
export const iceServerSchema = z.object({
  urls: z.union([z.string(), z.array(z.string())]),
  username: z.string().max(256).optional(),
  credential: z.string().max(256).optional(),
});
export type IceServer = z.infer<typeof iceServerSchema>;

export const iceConfigSchema = z.object({
  iceServers: z.array(iceServerSchema),
  /** Seconds this config stays valid; clients refetch before that. */
  ttlSeconds: z.number().int().positive(),
});
export type IceConfig = z.infer<typeof iceConfigSchema>;

export const startCallRequestSchema = z.object({
  conversationId: z.string(),
  mediaType: callMediaTypeSchema.default("VOICE"),
});
export type StartCallRequest = z.infer<typeof startCallRequestSchema>;

/** Response to `POST /calls`: the ringing row plus the ICE config to dial with. */
export const startCallResponseSchema = z.object({
  call: callSummarySchema,
  ice: iceConfigSchema,
});
export type StartCallResponse = z.infer<typeof startCallResponseSchema>;

export const endCallRequestSchema = z.object({
  reason: callEndReasonSchema.default("HANG_UP"),
});
export type EndCallRequest = z.infer<typeof endCallRequestSchema>;

/** `PATCH /calls/:id/me` — the caller's own mic/camera state for the log. */
export const callParticipantStateRequestSchema = z
  .object({
    muted: z.boolean().optional(),
    cameraOff: z.boolean().optional(),
  })
  .refine((v) => v.muted !== undefined || v.cameraOff !== undefined, {
    message: "Nothing to update",
  });
export type CallParticipantStateRequest = z.infer<typeof callParticipantStateRequestSchema>;

/**
 * WebRTC signaling payload. `sdp` is the raw offer/answer; `ice` is one
 * candidate. Both are passed through untouched — the server never parses them.
 */
export const callSignalPayloadSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.enum(["offer", "answer"]),
    sdp: z.string().min(1).max(262144),
  }),
  z.object({
    kind: z.literal("ice"),
    candidate: z.string().min(1).max(2048),
    sdpMid: z.string().max(64).nullable().default(null),
    sdpMLineIndex: z.number().int().nonnegative().nullable().default(null),
  }),
]);
export type CallSignalPayload = z.infer<typeof callSignalPayloadSchema>;

/** Socket protocol: client → server (call control). */
export const wsCallClientEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("call.accept"), callId: z.string() }),
  z.object({
    type: z.literal("call.reject"),
    callId: z.string(),
    /** BUSY answers with `call.busy`; anything else with `call.rejected`. */
    reason: z.enum(["DECLINED", "BUSY"]).default("DECLINED"),
  }),
  z.object({ type: z.literal("call.cancel"), callId: z.string() }),
  z.object({ type: z.literal("call.hangUp"), callId: z.string() }),
  z.object({
    type: z.literal("call.signal"),
    callId: z.string(),
    payload: callSignalPayloadSchema,
  }),
  z.object({
    type: z.literal("call.state"),
    callId: z.string(),
    muted: z.boolean().optional(),
    cameraOff: z.boolean().optional(),
  }),
]);
export type WsCallClientEvent = z.infer<typeof wsCallClientEventSchema>;

/**
 * Socket protocol: server → client (call events). `call.signal` is the only
 * relayed payload; the rest are state transitions both sides must draw.
 */
export const wsCallServerEventSchemas = [
  z.object({ type: z.literal("call.incoming"), call: callSummarySchema }),
  z.object({
    type: z.literal("call.accepted"),
    callId: z.string(),
    conversationId: z.string(),
    acceptedBy: z.string(),
    acceptedAt: z.string().datetime(),
  }),
  z.object({
    type: z.literal("call.rejected"),
    callId: z.string(),
    conversationId: z.string(),
    by: z.string(),
  }),
  z.object({
    type: z.literal("call.busy"),
    callId: z.string(),
    conversationId: z.string(),
    by: z.string(),
  }),
  z.object({
    type: z.literal("call.canceled"),
    callId: z.string(),
    conversationId: z.string(),
    by: z.string(),
  }),
  z.object({
    type: z.literal("call.hangUp"),
    callId: z.string(),
    conversationId: z.string(),
    by: z.string(),
  }),
  z.object({
    type: z.literal("call.signal"),
    callId: z.string(),
    conversationId: z.string(),
    from: z.string(),
    payload: callSignalPayloadSchema,
  }),
  z.object({ type: z.literal("call.ended"), call: callSummarySchema }),
];
export type WsCallServerEvent = z.infer<(typeof wsCallServerEventSchemas)[number]>;
