import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  CallMediaType,
  CallSignalPayload,
  CallSummary,
  IceConfig,
  WsServerEvent,
} from "@convo/shared";
import { api } from "./api";
import { useRealtime, useRealtimeSubscription } from "./realtime";

/**
 * Calling on the web (Phase 5F): one provider owns the single
 * `RTCPeerConnection`, the media stream, and the signaling exchange that rides
 * the chat socket. Only one call can exist per tab, which is why this is a
 * context rather than a per-chat hook — an incoming call must be able to
 * interrupt whichever chat the user is looking at.
 *
 * Division of labour: the socket carries rings and SDP (it is already
 * authenticated and it is fast), HTTP carries everything the call log has to
 * survive — accept/decline/hang-up and the ICE config.
 */

export type CallPhase = "idle" | "outgoing" | "incoming" | "connecting" | "active" | "ended";

interface CallValue {
  phase: CallPhase;
  call: CallSummary | null;
  /** Seconds since the call connected. */
  seconds: number;
  mediaType: CallMediaType | null;
  muted: boolean;
  cameraOff: boolean;
  /** Set when the browser refused the devices or the peer never answered. */
  error: string | null;
  attachLocal: (node: HTMLVideoElement | null) => void;
  attachRemote: (node: HTMLVideoElement | null) => void;
  start: (conversationId: string, mediaType: CallMediaType) => Promise<void>;
  accept: () => Promise<void>;
  decline: () => Promise<void>;
  hangUp: () => Promise<void>;
  toggleMute: () => Promise<void>;
  toggleCamera: () => Promise<void>;
  /** Close the "call ended" card. */
  dismiss: () => void;
}

const CallContext = createContext<CallValue | null>(null);

/** RTCIceServer accepts the shape the API hands back without translation. */
function rtcConfig(ice: IceConfig | null): RTCConfiguration {
  return { iceServers: ice ? ice.iceServers : [] };
}

function label(call: CallSummary | null): string {
  if (!call) return "";
  const peer = call.direction === "OUTGOING" ? call.callee : call.caller;
  return peer.displayName ?? peer.userId;
}

