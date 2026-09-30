import { useEffect, useSyncExternalStore } from "react";
import type {
  CallMediaType,
  CallSignalPayload,
  CallSummary,
  IceConfig,
  WsServerEvent,
} from "@convo/shared";
import { api } from "./api";
import { sendRealtime, useRealtimeEvents } from "./realtime";
import { WEBRTC_UNSUPPORTED, webrtc, webrtcSupported, type MediaStream, type PeerConnection } from "./webrtc";

/**
 * Calling on mobile (Phase 5F). The web app gets this from a React context;
 * here the app has no provider tree, so the engine is a module store that any
 * screen can read and drive — an incoming call has to be able to interrupt
 * whichever screen the user is on.
 *
 * Signaling rides the chat socket (it is already authenticated); accept,
 * decline and hang-up also hit REST so the call log survives a device that
 * dies mid-ring. Media is peer-to-peer: the server never sees a packet.
 */

export type CallPhase = "idle" | "outgoing" | "incoming" | "connecting" | "active" | "ended";

export interface CallState {
  phase: CallPhase;
  call: CallSummary | null;
  /** Seconds since the call connected. */
  seconds: number;
  mediaType: CallMediaType | null;
  muted: boolean;
  cameraOff: boolean;
  error: string | null;
  /** False in builds without the WebRTC native module (Expo Go). */
  supported: boolean;
  /** `streamURL` values for `RTCView`; null until the stream exists. */
  localStreamURL: string | null;
  remoteStreamURL: string | null;
}

let state: CallState = {
  phase: "idle",
  call: null,
  seconds: 0,
  mediaType: null,
  muted: false,
  cameraOff: false,
  error: null,
  supported: false,
  localStreamURL: null,
  remoteStreamURL: null,
};

const listeners = new Set<() => void>();

