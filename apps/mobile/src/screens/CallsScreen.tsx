import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, Text, View } from "react-native";
import type { CallMediaType, CallSummary, WsServerEvent } from "@convo/shared";
import { api } from "../api";
import { formatCallDuration, startCall } from "../calls";
import { useRealtimeEvents } from "../realtime";
import { avatarInitial, errorMessage, relativeTime } from "../chatUtils";
import { Avatar, usePalette } from "../components/ui";
import { WEBRTC_UNSUPPORTED } from "../webrtc";
import { colors, radius, spacing } from "../theme";

/**
 * The mobile call log (Phase 5F). Rows come from the server, so a call made on
 * the web shows up here; dialing a row calls the same engine the chat header
 * uses, which is what makes the overlay appear.
 */
export function CallsScreen({ callSupported }: { callSupported: boolean }) {
  const palette = usePalette();
  const [calls, setCalls] = useState<CallSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [missedOnly, setMissedOnly] = useState(false);
  const [missed, setMissed] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (replace: boolean) => {
      setLoading(true);
      setError(null);
      try {
        const [page, count] = await Promise.all([
          api.callHistory({ missedOnly, cursor: replace ? undefined : (cursor ?? undefined) }),
          api.missedCallCount(),
        ]);
        setCalls((prev) => (replace ? page.items : [...prev, ...page.items]));
        setCursor(page.nextCursor);
        setMissed(count.count);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setLoading(false);
      }
    },
    [cursor, missedOnly],
  );

  // Only the filter (and the mount) reloads; paging is driven by the footer.
  useEffect(() => {
    void load(true);
  }, [missedOnly]);

  // A call that just ended belongs in the log immediately, and the missed
  // badge has to drop when the ring resolves either way.
  useRealtimeEvents(
    useCallback((event: WsServerEvent) => {
      if (event.type === "call.ended" || event.type === "call.incoming") void load(true);
    }, [load]),
  );

  const dial = (call: CallSummary, mediaType: CallMediaType) => {
    void startCall(call.conversationId, mediaType);
  };

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.lg, paddingBottom: spacing.sm }}>
        <Text style={{ fontSize: 12, fontWeight: "700", letterSpacing: 0.6, color: palette.textFaint, textTransform: "uppercase", flex: 1 }}>
          {missedOnly ? "Missed calls" : "All calls"}
        </Text>
        <FilterChip label="All" active={!missedOnly} onPress={() => setMissedOnly(false)} />
        <FilterChip
          label={missed > 0 ? `Missed (${missed})` : "Missed"}
          active={missedOnly}
          onPress={() => setMissedOnly(true)}
        />
      </View>

      {!callSupported && (
        <View style={{ marginHorizontal: spacing.lg, marginBottom: spacing.sm, padding: spacing.sm, borderRadius: radius.field, backgroundColor: colors.amberBg }}>
          <Text style={{ fontSize: 12, color: colors.amberText }}>{WEBRTC_UNSUPPORTED}</Text>
        </View>
      )}

      {error && (
        <Text style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.sm, fontSize: 13, color: colors.danger }}>{error}</Text>
      )}

      <FlatList
        data={calls}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <CallRow call={item} onDial={dial} disabled={!callSupported} />}
        ListEmptyComponent={
          !loading && !error ? (
            <Text style={{ paddingVertical: spacing.xl, textAlign: "center", fontSize: 14, color: palette.textMuted }}>
              {missedOnly ? "No missed calls." : "No calls yet. Start one from any chat."}
            </Text>
          ) : null
        }
        ListFooterComponent={
          loading ? (
            <ActivityIndicator style={{ paddingVertical: spacing.md }} color={colors.iris600} />
          ) : cursor ? (
            <Pressable onPress={() => void load(false)} style={{ paddingVertical: spacing.md, alignItems: "center" }}>
              <Text style={{ fontSize: 13, fontWeight: "700", color: colors.iris600 }}>Load earlier calls</Text>
            </Pressable>
          ) : null
        }
      />
    </View>
  );
}

function FilterChip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  const palette = usePalette();
  return (
    <Pressable
      onPress={onPress}
      style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: radius.pill, backgroundColor: active ? colors.iris600 : palette.raised }}
    >
      <Text style={{ fontSize: 12, fontWeight: "700", color: active ? colors.white : palette.textMuted }}>{label}</Text>
    </Pressable>
  );
}

function CallRow({
  call,
  onDial,
  disabled,
}: {
  call: CallSummary;
  onDial: (call: CallSummary, mediaType: CallMediaType) => void;
  disabled: boolean;
}) {
  const palette = usePalette();
  const missedCall = call.status === "MISSED";
  const peer = call.direction === "OUTGOING" ? call.callee : call.caller;
  const name = peer.displayName ?? "Your contact";
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: spacing.md,
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.sm,
        borderBottomWidth: 1,
        borderBottomColor: palette.border,
      }}
    >
      <View style={{ width: 26, alignItems: "center" }}>
        <Text style={{ fontSize: 15, color: missedCall ? colors.danger : palette.textFaint }}>
          {call.direction === "OUTGOING" ? "↗" : "↙"}
        </Text>
      </View>
      <Avatar initial={avatarInitial(name)} size={40} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: "700", color: palette.text }}>
          {name}
        </Text>
        <Text numberOfLines={1} style={{ fontSize: 12, color: missedCall ? colors.danger : palette.textFaint }}>
          {callLabel(call)} · {relativeTime(call.createdAt)}
        </Text>
      </View>
      <DialButton glyph="📞" disabled={disabled} onPress={() => onDial(call, "VOICE")} />
      <DialButton glyph="📹" disabled={disabled} onPress={() => onDial(call, "VIDEO")} />
    </View>
  );
}

function DialButton({
  glyph,
  onPress,
  disabled,
}: {
  glyph: string;
  onPress: () => void;
  disabled: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={8}
      style={({ pressed }) => ({
        width: 34,
        height: 34,
        borderRadius: radius.pill,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: colors.iris100,
        opacity: disabled ? 0.35 : pressed ? 0.6 : 1,
      })}
    >
      <Text style={{ fontSize: 15 }}>{glyph}</Text>
    </Pressable>
  );
}

/** The one line under a contact's name: what happened, and for how long. */
function callLabel(call: CallSummary): string {
  const kind = call.mediaType === "VIDEO" ? "video" : "voice";
  switch (call.status) {
    case "ENDED":
      return call.durationSeconds !== null ? `Call ${formatCallDuration(call.durationSeconds)}` : "Call ended";
    case "MISSED":
      return `Missed ${kind} call`;
    case "DECLINED":
      return call.direction === "OUTGOING" ? `Declined ${kind} call` : `You declined the ${kind} call`;
    case "CANCELED":
      return `Canceled ${kind} call`;
    case "BUSY":
      return `Busy ${kind} call`;
    case "FAILED":
      return `Failed ${kind} call`;
    case "RINGING":
      return `Ringing ${kind} call`;
    case "CONNECTED":
      return `Ongoing ${kind} call`;
    default:
      return `${kind} call`;
  }
}