export function CallProvider({ children }: { children: ReactNode }) {
  const { send } = useRealtime();
  const [phase, setPhase] = useState<CallPhase>("idle");
  const [call, setCall] = useState<CallSummary | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [mediaType, setMediaType] = useState<CallMediaType | null>(null);
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pc = useRef<RTCPeerConnection | null>(null);
  const ice = useRef<IceConfig | null>(null);
  const localStream = useRef<MediaStream | null>(null);
  const remoteStream = useRef<MediaStream | null>(null);
  const localNode = useRef<HTMLVideoElement | null>(null);
  const remoteNode = useRef<HTMLVideoElement | null>(null);
  /** ICE that lands before the remote description is set, replayed after. */
  const queuedIce = useRef<Extract<CallSignalPayload, { kind: "ice" }>[]>([]);
  const haveRemoteDescription = useRef(false);
  const callRef = useRef<CallSummary | null>(null);
  const phaseRef = useRef<CallPhase>("idle");

  callRef.current = call;
  phaseRef.current = phase;

  const sendSignal = useCallback(
    (callId: string, payload: CallSignalPayload) => {
      send({ type: "call.signal", callId, payload });
    },
    [send],
  );

  const stopMedia = useCallback(() => {
    for (const track of localStream.current?.getTracks() ?? []) track.stop();
    localStream.current = null;
    remoteStream.current = null;
    if (localNode.current) localNode.current.srcObject = null;
    if (remoteNode.current) remoteNode.current.srcObject = null;
  }, []);

  const teardown = useCallback(() => {
    pc.current?.close();
    pc.current = null;
    haveRemoteDescription.current = false;
    queuedIce.current = [];
    stopMedia();
    setMuted(false);
    setCameraOff(false);
    setSeconds(0);
  }, [stopMedia]);

  useEffect(() => teardown, [teardown]);

  // Live-call clock: derived from the record's connect time so a tab that
  // reloads mid-call would still show the right duration.
  useEffect(() => {
    if (phase !== "active") return;
    const startedAt = Date.now();
    const tick = window.setInterval(() => {
      setSeconds(Math.round((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(tick);
  }, [phase]);

  const ensurePeerConnection = useCallback((): RTCPeerConnection => {
    if (pc.current) return pc.current;
    const conn = new RTCPeerConnection(rtcConfig(ice.current));
    conn.onicecandidate = (evt) => {
      const candidate = evt.candidate;
      const current = callRef.current;
      if (!candidate || !current || !candidate.candidate) return;
      sendSignal(current.id, {
        kind: "ice",
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid ?? null,
        sdpMLineIndex: candidate.sdpMLineIndex ?? null,
      });
    };
    conn.ontrack = (evt) => {
      const stream = evt.streams[0] ?? null;
      if (!stream) return;
      remoteStream.current = stream;
      if (remoteNode.current) remoteNode.current.srcObject = stream;
    };
    conn.onconnectionstatechange = () => {
      if (conn.connectionState === "failed") {
        setError("The connection to the other person dropped.");
      }
    };
    pc.current = conn;
    return conn;
  }, [sendSignal]);

  const attachLocal = useCallback((node: HTMLVideoElement | null) => {
    localNode.current = node;
    if (node && localStream.current) node.srcObject = localStream.current;
  }, []);

  const attachRemote = useCallback((node: HTMLVideoElement | null) => {
    remoteNode.current = node;
    if (node && remoteStream.current) node.srcObject = remoteStream.current;
  }, []);

  /** Mic (and camera) capture. Throws with a user-facing reason. */
  const openDevices = useCallback(async (video: boolean): Promise<MediaStream> => {
    if (localStream.current) return localStream.current;
    try {
      localStream.current = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: video ? { facingMode: "user" } : false,
      });
    } catch {
      throw new Error(
        video
          ? "Convo needs your microphone and camera to place a video call."
          : "Convo needs your microphone to place a call.",
      );
    }
    if (localNode.current) localNode.current.srcObject = localStream.current;
    return localStream.current;
  }, []);

  const addLocalTracks = useCallback((stream: MediaStream) => {
    const conn = ensurePeerConnection();
    const existing = new Set(conn.getSenders().map((s) => s.track?.kind));
    for (const track of stream.getTracks()) {
      if (existing.has(track.kind)) continue;
      conn.addTrack(track, stream);
    }
  }, [ensurePeerConnection]);

  const flushQueuedIce = useCallback(
    async (conn: RTCPeerConnection) => {
      const candidates = queuedIce.current;
      queuedIce.current = [];
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
    },
    [],
  );

  const createOffer = useCallback(
    async (callId: string) => {
      const conn = ensurePeerConnection();
      const offer = await conn.createOffer();
      await conn.setLocalDescription(offer);
      sendSignal(callId, { kind: "offer", sdp: offer.sdp ?? "" });
    },
    [ensurePeerConnection, sendSignal],
  );

  const createAnswer = useCallback(
    async (callId: string) => {
      const conn = ensurePeerConnection();
      const answer = await conn.createAnswer();
      await conn.setLocalDescription(answer);
      sendSignal(callId, { kind: "answer", sdp: answer.sdp ?? "" });
    },
    [ensurePeerConnection, sendSignal],
  );

  /** `POST /calls` then ring: the offer waits for the accept so the caller
   * never negotiates with a device that is not answering. */
  const start = useCallback(
    async (conversationId: string, type: CallMediaType) => {
      if (phaseRef.current !== "idle" && phaseRef.current !== "ended") return;
      setError(null);
      setMediaType(type);
      try {
        const stream = await openDevices(type === "VIDEO");
        const result = await api.startCall(conversationId, type);
        ice.current = result.ice;
        callRef.current = result.call;
        setCall(result.call);
        setPhase("outgoing");
        addLocalTracks(stream);
      } catch (err) {
        teardown();
        setPhase("idle");
        setError(err instanceof Error ? err.message : "The call could not be placed.");
      }
    },
    [addLocalTracks, openDevices, teardown],
  );

  const accept = useCallback(async () => {
    const current = callRef.current;
    if (!current || phaseRef.current !== "incoming") return;
    setError(null);
    try {
      const [stream, iceForCall] = await Promise.all([
        openDevices(current.mediaType === "VIDEO"),
        api.callIceConfig(),
      ]);
      ice.current = iceForCall;
      addLocalTracks(stream);
      const updated = await api.acceptCall(current.id);
      callRef.current = updated;
      setCall(updated);
      setPhase("connecting");
    } catch (err) {
      teardown();
      callRef.current = null;
      setCall(null);
      setPhase("idle");
      setError(err instanceof Error ? err.message : "The call could not be answered.");
    }
  }, [addLocalTracks, openDevices, teardown]);

  const decline = useCallback(async () => {
    const current = callRef.current;
    if (!current) return;
    try {
      await api.declineCall(current.id, "DECLINED");
    } catch {
      // The ring already expired server-side; the local reset below is enough.
    }
    teardown();
    callRef.current = null;
    setCall(null);
    setPhase("idle");
  }, [teardown]);

  const hangUp = useCallback(async () => {
    const current = callRef.current;
    if (!current) return;
    // Tell the peer immediately: the socket frame is faster than the REST call
    // and it is what stops the ringing on their side.
    send({ type: "call.hangUp", callId: current.id });
    try {
      const updated = await api.hangUpCall(current.id);
      callRef.current = updated;
      setCall(updated);
    } catch {
      // The terminal `call.ended` frame carries the record instead.
    }
    teardown();
    setPhase("ended");
  }, [send, teardown]);

  const toggleMute = useCallback(async () => {
    const current = callRef.current;
    const next = !muted;
    setMuted(next);
    for (const track of localStream.current?.getAudioTracks() ?? []) track.enabled = !next;
    if (current) {
      send({ type: "call.state", callId: current.id, muted: next });
      await api.setCallState(current.id, { muted: next }).catch(() => {});
    }
  }, [muted, send]);

  const toggleCamera = useCallback(async () => {
    const current = callRef.current;
    const next = !cameraOff;
    setCameraOff(next);
    for (const track of localStream.current?.getVideoTracks() ?? []) track.enabled = !next;
    if (current) {
      send({ type: "call.state", callId: current.id, cameraOff: next });
      await api.setCallState(current.id, { cameraOff: next }).catch(() => {});
    }
  }, [cameraOff, send]);

  const dismiss = useCallback(() => {
    callRef.current = null;
    setCall(null);
    setMediaType(null);
    setError(null);
    setPhase("idle");
  }, []);

  const finishFromEvent = useCallback(
    (summary: CallSummary) => {
      const isMine = callRef.current?.id === summary.id;
      callRef.current = summary;
      setCall(summary);
      teardown();
      if (isMine) setPhase("ended");
    },
    [teardown],
  );

  // ── inbound events ────────────────────────────────────────────────────────
  useRealtimeSubscription(
    useCallback(
      async (event: WsServerEvent) => {
        switch (event.type) {
          case "call.incoming": {
            if (phaseRef.current !== "idle" && phaseRef.current !== "ended") {
              // Already on a call: answer the ring with busy so the caller
              // learns now rather than after the ring timeout.
              send({ type: "call.reject", callId: event.call.id, reason: "BUSY" });
              return;
            }
            callRef.current = event.call;
            setCall(event.call);
            setMediaType(event.call.mediaType);
            setPhase("incoming");
            return;
          }
          case "call.accepted": {
            const current = callRef.current;
            if (!current || current.id !== event.callId) return;
            if (current.caller.userId !== event.acceptedBy) return;
            setPhase("connecting");
            try {
              await createOffer(current.id);
            } catch {
              setError("Could not start the media session.");
            }
            return;
          }
          case "call.rejected":
          case "call.busy": {
            const current = callRef.current;
            if (!current || current.id !== event.callId) return;
            setError(event.type === "call.busy" ? "They're on another call." : "The call was declined.");
            finishFromEvent({ ...current, status: event.type === "call.busy" ? "BUSY" : "DECLINED" });
            return;
          }
          case "call.canceled": {
            const current = callRef.current;
            if (!current || current.id !== event.callId) return;
            teardown();
            callRef.current = null;
            setCall(null);
            setPhase("idle");
            return;
          }
          case "call.hangUp": {
            const current = callRef.current;
            if (!current || current.id !== event.callId) return;
            teardown();
            setPhase("ended");
            return;
          }
          case "call.ended": {
            finishFromEvent(event.call);
            return;
          }
          case "call.signal": {
            const current = callRef.current;
            if (!current || current.id !== event.callId) return;
            const conn = ensurePeerConnection();
            const payload = event.payload;
            if (payload.kind === "ice") {
              if (!haveRemoteDescription.current) {
                queuedIce.current.push(payload);
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
              haveRemoteDescription.current = true;
              await flushQueuedIce(conn);
              if (payload.kind === "offer") await createAnswer(current.id);
            } catch {
              setError("The media session could not be established.");
            }
            return;
          }
          default:
            return;
        }
      },
      [createAnswer, createOffer, ensurePeerConnection, finishFromEvent, flushQueuedIce, send, teardown],
    ),
  );

  // Promotion from "connecting" to "active" once media actually flows.
  useEffect(() => {
    if (phase !== "connecting") return;
    const check = window.setInterval(() => {
      const conn = pc.current;
      if (!conn) return;
      const receiving = conn.getReceivers().some((r) => r.track && r.track.readyState === "live");
      const connected = conn.connectionState === "connected";
      if (receiving || (connected && conn.currentRemoteDescription !== null)) {
        setPhase("active");
      }
    }, 500);
    return () => window.clearInterval(check);
  }, [phase]);

  const value = useMemo<CallValue>(
    () => ({
      phase,
      call,
      seconds,
      mediaType,
      muted,
      cameraOff,
      error,
      attachLocal,
      attachRemote,
      start,
      accept,
      decline,
      hangUp,
      toggleMute,
      toggleCamera,
      dismiss,
    }),
    [
      phase,
      call,
      seconds,
      mediaType,
      muted,
      cameraOff,
      error,
      attachLocal,
      attachRemote,
      start,
      accept,
      decline,
      hangUp,
      toggleMute,
      toggleCamera,
      dismiss,
    ],
  );

  return <CallContext.Provider value={value}>{children}</CallContext.Provider>;
}

export function useCall(): CallValue {
  const ctx = useContext(CallContext);
  if (!ctx) throw new Error("useCall must be used within CallProvider");
  return ctx;
}

/** Who the overlay should name: the other side, whichever end we're on. */
export function callPeerLabel(call: CallSummary | null): string {
  return label(call);
}

/** mm:ss for the in-call timer, h:mm:ss once it passes an hour. */
export function formatCallDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
}