function patch(next: Partial<CallState>): void {
  state = { ...state, ...next };
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useCallState(): CallState {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

let pc: PeerConnection | null = null;
let ice: IceConfig | null = null;
let localStream: MediaStream | null = null;
let remoteStream: MediaStream | null = null;
/** ICE that lands before the remote description is set, replayed after. */
let queuedIce: Extract<CallSignalPayload, { kind: "ice" }>[] = [];
let haveRemoteDescription = false;
let clock: ReturnType<typeof setInterval> | null = null;
let promoter: ReturnType<typeof setInterval> | null = null;

function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

function streamURL(stream: MediaStream | null): string | null {
  try {
    return stream ? stream.toURL() : null;
  } catch {
    return null;
  }
}

function stopClock() {
  if (clock !== null) clearInterval(clock);
  clock = null;
}

/** The clock reads the record's connect time, so it survives a relaunch. */
function startClock() {
  stopClock();
  const connectedAt = state.call?.connectedAt ? Date.parse(state.call.connectedAt) : Date.now();
  const tick = () => patch({ seconds: Math.max(0, Math.round((Date.now() - connectedAt) / 1000)) });
  tick();
  clock = setInterval(tick, 1000);
}

function teardown() {
  stopClock();
  if (promoter !== null) clearInterval(promoter);
  promoter = null;
  pc?.close();
  pc = null;
  haveRemoteDescription = false;
  queuedIce = [];
  for (const track of localStream?.getTracks() ?? []) track.stop();
  localStream = null;
  remoteStream = null;
  patch({
    muted: false,
    cameraOff: false,
    seconds: 0,
    localStreamURL: null,
    remoteStreamURL: null,
  });
}

function sendSignal(callId: string, payload: CallSignalPayload) {
  sendRealtime({ type: "call.signal", callId, payload });
}

function ensurePeerConnection(): PeerConnection | null {
  if (pc) return pc;
  const rtc = webrtc();
  if (!rtc) return null;
  const conn = new rtc.RTCPeerConnection({ iceServers: ice?.iceServers ?? [] });
  conn.onicecandidate = (raw: unknown) => {
    const candidate = (raw as unknown as { candidate?: { candidate?: string; sdpMid?: string | null; sdpMLineIndex?: number | null } | null }).candidate;
    if (!candidate?.candidate || !state.call) return;
    sendSignal(state.call.id, {
      kind: "ice",
      candidate: candidate.candidate,
      sdpMid: candidate.sdpMid ?? null,
      sdpMLineIndex: candidate.sdpMLineIndex ?? null,
    });
  };
  conn.ontrack = (raw: unknown) => {
    const stream = (raw as unknown as { streams?: MediaStream[] }).streams?.[0];
    if (!stream) return;
    remoteStream = stream;
    patch({ remoteStreamURL: streamURL(stream) });
  };
  conn.onconnectionstatechange = () => {
    if (conn.connectionState === "failed") {
      patch({ error: "The connection to the other person dropped." });
    }
  };
  pc = conn;
  return conn;
}

async function openDevices(video: boolean): Promise<MediaStream> {
  const rtc = webrtc();
  if (!rtc) throw new Error(WEBRTC_UNSUPPORTED);
  if (localStream) return localStream;
  try {
    localStream = await rtc.mediaDevices.getUserMedia({
      audio: true,
      video: video ? { facingMode: "user" } : false,
    });
  } catch {
    throw new Error(
      video
        ? "Convo needs the microphone and camera to place a video call."
        : "Convo needs the microphone to place a call.",
    );
  }
  patch({ localStreamURL: streamURL(localStream) });
  return localStream;
}

function addLocalTracks(stream: MediaStream) {
  const conn = ensurePeerConnection();
  if (!conn) return;
  const existing = new Set(conn.getSenders().map((sender) => sender.track?.kind));
  for (const track of stream.getTracks()) {
    if (existing.has(track.kind)) continue;
    conn.addTrack(track, stream);
  }
}

async function flushQueuedIce(conn: PeerConnection) {
  const candidates = queuedIce;
  queuedIce = [];
  for (const item of candidates) {
    try {
      await conn.addIceCandidate({
        candidate: item.candidate,
        sdpMid: item.sdpMid,
        sdpMLineIndex: item.sdpMLineIndex,
      });
    } catch {
      // A stale candidate is worth nothing; the pair still gathers.
    }
  }
}

async function createOffer(callId: string) {
  const conn = ensurePeerConnection();
  if (!conn) throw new Error(WEBRTC_UNSUPPORTED);
  const offer = await conn.createOffer();
  await conn.setLocalDescription(offer);
  sendSignal(callId, { kind: "offer", sdp: String(offer.sdp ?? "") });
}

async function createAnswer(callId: string) {
  const conn = ensurePeerConnection();
  if (!conn) throw new Error(WEBRTC_UNSUPPORTED);
  const answer = await conn.createAnswer();
  await conn.setLocalDescription(answer);
  sendSignal(callId, { kind: "answer", sdp: String(answer.sdp ?? "") });
}

/** `connecting` becomes `active` only once media actually arrives. */
function startPromoter() {
  if (promoter !== null) clearInterval(promoter);
  promoter = setInterval(() => {
    if (state.phase !== "connecting") return;
    const conn = pc;
    if (!conn) return;
    const receiving = conn.getReceivers().some((receiver) => receiver.track && receiver.track.readyState === "live");
    const connected = conn.connectionState === "connected";
    if (receiving || (connected && conn.remoteDescription !== null)) {
      if (promoter !== null) clearInterval(promoter);
      promoter = null;
      patch({ phase: "active" });
      startClock();
    }
  }, 500);
}

function reset() {
  teardown();
  patch({ phase: "idle", call: null, mediaType: null, error: null });
}

function finish(summary: CallSummary) {
  const mine = state.call?.id === summary.id;
  teardown();
  patch({ call: summary });
  if (mine) patch({ phase: "ended" });
}

export async function startCall(conversationId: string, mediaType: CallMediaType): Promise<void> {
  if (state.phase !== "idle" && state.phase !== "ended") return;
  patch({ error: null, mediaType });
  if (!webrtcSupported()) {
    patch({ supported: false, phase: "ended", call: null, error: WEBRTC_UNSUPPORTED });
    return;
  }
  try {
    const stream = await openDevices(mediaType === "VIDEO");
    const result = await api.startCall(conversationId, mediaType);
    ice = result.ice;
    patch({ call: result.call, phase: "outgoing" });
    addLocalTracks(stream);
  } catch (err) {
    teardown();
    patch({ phase: "ended", call: null, error: messageOf(err, "The call could not be placed.") });
  }
}

export async function acceptCall(): Promise<void> {
  const current = state.call;
  if (!current || state.phase !== "incoming") return;
  patch({ error: null });
  if (!webrtcSupported()) {
    patch({ supported: false, error: WEBRTC_UNSUPPORTED });
    return;
  }
  try {
    const [stream, config] = await Promise.all([
      openDevices(current.mediaType === "VIDEO"),
      api.callIceConfig(),
    ]);
    ice = config;
    addLocalTracks(stream);
    const updated = await api.acceptCall(current.id);
    patch({ call: updated, phase: "connecting" });
    startPromoter();
  } catch (err) {
    reset();
    patch({ error: messageOf(err, "The call could not be answered.") });
  }
}

export async function declineCall(): Promise<void> {
  const current = state.call;
  if (!current) return;
  sendRealtime({ type: "call.reject", callId: current.id, reason: "DECLINED" });
  try {
    await api.declineCall(current.id, "DECLINED");
  } catch {
    // The ring may already have expired server-side; the local reset is enough.
  }
  reset();
}

export async function hangUpCall(): Promise<void> {
  const current = state.call;
  if (!current) return;
  // The socket frame is what stops their ringing; REST only writes the log.
  sendRealtime({ type: "call.hangUp", callId: current.id });
  try {
    patch({ call: await api.hangUpCall(current.id) });
  } catch {
    // The terminal `call.ended` frame carries the record instead.
  }
  teardown();
  patch({ phase: "ended" });
}

export async function toggleMute(): Promise<void> {
  const next = !state.muted;
  patch({ muted: next });
  for (const track of localStream?.getAudioTracks() ?? []) track.enabled = !next;
  const current = state.call;
  if (current) {
    sendRealtime({ type: "call.state", callId: current.id, muted: next });
    await api.setCallState(current.id, { muted: next }).catch(() => {});
  }
}

export async function toggleCamera(): Promise<void> {
  const next = !state.cameraOff;
  patch({ cameraOff: next });
  for (const track of localStream?.getVideoTracks() ?? []) track.enabled = !next;
  const current = state.call;
  if (current) {
    sendRealtime({ type: "call.state", callId: current.id, cameraOff: next });
    await api.setCallState(current.id, { cameraOff: next }).catch(() => {});
  }
}

/** Close the "call ended" card. */
export function dismissCall() {
  reset();
}

export async function handleCallEvent(event: WsServerEvent): Promise<void> {
  switch (event.type) {
    case "call.incoming": {
      if (state.phase !== "idle" && state.phase !== "ended") {
        // Already on a call: answer the ring with busy so the caller learns
        // now rather than after the ring timeout.
        sendRealtime({ type: "call.reject", callId: event.call.id, reason: "BUSY" });
        return;
      }
      patch({ call: event.call, mediaType: event.call.mediaType, phase: "incoming", error: null });
      return;
    }
    case "call.accepted": {
      const current = state.call;
      if (!current || current.id !== event.callId) return;
      if (current.caller.userId !== event.acceptedBy) return;
      patch({ phase: "connecting" });
      startPromoter();
      try {
        await createOffer(current.id);
      } catch {
        patch({ error: "Could not start the media session." });
      }
      return;
    }
    case "call.rejected":
    case "call.busy": {
      const current = state.call;
      if (!current || current.id !== event.callId) return;
      patch({
        error: event.type === "call.busy" ? "They're on another call." : "The call was declined.",
      });
      finish({ ...current, status: event.type === "call.busy" ? "BUSY" : "DECLINED" });
      return;
    }
    case "call.canceled": {
      if (state.call?.id !== event.callId) return;
      reset();
      return;
    }
    case "call.hangUp": {
      if (state.call?.id !== event.callId) return;
      teardown();
      patch({ phase: "ended" });
      return;
    }
    case "call.ended": {
      finish(event.call);
      return;
    }
    case "call.signal": {
      const current = state.call;
      if (!current || current.id !== event.callId) return;
      const conn = ensurePeerConnection();
      if (!conn) return;
      const payload = event.payload;
      if (payload.kind === "ice") {
        if (!haveRemoteDescription) {
          queuedIce.push(payload);
          return;
        }
        try {
          await conn.addIceCandidate({
            candidate: payload.candidate,
            sdpMid: payload.sdpMid,
            sdpMLineIndex: payload.sdpMLineIndex,
          });
        } catch {
          // Candidate for a session that already moved on.
        }
        return;
      }
      try {
        await conn.setRemoteDescription({ type: payload.kind, sdp: payload.sdp });
        haveRemoteDescription = true;
        await flushQueuedIce(conn);
        if (payload.kind === "offer") await createAnswer(current.id);
      } catch {
        patch({ error: "The media session could not be established." });
      }
      return;
    }
    default:
      return;
  }
}

/**
 * Mounts the engine once for the whole app: it feeds socket events in and
 * publishes the build's WebRTC support. Call it from a component that is
 * always rendered.
 */
export function useCallHost(): void {
  useEffect(() => {
    patch({ supported: webrtcSupported() });
  }, []);
  useRealtimeEvents((event) => {
    void handleCallEvent(event);
  });
}

/** Who the overlay should name: the other side, whichever end we're on. */
export function callPeerLabel(call: CallSummary | null): string {
  if (!call) return "";
  return (call.direction === "OUTGOING" ? call.callee : call.caller).displayName ?? "Convo user";
}

/** mm:ss for the in-call timer, h:mm:ss once it passes an hour. */
export function formatCallDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const pad = (n: number) => String(n).padStart(2, "0");
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(s % 60)}` : `${minutes}:${pad(s % 60)}`;
}
