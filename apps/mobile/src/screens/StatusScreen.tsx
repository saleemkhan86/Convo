import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  useWindowDimensions,
  View,
  type ViewStyle,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import { useVideoPlayer, VideoView } from "expo-video";
import type { StatusItem, StatusMute, StatusVisibility, WsServerEvent } from "@convo/shared";
import { api, resolveMediaUrl } from "../api";
import { useRealtimeEvents } from "../realtime";
import { newClientMessageId } from "../outbox";
import { avatarInitial, errorMessage } from "../chatUtils";
import { Avatar, Button, TextField, usePalette } from "../components/ui";
import { colors, radius, spacing, type Palette } from "../theme";

const DURATIONS = [
  { hours: 6, label: "6h" },
  { hours: 12, label: "12h" },
  { hours: 24, label: "24h" },
  { hours: 48, label: "2d" },
];

const AUDIENCES: Array<{ value: StatusVisibility; label: string; hint: string }> = [
  { value: "EVERYONE", label: "Everyone", hint: "Any Convo account can see it" },
  { value: "CONTACTS", label: "My contacts", hint: "Only people you saved" },
  { value: "CUSTOM", label: "Only these people", hint: "Pick a custom list" },
  { value: "CONTACTS_EXCEPT", label: "My contacts except…", hint: "Hide from chosen people" },
];

const AUTOPLAY_MS = 6000;

/**
 * Status tab (Phase 4B): 24h stories — text, photo, video or link.
 * Phase 5D adds replies that open a chat with the author, muting an author's
 * updates, the author-side read-receipt switch, and pause/seek in the viewer.
 */
