import { Modal, Pressable, Text, View } from "react-native";
import {
  acceptCall,
  callPeerLabel,
  declineCall,
  dismissCall,
  formatCallDuration,
  hangUpCall,
  toggleCamera,
  toggleMute,
  useCallHost,
  useCallState,
  type CallState,
} from "../calls";
import { avatarInitial } from "../chatUtils";
import { Avatar, usePalette } from "./ui";
import { colors, radius, spacing, type Palette } from "../theme";
import { webrtc } from "../webrtc";

/**
 * The in-call surface (Phase 5F): one full-screen modal that renders every
 * call phase, mounted once at the app root so a ring can interrupt any screen.
 * Video uses `RTCView` when the native module is present; a voice call only
 * needs the stream to exist, so the same layout works without it.
 */

function statusLine(state: CallState): string {
  switch (state.phase) {
    case "outgoing":
      return "Ringing…";
    case "incoming":
      return state.mediaType === "VIDEO" ? "Incoming video call" : "Incoming voice call";
    case "connecting":
      return "Connecting…";
    case "active":
      return formatCallDuration(state.seconds);
    case "ended":
      return callOutcomeLabel(state);
    default:
      return "";
  }
}

function callOutcomeLabel(state: CallState): string {
  if (state.error) return state.error;
  switch (state.call?.status) {
    case "MISSED":
      return "Missed call";
    case "DECLINED":
      return "Call declined";
    case "BUSY":
      return "Busy";
    case "CANCELED":
      return "Call cancelled";
    case "ENDED":
      return state.call.durationSeconds
        ? `Call ended · ${formatCallDuration(state.call.durationSeconds)}`
        : "Call ended";
    default:
      return "Call ended";
  }
}

function ControlButton({
  glyph,
  label,
  onPress,
  tone = "neutral",
  disabled,
}: {
  glyph: string;
  label: string;
  onPress: () => void;
  tone?: "neutral" | "danger" | "success" | "active";
  disabled?: boolean;
}) {
  const background =
    tone === "danger"
      ? colors.danger
      : tone === "success"
        ? colors.success
        : tone === "active"
          ? colors.iris600
          : "rgba(255,255,255,0.14)";
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={8}
      style={({ pressed }) => ({
        alignItems: "center",
        gap: 6,
        opacity: disabled ? 0.4 : pressed ? 0.7 : 1,
      })}
    >
      <View
        style={{
          width: 60,
          height: 60,
          borderRadius: radius.pill,
          backgroundColor: background,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text style={{ fontSize: 24 }}>{glyph}</Text>
      </View>
      <Text style={{ fontSize: 11, color: "rgba(255,255,255,0.8)", fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}

function VideoSurface({ palette }: { palette: Palette }) {
  const state = useCallState();
  const RTCView = webrtc()?.RTCView;
  if (!RTCView || state.mediaType !== "VIDEO") return null;
  return (
    <View style={{ flex: 1, minHeight: 320, backgroundColor: palette.bg }}>
      {state.remoteStreamURL ? (
        <RTCView streamURL={state.remoteStreamURL} objectFit="cover" style={{ flex: 1 }} />
      ) : (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <Text style={{ color: palette.textFaint, fontSize: 13 }}>Waiting for their video…</Text>
        </View>
      )}
      {state.localStreamURL && (
        <View
          style={{
            position: "absolute",
            right: spacing.md,
            top: spacing.md,
            width: 104,
            height: 156,
            borderRadius: radius.card,
            overflow: "hidden",
            borderWidth: 2,
            borderColor: "rgba(255,255,255,0.35)",
          }}
        >
          <RTCView streamURL={state.localStreamURL} mirror objectFit="cover" style={{ flex: 1 }} />
        </View>
      )}
    </View>
  );
}

export function CallOverlay() {
  useCallHost();
  const state = useCallState();
  const palette = usePalette();
  const visible = state.phase !== "idle";
  const name = callPeerLabel(state.call);
  const onCall = state.phase === "outgoing" || state.phase === "connecting" || state.phase === "active";

  const dismissOnBack = () => {
    if (state.phase === "ended") dismissCall();
    else if (state.phase === "incoming") void declineCall();
    else void hangUpCall();
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={dismissOnBack}>
      <View
        style={{
          flex: 1,
          backgroundColor: "rgba(9,11,20,0.97)",
          paddingTop: spacing.xl,
          paddingBottom: spacing.xl,
          paddingHorizontal: spacing.lg,
          gap: spacing.lg,
        }}
      >
        <View style={{ alignItems: "center", gap: spacing.md }}>
          {state.mediaType === "VIDEO" && state.remoteStreamURL ? null : (
            <Avatar initial={avatarInitial(name)} size={84} />
          )}
          <Text style={{ fontSize: 20, fontWeight: "800", color: colors.white }}>{name || "Call"}</Text>
          <Text style={{ fontSize: 14, color: state.error ? colors.danger : "rgba(255,255,255,0.7)" }}>
            {statusLine(state)}
          </Text>
          {state.mediaType === "VOICE" && (
            <Text style={{ fontSize: 12, color: "rgba(255,255,255,0.45)" }}>Voice call</Text>
          )}
        </View>

        <VideoSurface palette={palette} />

        <View style={{ flexDirection: "row", justifyContent: "center", alignItems: "flex-end", gap: spacing.lg }}>
          {state.phase === "incoming" ? (
            <>
              <ControlButton glyph="✕" label="Decline" tone="danger" onPress={() => void declineCall()} />
              <ControlButton glyph="📞" label="Accept" tone="success" onPress={() => void acceptCall()} />
            </>
          ) : state.phase === "ended" ? (
            <ControlButton glyph="✓" label="Close" onPress={dismissCall} />
          ) : (
            <>
              <ControlButton
                glyph={state.muted ? "🔇" : "🎙"}
                label={state.muted ? "Unmute" : "Mute"}
                tone={state.muted ? "active" : "neutral"}
                disabled={!onCall}
                onPress={() => void toggleMute()}
              />
              {state.mediaType === "VIDEO" && (
                <ControlButton
                  glyph={state.cameraOff ? "🚫" : "📹"}
                  label={state.cameraOff ? "Camera off" : "Camera on"}
                  tone={state.cameraOff ? "active" : "neutral"}
                  disabled={!onCall}
                  onPress={() => void toggleCamera()}
                />
              )}
              <ControlButton glyph="📵" label="End" tone="danger" onPress={() => void hangUpCall()} />
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}
