import type { ReactNode } from "react";
import { callPeerLabel, formatCallDuration, useCall } from "../lib/calls";
import {
  MicIcon,
  MicOffIcon,
  PhoneIcon,
  PhoneOffIcon,
  VideoIcon,
  VideoOffIcon,
} from "./icons";
import { cx } from "./ui";

/**
 * The one call surface (Phase 5F): a full-screen card that covers whichever
 * chat the user was in. It serves all five phases — outgoing ring, incoming
 * ring, connecting, live, and the ended summary — because the controls only
 * differ by a couple of buttons, and mounting one element keeps the remote
 * `MediaStream` (and its audio) alive across transitions.
 */
export function CallOverlay() {
  const {
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
  } = useCall();

  if (!call || phase === "idle") return null;

  const name = callPeerLabel(call) || "Your contact";
  const isVideo = mediaType === "VIDEO";
  const showVideo = isVideo && (phase === "connecting" || phase === "active");

  const statusLine =
    phase === "outgoing"
      ? "Ringing…"
      : phase === "incoming"
        ? `Incoming ${isVideo ? "video" : "voice"} call`
        : phase === "connecting"
          ? "Connecting…"
          : phase === "active"
            ? formatCallDuration(seconds)
            : "Call ended";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/85 p-4 backdrop-blur-sm">
      <div className="w-full max-w-sm animate-rise overflow-hidden rounded-3xl border border-night-border bg-night-surface shadow-2xl">
        <div className="relative flex h-56 items-center justify-center bg-night-raised">
          {showVideo ? (
            <video ref={attachRemote} autoPlay playsInline className="h-full w-full object-cover" />
          ) : (
            <span className="flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-br from-iris-500 to-signal-400 text-2xl font-bold text-white">
              {name.replace(/[^\p{L}\p{N}]/gu, "").charAt(0).toUpperCase() || "?"}
            </span>
          )}
          {/* Audio-only calls still need an element to play the remote stream. */}
          {!showVideo && <audio ref={attachRemote} autoPlay />}
          {showVideo && (
            <video
              ref={attachLocal}
              autoPlay
              playsInline
              muted
              className={cx(
                "absolute bottom-3 right-3 h-24 w-20 rounded-xl border border-white/20 bg-ink-950 object-cover",
                cameraOff && "opacity-40",
              )}
            />
          )}
          {isVideo && phase === "active" && cameraOff && (
            <span className="absolute bottom-3 left-3 rounded-full bg-ink-950/70 px-2.5 py-1 text-[11px] font-semibold text-ink-200">
              Camera off
            </span>
          )}
        </div>

        <div className="px-6 pb-6 pt-4 text-center">
          <p className="truncate text-lg font-bold text-white">{name}</p>
          <p className="mt-1 text-sm text-ink-400">{statusLine}</p>
          {error && <p className="mt-2 text-xs text-rose-400">{error}</p>}

          <div className="mt-6 flex items-center justify-center gap-4">
            {phase === "incoming" ? (
              <>
                <CallButton tone="danger" label="Decline" onClick={() => void decline()}>
                  <PhoneOffIcon className="h-5 w-5" />
                </CallButton>
                <CallButton tone="success" label="Accept" onClick={() => void accept()}>
                  <PhoneIcon className="h-5 w-5" />
                </CallButton>
              </>
            ) : phase === "ended" ? (
              <>
                <CallButton label="Close" onClick={dismiss}>
                  <span className="text-xs font-semibold">Close</span>
                </CallButton>
                <CallButton
                  tone="success"
                  label="Call back"
                  onClick={() => void start(call.conversationId, call.mediaType)}
                >
                  <PhoneIcon className="h-5 w-5" />
                </CallButton>
              </>
            ) : (
              <>
                <CallButton
                  tone={muted ? "warn" : "neutral"}
                  label={muted ? "Unmute" : "Mute"}
                  onClick={() => void toggleMute()}
                >
                  {muted ? <MicOffIcon className="h-5 w-5" /> : <MicIcon className="h-5 w-5" />}
                </CallButton>
                {isVideo && (
                  <CallButton
                    tone={cameraOff ? "warn" : "neutral"}
                    label={cameraOff ? "Camera on" : "Camera off"}
                    onClick={() => void toggleCamera()}
                  >
                    {cameraOff ? <VideoOffIcon className="h-5 w-5" /> : <VideoIcon className="h-5 w-5" />}
                  </CallButton>
                )}
                <CallButton tone="danger" label="Hang up" onClick={() => void hangUp()}>
                  <PhoneOffIcon className="h-5 w-5" />
                </CallButton>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function CallButton({
  tone = "neutral",
  label,
  onClick,
  children,
}: {
  tone?: "neutral" | "danger" | "success" | "warn";
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cx(
        "flex h-14 w-14 items-center justify-center rounded-full text-white transition-transform hover:scale-105 active:scale-95",
        tone === "neutral" && "bg-white/10 hover:bg-white/20",
        tone === "danger" && "bg-rose-500 hover:bg-rose-600",
        tone === "success" && "bg-emerald-500 hover:bg-emerald-600",
        tone === "warn" && "bg-amber-500 hover:bg-amber-600",
      )}
    >
      {children}
    </button>
  );
}