export function StatusScreen({ accountId }: { accountId: string }) {
  const palette = usePalette();
  const [mine, setMine] = useState<StatusItem[]>([]);
  const [others, setOthers] = useState<StatusItem[]>([]);
  const [muted, setMuted] = useState<Set<string>>(new Set());
  const [mutes, setMutes] = useState<StatusMute[]>([]);
  const [managingMutes, setManagingMutes] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [composing, setComposing] = useState<null | "text" | "media">(null);
  const [viewersFor, setViewersFor] = useState<string | null>(null);
  const [viewers, setViewers] = useState<Awaited<ReturnType<typeof api.statusViewers>>["viewers"]>([]);

  const load = useCallback(async () => {
    try {
      const [list, muteList] = await Promise.all([api.listStatuses(), api.listStatusMutes()]);
      setMine(list.mine);
      setOthers(list.others);
      setMutes(muteList.items);
      setMuted(new Set(muteList.items.map((m) => m.userId)));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useRealtimeEvents(
    useCallback((event: WsServerEvent) => {
      if (event.type === "status.new") {
        setOthers((prev) => [event.status, ...prev.filter((s) => s.id !== event.status.id)]);
      } else if (event.type === "status.viewed") {
        setMine((prev) =>
          prev.map((s) => (s.id === event.statusId ? { ...s, viewCount: (s.viewCount ?? 0) + 1, hasViews: true } : s)),
        );
      }
    }, []),
  );

  const feed = useMemo(
    () => others.filter((status) => !muted.has(status.author.userId)),
    [others, muted],
  );

  const open = async (index: number) => {
    const status = feed[index];
    if (!status) return;
    setOpenIndex(index);
    if (!status.seenByMe && status.author.userId !== accountId) {
      setOthers((prev) => prev.map((s) => (s.id === status.id ? { ...s, seenByMe: true } : s)));
      await api.markStatusViewed(status.id).catch(() => {});
    }
  };

  const toggleMute = async (authorId: string, displayName: string | null) => {
    const wasMuted = muted.has(authorId);
    setMuted((prev) => {
      const next = new Set(prev);
      if (wasMuted) next.delete(authorId);
      else next.add(authorId);
      return next;
    });
    setMutes((prev) =>
      wasMuted ? prev.filter((m) => m.userId !== authorId) : [{ userId: authorId, displayName, avatarUrl: null, mutedAt: new Date().toISOString() }, ...prev],
    );
    try {
      if (wasMuted) await api.unmuteStatusAuthor(authorId);
      else await api.muteStatusAuthor(authorId);
    } catch (err) {
      setMuted((prev) => {
        const next = new Set(prev);
        if (wasMuted) next.add(authorId);
        else next.delete(authorId);
        return next;
      });
      setError(errorMessage(err));
    }
  };

  const remove = async (id: string) => {
    await api.deleteStatus(id).catch(() => {});
    await load();
  };

  const showViewers = async (id: string) => {
    setViewersFor(id);
    try {
      setViewers((await api.statusViewers(id)).viewers);
    } catch {
      setViewers([]);
    }
  };

  if (loading) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={colors.iris600} />
      </View>
    );
  }

  const current = openIndex !== null ? feed[openIndex] : undefined;

  return (
    <View style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ paddingBottom: spacing.xl }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: spacing.lg, gap: spacing.md, paddingBottom: spacing.md }}>
          <RailButton label="Add" initial="+" onPress={() => setComposing("text")} palette={palette} />
          {mine.length > 0 && (
            <RailButton
              label={`My status${mine.length > 1 ? ` · ${mine.length}` : ""}`}
              initial={avatarInitial(mine[0]?.author.displayName ?? "Me")}
              seen={false}
              palette={palette}
              onPress={() => void showViewers(mine[0]?.id ?? "")}
            />
          )}
          {feed.map((status, index) => (
            <RailButton
              key={status.id}
              label={status.author.displayName ?? "Convo user"}
              initial={avatarInitial(status.author.displayName ?? "?")}
              seen={status.seenByMe}
              palette={palette}
              onPress={() => void open(index)}
            />
          ))}
        </ScrollView>

        {error && <Text style={{ paddingHorizontal: spacing.lg, fontSize: 13, color: colors.danger }}>{error}</Text>}

        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingRight: spacing.lg }}>
          <Text style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.md, fontSize: 11, fontWeight: "800", letterSpacing: 0.6, color: palette.textFaint, textTransform: "uppercase" }}>
            Recent updates
          </Text>
          {mutes.length > 0 && (
            <Pressable onPress={() => setManagingMutes(true)} hitSlop={6} style={{ paddingTop: spacing.md }}>
              <Text style={{ fontSize: 11, fontWeight: "800", color: colors.iris600 }}>{mutes.length} muted</Text>
            </Pressable>
          )}
        </View>
        {feed.length === 0 && mine.length === 0 && (
          <Text style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.sm, fontSize: 13, color: palette.textMuted }}>
            No statuses right now. Post one and it disappears on the schedule you pick.
          </Text>
        )}
        {feed.map((status, index) => (
          <Pressable key={status.id} onPress={() => void open(index)}>
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: spacing.md,
                paddingHorizontal: spacing.lg,
                paddingVertical: 12,
              }}
            >
              <View style={{ borderRadius: radius.pill, padding: 2, backgroundColor: status.seenByMe ? palette.border : colors.iris600 }}>
                <Avatar initial={avatarInitial(status.author.displayName ?? "?")} size={38} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: "700", color: palette.text }}>
                  {status.author.displayName ?? "Convo user"}
                </Text>
                <Text numberOfLines={1} style={{ fontSize: 12, color: palette.textMuted }}>
                  {status.kind === "TEXT" || status.kind === "URL" ? status.text : status.kind === "IMAGE" ? "Photo" : "Video"}
                  {` · expires ${expiresLabel(status.expiresAt)}`}
                </Text>
              </View>
              <Text style={{ fontSize: 11, fontWeight: "800", color: status.seenByMe ? palette.textFaint : colors.iris600 }}>
                {status.seenByMe ? "SEEN" : "NEW"}
              </Text>
            </View>
          </Pressable>
        ))}

        {mine.length > 0 && (
          <>
            <Text style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.md, fontSize: 11, fontWeight: "800", letterSpacing: 0.6, color: palette.textFaint, textTransform: "uppercase" }}>
              My statuses
            </Text>
            {mine.map((status) => (
              <View
                key={status.id}
                style={{ flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: 10 }}
              >
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text numberOfLines={1} style={{ fontSize: 14, fontWeight: "700", color: palette.text }}>
                    {status.text ?? (status.kind === "IMAGE" ? "Photo" : status.kind === "VIDEO" ? "Video" : status.kind)}
                  </Text>
                  <Text style={{ fontSize: 12, color: palette.textMuted }}>
                    {status.viewCount ?? 0} views · expires {expiresLabel(status.expiresAt)}
                    {status.shareReadReceipts ? "" : " · receipts off"}
                  </Text>
                </View>
                <Pressable onPress={() => void showViewers(status.id)} hitSlop={6}>
                  <Text style={{ fontSize: 12, fontWeight: "700", color: colors.iris600 }}>Viewed by</Text>
                </Pressable>
                <Pressable onPress={() => void remove(status.id)} hitSlop={6}>
                  <Text style={{ fontSize: 12, fontWeight: "700", color: colors.danger }}>Delete</Text>
                </Pressable>
              </View>
            ))}
          </>
        )}
      </ScrollView>

      <View style={{ flexDirection: "row", gap: spacing.sm, padding: spacing.md }}>
        <View style={{ flex: 1 }}>
          <Button label="Text status" variant="secondary" onPress={() => setComposing("text")} />
        </View>
        <View style={{ flex: 1 }}>
          <Button label="Photo / video" variant="secondary" onPress={() => setComposing("media")} />
        </View>
      </View>

      {current && (
        <StatusViewer
          statuses={feed}
          index={openIndex ?? 0}
          palette={palette}
          muted={muted}
          onToggleMute={(authorId, displayName) => {
            const wasMuted = muted.has(authorId);
            void toggleMute(authorId, displayName);
            // Muting hides the author's rows and would shift this index, so close.
            if (!wasMuted) setOpenIndex(null);
          }}
          onReply={async (statusId, body) => {
            await api.replyToStatus(statusId, { clientMessageId: newClientMessageId(), body });
          }}
          onJump={(i) => setOpenIndex(i)}
          onClose={() => setOpenIndex(null)}
          onAdvance={() => {
            const next = (openIndex ?? 0) + 1;
            if (next >= feed.length) setOpenIndex(null);
            else void open(next);
          }}
          onBack={() => {
            const prev = (openIndex ?? 0) - 1;
            if (prev < 0) setOpenIndex(null);
            else setOpenIndex(prev);
          }}
        />
      )}

      <Modal visible={managingMutes} transparent animationType="fade" onRequestClose={() => setManagingMutes(false)}>
        <Pressable style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.45)", alignItems: "center", justifyContent: "center" }} onPress={() => setManagingMutes(false)}>
          <Pressable
            onPress={(e) => e.stopPropagation()}
            style={{ backgroundColor: palette.surface, borderRadius: radius.card, padding: spacing.lg, gap: spacing.sm, width: "86%", maxHeight: "70%" }}
          >
            <Text style={{ fontSize: 15, fontWeight: "800", color: palette.text }}>Muted authors</Text>
            <Text style={{ fontSize: 12, color: palette.textMuted }}>
              Their statuses stay hidden until you unmute them. They are not told.
            </Text>
            <ScrollView style={{ maxHeight: 300 }}>
              {mutes.length === 0 && (
                <Text style={{ fontSize: 13, color: palette.textMuted, paddingVertical: spacing.md }}>Nobody is muted.</Text>
              )}
              {mutes.map((entry) => (
                <View key={entry.userId} style={{ flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: 8 }}>
                  <Avatar initial={avatarInitial(entry.displayName ?? "?")} size={32} />
                  <Text numberOfLines={1} style={{ flex: 1, fontSize: 14, color: palette.text }}>
                    {entry.displayName ?? "Convo user"}
                  </Text>
                  <Pressable onPress={() => void toggleMute(entry.userId, entry.displayName)} hitSlop={8}>
                    <Text style={{ fontSize: 12, fontWeight: "800", color: colors.iris600 }}>Unmute</Text>
                  </Pressable>
                </View>
              ))}
            </ScrollView>
            <Button label="Done" variant="secondary" onPress={() => setManagingMutes(false)} />
          </Pressable>
        </Pressable>
      </Modal>

      {composing !== null && (
        <StatusComposer
          palette={palette}
          startWith={composing}
          onClose={() => setComposing(null)}
          onPosted={() => {
            setComposing(null);
            void load();
          }}
        />
      )}

      <Modal visible={viewersFor !== null} transparent animationType="fade" onRequestClose={() => setViewersFor(null)}>
        <Pressable style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.45)", alignItems: "center", justifyContent: "center" }} onPress={() => setViewersFor(null)}>
          <Pressable
            onPress={(e) => e.stopPropagation()}
            style={{ backgroundColor: palette.surface, borderRadius: radius.card, padding: spacing.lg, gap: spacing.sm, width: "80%", maxHeight: "70%" }}
          >
            <Text style={{ fontSize: 15, fontWeight: "800", color: palette.text }}>Viewed by ({viewers.length})</Text>
            <ScrollView style={{ maxHeight: 320 }}>
              {viewers.length === 0 && (
                <Text style={{ fontSize: 13, color: palette.textMuted, paddingVertical: spacing.md }}>Nobody yet.</Text>
              )}
              {viewers.map((viewer) => (
                <View key={viewer.userId} style={{ flexDirection: "row", justifyContent: "space-between", gap: spacing.md, paddingVertical: 6 }}>
                  <Text numberOfLines={1} style={{ flex: 1, fontSize: 14, color: palette.text }}>
                    {viewer.displayName ?? "Convo user"}
                  </Text>
                  <Text style={{ fontSize: 11, color: palette.textFaint }}>
                    {new Date(viewer.viewedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </Text>
                </View>
              ))}
            </ScrollView>
            <Button label="Close" variant="secondary" onPress={() => setViewersFor(null)} />
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

function RailButton({
  label,
  initial,
  onPress,
  seen,
  palette,
}: {
  label: string;
  initial: string;
  onPress: () => void;
  seen?: boolean;
  palette: Palette;
}) {
  return (
    <Pressable onPress={onPress} style={{ alignItems: "center", gap: 6, width: 68 }}>
      <View style={{ borderRadius: radius.pill, padding: 2.5, backgroundColor: seen === false ? colors.iris600 : palette.border }}>
        <Avatar initial={initial} size={54} />
      </View>
      <Text numberOfLines={1} style={{ fontSize: 11, fontWeight: "600", color: palette.textMuted, textAlign: "center" }}>
        {label}
      </Text>
    </Pressable>
  );
}

function StatusViewer({
  statuses,
  index,
  palette,
  muted,
  onToggleMute,
  onReply,
  onJump,
  onClose,
  onAdvance,
  onBack,
}: {
  statuses: StatusItem[];
  index: number;
  palette: Palette;
  muted: Set<string>;
  onToggleMute: (authorId: string, displayName: string | null) => void;
  onReply: (statusId: string, body: string) => Promise<void>;
  onJump: (index: number) => void;
  onClose: () => void;
  onAdvance: () => void;
  onBack: () => void;
}) {
  const status = statuses[index];
  const { width, height } = useWindowDimensions();
  const [progress, setProgress] = useState(0);
  const [paused, setPaused] = useState(false);
  const [barWidth, setBarWidth] = useState(0);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [viewError, setViewError] = useState<string | null>(null);
  const elapsed = useRef(0);
  const holding = useRef(false);
  const videoCtl = useRef<StatusVideoControls | null>(null);
  const isVideo = status?.kind === "VIDEO";

  useEffect(() => {
    elapsed.current = 0;
    setProgress(0);
    setPaused(false);
    setDraft("");
    setSent(false);
    setViewError(null);
  }, [status?.id]);

  useEffect(() => {
    if (!status) return;
    const timer = setInterval(() => {
      // A paused viewer stops the clock instead of jumping ahead when it resumes.
      if (paused || holding.current) return;
      elapsed.current += 100;
      const pct = Math.min(100, (elapsed.current / AUTOPLAY_MS) * 100);
      setProgress(pct);
      if (pct >= 100) onAdvance();
    }, 100);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.id, paused]);

  useEffect(() => {
    const ctl = videoCtl.current;
    if (!ctl) return;
    if (paused || holding.current) ctl.pause();
    else ctl.play();
  }, [paused, status?.id]);

  if (!status) return null;
  const mediaUrl = resolveMediaUrl(status.mediaUrl);
  const authorMuted = muted.has(status.author.userId);

  const seekAt = (x: number) => {
    if (barWidth <= 0) return;
    const pct = Math.max(0, Math.min(100, (x / barWidth) * 100));
    elapsed.current = (pct / 100) * AUTOPLAY_MS;
    setProgress(pct);
    videoCtl.current?.seek(pct / 100);
  };

  const send = async () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setViewError(null);
    try {
      await onReply(status.id, body);
      setDraft("");
      setSent(true);
    } catch (err) {
      setViewError(errorMessage(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: "rgba(6,8,16,0.97)" }}>
        <View style={{ flexDirection: "row", gap: 3, paddingHorizontal: spacing.md, paddingTop: spacing.md }}>
          {statuses.map((item, i) => (
            <Pressable
              key={item.id}
              onLayout={i === index ? (event) => setBarWidth(event.nativeEvent.layout.width) : undefined}
              onPress={(event) => {
                if (i === index) seekAt(event.nativeEvent.locationX);
                else onJump(i);
              }}
              style={{ flex: 1, height: 8, borderRadius: 4, backgroundColor: "rgba(255,255,255,0.3)", overflow: "hidden" }}
            >
              <View
                pointerEvents="none"
                style={{
                  height: 8,
                  borderRadius: 4,
                  backgroundColor: "#ffffff",
                  width: `${i < index ? 100 : i === index ? progress : 0}%`,
                }}
              />
            </Pressable>
          ))}
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: spacing.md }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: "800", color: "#ffffff" }}>
              {status.author.displayName ?? "Convo user"}
            </Text>
            <Text style={{ fontSize: 11, color: "rgba(255,255,255,0.7)" }}>{expiresLabel(status.expiresAt)}</Text>
          </View>
          <Pressable onPress={() => setPaused((p) => !p)} hitSlop={10} style={{ paddingHorizontal: spacing.md }}>
            <Text style={{ fontSize: 15, fontWeight: "800", color: paused ? colors.iris100 : "rgba(255,255,255,0.85)" }}>
              {paused ? "▶" : "❚❚"}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => onToggleMute(status.author.userId, status.author.displayName)}
            hitSlop={10}
            style={{ paddingHorizontal: spacing.md }}
          >
            <Text style={{ fontSize: 11, fontWeight: "800", color: authorMuted ? colors.iris100 : "rgba(255,255,255,0.7)" }}>
              {authorMuted ? "Unmute" : "Mute"}
            </Text>
          </Pressable>
          <Pressable onPress={onClose} hitSlop={10}>
            <Text style={{ fontSize: 24, color: "#ffffff" }}>×</Text>
          </Pressable>
        </View>

        <View style={{ flex: 1 }}>
          <View style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: Math.round(width / 3), zIndex: 2 }}>
            <Pressable style={{ flex: 1 }} onPress={onBack} />
          </View>
          <View style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: Math.round(width / 3), zIndex: 2 }}>
            <Pressable style={{ flex: 1 }} onPress={onAdvance} />
          </View>
          <View
            style={{ position: "absolute", left: Math.round(width / 3), top: 0, bottom: 0, width: Math.round(width / 3), zIndex: 2 }}
          >
            <Pressable
              style={{ flex: 1 }}
              onPressIn={() => {
                holding.current = true;
                videoCtl.current?.pause();
              }}
              onPressOut={() => {
                holding.current = false;
                if (!paused) videoCtl.current?.play();
              }}
            />
          </View>

          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.lg }}>
            {status.kind === "TEXT" && (
              <View style={{ width: "100%", height: Math.min(height * 0.6, 460), borderRadius: radius.card, backgroundColor: colors.iris600, alignItems: "center", justifyContent: "center", padding: spacing.lg }}>
                <Text style={{ fontSize: 22, fontWeight: "700", color: "#ffffff", textAlign: "center" }}>{status.text}</Text>
              </View>
            )}
            {status.kind === "URL" && (
              <View style={{ width: "100%", borderRadius: radius.card, borderWidth: 1, borderColor: "rgba(255,255,255,0.3)", padding: spacing.lg, gap: spacing.md }}>
                <Text style={{ fontSize: 12, fontWeight: "800", letterSpacing: 0.6, color: "rgba(255,255,255,0.6)", textTransform: "uppercase" }}>
                  Shared link
                </Text>
                <Text selectable style={{ fontSize: 17, fontWeight: "700", color: "#ffffff" }}>
                  {status.text}
                </Text>
                <Button label="Open link" variant="secondary" onPress={() => void openExternal(status.text)} />
              </View>
            )}
            {status.kind === "IMAGE" && mediaUrl && (
              <Image source={{ uri: mediaUrl }} style={{ width, height: height * 0.62 }} resizeMode="contain" />
            )}
            {status.kind === "IMAGE" && !mediaUrl && (
              <Text style={{ color: "rgba(255,255,255,0.7)" }}>This photo is no longer available.</Text>
            )}
            {isVideo && mediaUrl && (
              <StatusVideo uri={mediaUrl} style={{ width, height: height * 0.62 }} controlsRef={videoCtl} />
            )}
            {isVideo && !mediaUrl && (
              <Text style={{ color: "rgba(255,255,255,0.7)" }}>This video is no longer available.</Text>
            )}
            {status.kind === "IMAGE" && status.text ? (
              <Text style={{ marginTop: spacing.md, color: "#ffffff", textAlign: "center" }}>{status.text}</Text>
            ) : null}
            {paused && (
              <Text style={{ position: "absolute", bottom: spacing.md, fontSize: 11, fontWeight: "800", letterSpacing: 0.6, color: "rgba(255,255,255,0.75)", textTransform: "uppercase" }}>
                Paused
              </Text>
            )}
          </View>
        </View>

        <View style={{ padding: spacing.md, gap: 6 }}>
          <View style={{ flexDirection: "row", gap: spacing.sm }}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder={`Reply to ${status.author.displayName ?? "this status"}`}
              placeholderTextColor="rgba(255,255,255,0.5)"
              multiline
              submitBehavior="newline"
              style={{
                flex: 1,
                maxHeight: 96,
                borderRadius: radius.pill,
                borderWidth: 1,
                borderColor: "rgba(255,255,255,0.25)",
                paddingHorizontal: spacing.md,
                paddingVertical: 10,
                fontSize: 14,
                color: "#ffffff",
              }}
            />
            <Pressable
              onPress={() => void send()}
              disabled={!draft.trim() || sending}
              style={{
                borderRadius: radius.pill,
                paddingHorizontal: spacing.lg,
                justifyContent: "center",
                backgroundColor: draft.trim() && !sending ? colors.iris600 : "rgba(255,255,255,0.15)",
              }}
            >
              <Text style={{ fontSize: 13, fontWeight: "800", color: "#ffffff" }}>{sending ? "…" : "Send"}</Text>
            </Pressable>
          </View>
          {sent && (
            <Text style={{ fontSize: 12, color: colors.iris100 }}>Reply sent — it is waiting in your chat with them.</Text>
          )}
          {viewError && <Text style={{ fontSize: 12, color: colors.danger }}>{viewError}</Text>}
        </View>
      </View>
    </Modal>
  );
}

async function openExternal(text: string | null): Promise<void> {
  if (!text) return;
  await Linking.openURL(text).catch(() => {});
}

function StatusComposer({
  startWith,
  palette,
  onClose,
  onPosted,
}: {
  startWith: "text" | "media";
  palette: Palette;
  onClose: () => void;
  onPosted: () => void;
}) {
  const [kind, setKind] = useState<"TEXT" | "IMAGE" | "VIDEO" | "URL">(startWith === "media" ? "IMAGE" : "TEXT");
  const [text, setText] = useState("");
  const [media, setMedia] = useState<{ storageKey: string; mimeType: string; uri: string } | null>(null);
  const [hours, setHours] = useState(24);
  const [visibility, setVisibility] = useState<StatusVisibility>("EVERYONE");
  const [shareReceipts, setShareReceipts] = useState(true);
  const [people, setPeople] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = async (as: "images" | "videos") => {
    setError(null);
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setError("Convo needs photo access to post a status.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: [as],
      base64: true,
      quality: 82,
      allowsMultipleSelection: false,
    });
    if (result.canceled) return;
    const asset = result.assets[0];
    if (!asset?.base64) {
      setError("Could not read the selected file.");
      return;
    }
    const mimeType = asset.mimeType ?? (as === "images" ? "image/jpeg" : "video/mp4");
    setKind(as === "images" ? "IMAGE" : "VIDEO");
    setUploading(true);
    try {
      const uploaded = await api.uploadMediaBase64({
        data: asset.base64,
        mimeType,
        fileName: asset.fileName ?? undefined,
      });
      setMedia({ storageKey: uploaded.storageKey, mimeType: uploaded.mimeType, uri: asset.uri });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setUploading(false);
    }
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const userIds =
        visibility === "CUSTOM" || visibility === "CONTACTS_EXCEPT"
          ? people
              .split(/[\s,;]+/)
              .map((p) => p.trim())
              .filter(Boolean)
          : [];
      await api.postStatus({
        kind,
        text: text.trim() || undefined,
        storageKey: kind === "IMAGE" || kind === "VIDEO" ? media?.storageKey : undefined,
        mimeType: kind === "IMAGE" || kind === "VIDEO" ? media?.mimeType : undefined,
        durationHours: hours,
        visibility,
        userIds,
        shareReadReceipts: shareReceipts,
      });
      onPosted();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  const needsMedia = (kind === "IMAGE" || kind === "VIDEO") && !media;
  const disabled = busy || uploading || needsMedia || ((kind === "TEXT" || kind === "URL") && !text.trim());

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "flex-end" }}>
        <Pressable onPress={onClose} style={{ flex: 1 }} />
        <View style={{ backgroundColor: palette.surface, borderTopLeftRadius: radius.card, borderTopRightRadius: radius.card, padding: spacing.lg, gap: spacing.md, maxHeight: "88%" }}>
          <ScrollView contentContainerStyle={{ gap: spacing.md }}>
            <Text style={{ fontSize: 18, fontWeight: "800", color: palette.text }}>New status</Text>

            <View style={{ flexDirection: "row", gap: spacing.sm }}>
              {(["TEXT", "IMAGE", "VIDEO", "URL"] as const).map((option) => (
                <Pressable
                  key={option}
                  onPress={() => setKind(option)}
                  style={{
                    flex: 1,
                    paddingVertical: 8,
                    borderRadius: radius.pill,
                    alignItems: "center",
                    borderWidth: 1,
                    backgroundColor: kind === option ? colors.iris600 : palette.surface,
                    borderColor: kind === option ? colors.iris600 : palette.border,
                  }}
                >
                  <Text style={{ fontSize: 12, fontWeight: "700", color: kind === option ? colors.white : palette.text }}>
                    {option === "TEXT" ? "Text" : option === "URL" ? "Link" : option === "IMAGE" ? "Photo" : "Video"}
                  </Text>
                </Pressable>
              ))}
            </View>

            {(kind === "TEXT" || kind === "URL") && (
              <TextField
                label={kind === "TEXT" ? "What's on your mind?" : "Link (https://…)"}
                value={text}
                onChangeText={setText}
                placeholder={kind === "TEXT" ? "Say something" : "https://example.com"}
                palette={palette}
                keyboardType={kind === "URL" ? "url" : "default"}
              />
            )}

            {(kind === "IMAGE" || kind === "VIDEO") && (
              <View style={{ gap: spacing.sm }}>
                <Pressable
                  onPress={() => void pick(kind === "IMAGE" ? "images" : "videos")}
                  style={{
                    borderRadius: radius.field,
                    borderWidth: 1.5,
                    borderStyle: "dashed",
                    borderColor: palette.border,
                    paddingVertical: spacing.lg,
                    alignItems: "center",
                  }}
                >
                  <Text style={{ fontSize: 14, color: palette.textMuted }}>
                    {uploading ? "Uploading…" : media ? "Replace selection" : `Choose a ${kind === "IMAGE" ? "photo" : "video"}`}
                  </Text>
                </Pressable>
                {media && (
                  kind === "IMAGE" ? (
                    <Image source={{ uri: media.uri }} style={{ height: 180, borderRadius: radius.field }} resizeMode="contain" />
                  ) : (
                    <StatusVideo uri={media.uri} style={{ height: 180, borderRadius: radius.field }} />
                  )
                )}
                <TextField label="Caption (optional)" value={text} onChangeText={setText} palette={palette} />
              </View>
            )}

            <View style={{ gap: spacing.sm }}>
              <Text style={{ fontSize: 13, fontWeight: "600", color: palette.textMuted }}>Disappears after</Text>
              <View style={{ flexDirection: "row", gap: spacing.sm, flexWrap: "wrap" }}>
                {DURATIONS.map((option) => (
                  <Pressable
                    key={option.hours}
                    onPress={() => setHours(option.hours)}
                    style={{
                      borderRadius: radius.pill,
                      borderWidth: 1,
                      paddingHorizontal: 14,
                      paddingVertical: 7,
                      backgroundColor: hours === option.hours ? colors.iris100 : palette.surface,
                      borderColor: hours === option.hours ? colors.iris500 : palette.border,
                    }}
                  >
                    <Text style={{ fontSize: 12, fontWeight: "700", color: hours === option.hours ? colors.iris700 : palette.textMuted }}>
                      {option.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>

            <View style={{ gap: spacing.sm }}>
              <Text style={{ fontSize: 13, fontWeight: "600", color: palette.textMuted }}>Who can see it</Text>
              {AUDIENCES.map((option) => (
                <Pressable key={option.value} onPress={() => setVisibility(option.value)} style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                  <View
                    style={{
                      width: 18,
                      height: 18,
                      borderRadius: 9,
                      borderWidth: 2,
                      borderColor: visibility === option.value ? colors.iris600 : palette.border,
                      backgroundColor: visibility === option.value ? colors.iris600 : "transparent",
                    }}
                  />
                  <Text style={{ fontSize: 14, color: palette.text }}>
                    {option.label}
                    <Text style={{ fontSize: 12, color: palette.textFaint }}>  ·  {option.hint}</Text>
                  </Text>
                </Pressable>
              ))}
              {(visibility === "CUSTOM" || visibility === "CONTACTS_EXCEPT") && (
                <TextField
                  label="Account ids"
                  value={people}
                  onChangeText={setPeople}
                  placeholder="clx…, clx…"
                  palette={palette}
                />
              )}
            </View>

            <Pressable
              onPress={() => setShareReceipts((value) => !value)}
              style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}
            >
              <View
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: 5,
                  borderWidth: 2,
                  borderColor: shareReceipts ? colors.iris600 : palette.border,
                  backgroundColor: shareReceipts ? colors.iris600 : "transparent",
                }}
              />
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14, color: palette.text }}>Show who viewed it</Text>
                <Text style={{ fontSize: 12, color: palette.textFaint }}>
                  Off means views are never recorded for this status — not even for you.
                </Text>
              </View>
            </Pressable>

            {error && <Text style={{ fontSize: 13, color: colors.danger }}>{error}</Text>}
          </ScrollView>

          <View style={{ flexDirection: "row", gap: spacing.sm }}>
            <View style={{ flex: 1 }}>
              <Button label="Cancel" variant="secondary" onPress={onClose} />
            </View>
            <View style={{ flex: 1 }}>
              <Button label="Post" loading={busy} disabled={disabled} onPress={() => void submit()} />
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}

interface StatusVideoControls {
  play: () => void;
  pause: () => void;
  seek: (fraction: number) => void;
}

function StatusVideo({
  uri,
  style,
  controlsRef,
}: {
  uri: string;
  style: ViewStyle;
  controlsRef?: { current: StatusVideoControls | null };
}) {
  const player = useVideoPlayer(uri, (instance) => {
    instance.play();
  });

  useEffect(() => {
    const ref = controlsRef;
    if (!ref) return;
    ref.current = {
      play: () => player.play(),
      pause: () => player.pause(),
      seek: (fraction) => {
        const duration = player.duration;
        if (Number.isFinite(duration)) player.currentTime = Math.max(0, Math.min(1, fraction)) * duration;
      },
    };
    return () => {
      ref.current = null;
    };
  }, [player, controlsRef]);

  return <VideoView player={player} style={style} contentFit="contain" nativeControls />;
}

function expiresLabel(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "now";
  const hours = Math.floor(ms / 3600_000);
  if (hours < 1) return `in ${Math.max(1, Math.round(ms / 60_000))}m`;
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.floor(hours / 24)}d`;
}
