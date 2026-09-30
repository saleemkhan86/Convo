import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import * as Location from "expo-location";
import { NetworkStateType, useNetworkState } from "expo-network";
import { File, UploadType } from "expo-file-system";
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
  useAudioRecorder,
} from "expo-audio";
import { useVideoPlayer, VideoView } from "expo-video";
import type {
  Account,
  Attachment,
  AttachmentInput,
  ChatLinkItem,
  Contact,
  ConversationSummary,
  GiphyItem,
  LinkPreview,
  Message,
  MessageLocation,
  SharedContact,
  SharedMediaKind,
} from "@convo/shared";
import { API_BASE } from "../storage";
import { ApiRequestError, api, currentAccessToken, resolveMediaUrl, tryRefresh, type MediaUploadResult } from "../api";
import { attachmentKindLabel, relativeTime } from "../chatUtils";
import { Sheet, SheetButton } from "./ChatControls";
import { usePalette } from "./ui";
import { colors, radius, spacing } from "../theme";

/**
 * Chat media (Phase 5B) for React Native: the composer's attachment pipeline,
 * media bubbles, view-once viewing, the shared-media grid and forwarding.
 *
 * Uploads go through expo-file-system's multipart `File.upload` rather than
 * base64 JSON: a chat photo or voice note can be large, and the native uploader
 * streams it without holding the bytes in the JS heap.
 *
 * View-once media arrives with no URL in any list payload, so the URLs are
 * minted here, at the moment the recipient taps the tile — once per viewer.
 */

/** One file the composer is holding before the message is sent. */
export interface StagedFile {
  storageKey: string;
  kind: Attachment["kind"];
  mimeType: string;
  fileName: string | null;
  sizeBytes: number;
  /** Local file:// URI so the composer can preview without another request. */
  uri: string;
  durationMs?: number;
}

/** Client-side cap on a single message; the server enforces the same limit. */
export const MAX_ATTACHMENTS = 10;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const mins = Math.floor(total / 60);
  return `${mins}:${String(total % 60).padStart(2, "0")}`;
}

export function toAttachmentInput(file: StagedFile): AttachmentInput {
  return {
    storageKey: file.storageKey,
    fileName: file.fileName ?? undefined,
    durationMs: file.durationMs,
  };
}

/** POST a local file to /media/upload as multipart, refreshing the session once. */
async function uploadFileUri(uri: string, mimeType: string, fileName?: string): Promise<MediaUploadResult> {
  const send = () => {
    const token = currentAccessToken();
    return new File(uri).upload(`${API_BASE}/media/upload`, {
      httpMethod: "POST",
      uploadType: UploadType.MULTIPART,
      fieldName: "file",
      mimeType,
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
  };
  let result = await send();
  if (result.status === 401 && (await tryRefresh())) result = await send();
  if (result.status < 200 || result.status >= 300) {
    let message = `Upload failed (${result.status})`;
    try {
      const body = JSON.parse(String(result.body ?? "{}")) as { error?: { message?: string } };
      if (body.error?.message) message = body.error.message;
    } catch {
      // non-JSON error body
    }
    throw new ApiRequestError(result.status, "UPLOAD_FAILED", message);
  }
  return JSON.parse(String(result.body)) as MediaUploadResult;
}

async function stage(uri: string, mimeType: string, fileName?: string): Promise<StagedFile> {
  const uploaded = await uploadFileUri(uri, mimeType, fileName);
  return {
    storageKey: uploaded.storageKey,
    kind: uploaded.kind === "OTHER" ? "DOCUMENT" : uploaded.kind,
    mimeType: uploaded.mimeType,
    fileName: uploaded.fileName ?? fileName ?? null,
    sizeBytes: uploaded.sizeBytes,
    uri,
  };
}

async function pickMedia(from: "library" | "camera", as: "images" | "videos"): Promise<StagedFile[]> {
  if (from === "library") {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) throw new Error("Convo needs photo access to send media.");
  } else {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) throw new Error("Convo needs camera access to take a photo.");
  }
  const options: ImagePicker.ImagePickerOptions = {
    mediaTypes: [as],
    quality: 82,
    allowsMultipleSelection: from === "library",
  };
  const result = from === "library"
    ? await ImagePicker.launchImageLibraryAsync(options)
    : await ImagePicker.launchCameraAsync({ ...options, allowsMultipleSelection: false });
  if (result.canceled) return [];
  return Promise.all(
    result.assets.map((asset) =>
      stage(asset.uri, asset.mimeType ?? (as === "images" ? "image/jpeg" : "video/mp4"), asset.fileName ?? undefined),
    ),
  );
}

/** Photo or video, from the library or the camera. */
export const pickPhotos = () => pickMedia("library", "images");
export const pickVideos = () => pickMedia("library", "videos");
export const takePhoto = () => pickMedia("camera", "images");
export const recordVideo = () => pickMedia("camera", "videos");

/** Any document from the system picker. */
export async function pickDocuments(): Promise<StagedFile[]> {
  const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
  if (result.canceled) return [];
  return Promise.all(
    result.assets.map((asset) => stage(asset.uri, asset.mimeType ?? "application/octet-stream", asset.name)),
  );
}

/**
 * Hold-to-record voice note. expo-audio's recorder is hook state, so it lives in
 * a component; the finished file is uploaded and handed back staged.
 */
export function VoiceNoteButton({
  disabled,
  onRecorded,
  onError,
}: {
  disabled?: boolean;
  onRecorded: (file: StagedFile) => void;
  onError: (message: string) => void;
}) {
  const palette = usePalette();
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [busy, setBusy] = useState(false);

  const toggle = async () => {
    if (busy) {
      setBusy(false);
      recorder.stop();
      const uri = recorder.uri;
      if (!uri) {
        onError("The recording was too short to send.");
        return;
      }
      try {
        onRecorded(await stage(uri, "audio/m4a", `voice-${Date.now()}.m4a`));
      } catch (err) {
        onError(err instanceof Error ? err.message : "Upload failed");
      }
      return;
    }
    const permission = await requestRecordingPermissionsAsync();
    if (!permission.granted) {
      onError("Convo needs microphone access to record a voice note.");
      return;
    }
    setBusy(true);
    recorder.prepareToRecordAsync().finally(() => recorder.record());
  };

  return (
    <Pressable
      onPress={() => void toggle()}
      disabled={disabled}
      style={{
        width: 42,
        height: 42,
        borderRadius: radius.pill,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: busy ? colors.danger : palette.raised,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {busy ? (
        <Text style={{ fontSize: 15, color: colors.white, fontWeight: "800" }}>■</Text>
      ) : (
        <Text style={{ fontSize: 17 }}>🎙️</Text>
      )}
    </Pressable>
  );
}

/** The composer's strip of staged files. */
export function AttachmentTray({
  files,
  busy,
  onRemove,
}: {
  files: StagedFile[];
  busy: boolean;
  onRemove: (storageKey: string) => void;
}) {
  const palette = usePalette();
  if (files.length === 0) return null;
  return (
    <View style={{ flexDirection: "row", gap: spacing.sm, marginBottom: spacing.sm }}>
      {busy && (
        <View style={{ width: 60, height: 60, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator color={colors.iris600} />
        </View>
      )}
      {files.map((file) => (
        <View
          key={file.storageKey}
          style={{
            width: 60,
            height: 60,
            borderRadius: radius.field,
            overflow: "hidden",
            backgroundColor: palette.raised,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {file.kind === "IMAGE" ? (
            <Image source={{ uri: file.uri }} style={{ width: 60, height: 60 }} resizeMode="cover" />
          ) : file.kind === "VIDEO" ? (
            <Text style={{ fontSize: 20 }}>🎞️</Text>
          ) : file.kind === "VOICE" ? (
            <Text style={{ fontSize: 18 }}>🎙️</Text>
          ) : (
            <Text numberOfLines={2} style={{ fontSize: 9, fontWeight: "700", color: palette.textMuted, textAlign: "center", paddingHorizontal: 3 }}>
              {(file.fileName ?? "FILE").split(".").pop()?.toUpperCase()}
            </Text>
          )}
          <Pressable
            onPress={() => onRemove(file.storageKey)}
            hitSlop={6}
            style={{ position: "absolute", top: 2, right: 2, width: 18, height: 18, borderRadius: 9, backgroundColor: "rgba(0,0,0,0.55)", alignItems: "center", justifyContent: "center" }}
          >
            <Text style={{ color: colors.white, fontSize: 11, lineHeight: 13 }}>×</Text>
          </Pressable>
        </View>
      ))}
    </View>
  );
}

/** Attach source sheet: camera, library, documents or a voice note. */
export function AttachSheet({
  visible,
  onClose,
  onPicked,
  onError,
}: {
  visible: boolean;
  onClose: () => void;
  onPicked: (files: StagedFile[]) => void;
  onError: (message: string) => void;
}) {
  const palette = usePalette();
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (label: string, fn: () => Promise<StagedFile[]>) => {
    setBusy(label);
    try {
      const files = await fn();
      if (files.length > 0) {
        onPicked(files);
        onClose();
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not attach that file");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Sheet visible={visible} onClose={busy ? () => {} : onClose} title="Send media">
      {([
        { label: "Take a photo", run: () => takePhoto() },
        { label: "Record a video", run: () => recordVideo() },
        { label: "Photo library", run: () => pickPhotos() },
        { label: "Video library", run: () => pickVideos() },
        { label: "Document", run: () => pickDocuments() },
      ] as const).map((option) => (
        <SheetButton
          key={option.label}
          label={busy === option.label ? "Uploading…" : option.label}
          palette={palette}
          onPress={() => void run(option.label, option.run)}
        />
      ))}
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
        <VoiceNoteButton
          disabled={busy !== null}
          onRecorded={(file) => {
            onPicked([file]);
            onClose();
          }}
          onError={onError}
        />
        <Text style={{ flex: 1, fontSize: 13, color: palette.textMuted }}>
          Tap the mic to start a voice note, tap again to stop and attach it.
        </Text>
      </View>
      <SheetButton label="Cancel" onPress={onClose} palette={palette} muted />
    </Sheet>
  );
}

/**
 * Should media load by itself right now? "Wi-Fi only" defers heavy
 * attachments (video, voice) until the device is on Wi-Fi — images always
 * stay cheap enough to render.
 */
export function useMediaAutoAllowed(account: Account): boolean {
  const network = useNetworkState();
  if (account.mediaAutoDownload !== "WIFI_ONLY") return true;
  return network.type === NetworkStateType.WIFI || network.type === NetworkStateType.ETHERNET;
}

/** Thumbnails + players inside a message bubble. */
export function MessageMedia({
  message,
  onViewOnce,
  allowAuto = true,
}: {
  message: Message;
  onViewOnce: () => void;
  allowAuto?: boolean;
}) {
  const palette = usePalette();
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [forcedIds, setForcedIds] = useState<string[]>([]);
  const media = message.attachments;
  if (media.length === 0) return null;

  if (message.type === "STICKER") {
    return (
      <View style={{ gap: spacing.xs, marginBottom: message.body ? 4 : 0 }}>
        {media.map((attachment) => (
          <Image
            key={attachment.id}
            source={{ uri: resolveMediaUrl(attachment.mediaUrl) ?? undefined }}
            style={{ width: 150, height: 150 }}
            resizeMode="contain"
          />
        ))}
      </View>
    );
  }

  if (message.viewOnce) {
    return (
      <Pressable
        onPress={() => !message.viewOnceOpened && onViewOnce()}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: spacing.sm,
          width: 200,
          borderRadius: radius.field,
          borderWidth: 1,
          borderColor: message.viewOnceOpened ? palette.border : colors.iris500,
          backgroundColor: message.viewOnceOpened ? palette.raised : colors.iris100,
          paddingHorizontal: 12,
          paddingVertical: 10,
          marginBottom: 4,
        }}
      >
        <Text style={{ fontSize: 15 }}>{message.viewOnceOpened ? "✓" : "🔒"}</Text>
        <Text style={{ fontSize: 13, fontWeight: "800", color: message.viewOnceOpened ? palette.textFaint : colors.iris700 }}>
          {message.viewOnceOpened ? "Opened" : "Tap to view"}
        </Text>
      </Pressable>
    );
  }

  const viewable = media.filter((a) => a.kind === "IMAGE" || a.kind === "VIDEO");

  return (
    <View style={{ gap: spacing.xs, marginBottom: message.body ? 4 : 0 }}>
      {media.map((attachment, index) =>
        attachment.kind === "IMAGE" ? (
          <Pressable
            key={attachment.id}
            onPress={() => setViewerIndex(viewable.findIndex((a) => a.id === attachment.id))}
          >
            <Image
              source={{ uri: resolveMediaUrl(attachment.mediaUrl) ?? undefined }}
              style={{ width: 240, height: 180, borderRadius: radius.field, backgroundColor: palette.raised }}
              resizeMode="cover"
            />
          </Pressable>
        ) : (attachment.kind === "VIDEO" || attachment.kind === "VOICE") && !allowAuto && !forcedIds.includes(attachment.id) ? (
          <DownloadGate
            key={attachment.id}
            attachment={attachment}
            onAllow={() => setForcedIds((prev) => [...prev, attachment.id])}
          />
        ) : attachment.kind === "VIDEO" ? (
          <VideoTile key={attachment.id} url={resolveMediaUrl(attachment.mediaUrl)} />
        ) : attachment.kind === "VOICE" ? (
          <VoiceTile
            key={attachment.id}
            url={resolveMediaUrl(attachment.mediaUrl)}
            durationMs={attachment.durationMs ?? null}
          />
        ) : (
          <DocumentTile
            key={attachment.id}
            attachment={attachment}
            url={resolveMediaUrl(attachment.mediaUrl)}
          />
        ),
      )}
      {viewerIndex !== null && viewable.length > 0 && (
        <MediaViewer attachments={viewable} index={viewerIndex} onIndex={setViewerIndex} onClose={() => setViewerIndex(null)} />
      )}
    </View>
  );
}

function VideoTile({ url }: { url: string | null }) {
  const player = useVideoPlayer(url ?? "", (instance) => {
    instance.pause();
  });
  if (!url) return null;
  return (
    <View style={{ width: 240, height: 180, borderRadius: radius.field, overflow: "hidden", backgroundColor: "black" }}>
      <VideoView player={player} style={{ flex: 1 }} contentFit="contain" nativeControls />
    </View>
  );
}

function VoiceTile({ url, durationMs }: { url: string | null; durationMs: number | null }) {
  const palette = usePalette();
  const player = useAudioPlayer(url ?? "");
  const status = useAudioPlayerStatus(player);
  if (!url) return null;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: spacing.sm,
        width: 240,
        borderRadius: radius.field,
        backgroundColor: palette.raised,
        paddingHorizontal: 12,
        paddingVertical: 9,
      }}
    >
      <Pressable
        onPress={() => (status.playing ? player.pause() : player.play())}
        hitSlop={6}
        style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: colors.iris600, alignItems: "center", justifyContent: "center" }}
      >
        <Text style={{ color: colors.white, fontSize: 12 }}>{status.playing ? "❚❚" : "▶"}</Text>
      </Pressable>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 12, fontWeight: "700", color: palette.textMuted }}>Voice message</Text>
        <View style={{ height: 3, borderRadius: 2, backgroundColor: palette.border, marginTop: 4 }}>
          <View
            style={{
              height: 3,
              borderRadius: 2,
              backgroundColor: colors.iris600,
              width: `${Math.min(100, Math.round((status.currentTime / Math.max(1, status.duration || (durationMs ?? 0) / 1000)) * 100))}%`,
            }}
          />
        </View>
      </View>
      {durationMs ? (
        <Text style={{ fontSize: 11, color: palette.textFaint }}>{formatDuration(durationMs)}</Text>
      ) : null}
    </View>
  );
}

function DocumentTile({ attachment, url }: { attachment: Attachment; url: string | null }) {
  const palette = usePalette();
  return (
    <Pressable
      onPress={() => {
        if (url) void Linking.openURL(url).catch(() => {});
      }}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: spacing.sm,
        width: 240,
        borderRadius: radius.field,
        borderWidth: 1,
        borderColor: palette.border,
        backgroundColor: palette.raised,
        paddingHorizontal: 12,
        paddingVertical: 10,
      }}
    >
      <Text style={{ fontSize: 17 }}>📄</Text>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ fontSize: 13, fontWeight: "700", color: palette.text }}>
          {attachment.fileName ?? "Document"}
        </Text>
        <Text style={{ fontSize: 11, color: palette.textFaint }}>{formatBytes(attachment.sizeBytes)}</Text>
      </View>
      <Text style={{ fontSize: 14, color: colors.iris600, fontWeight: "800" }}>↓</Text>
    </Pressable>
  );
}

/** Full-screen photo/video viewer with left-right paging. */
function MediaViewer({
  attachments,
  index,
  onIndex,
  onClose,
}: {
  attachments: Attachment[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
}) {
  const current = attachments[index];
  const url = resolveMediaUrl(current?.mediaUrl ?? null);
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: "rgba(6,8,16,0.96)" }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: spacing.md }}>
          <Text style={{ color: "rgba(255,255,255,0.7)", fontSize: 12 }}>
            {index + 1} / {attachments.length}
          </Text>
          <Pressable onPress={onClose} hitSlop={10}>
            <Text style={{ color: colors.white, fontSize: 22 }}>×</Text>
          </Pressable>
        </View>
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.md }}>
          {!url ? (
            <Text style={{ color: "rgba(255,255,255,0.7)" }}>This file is no longer available.</Text>
          ) : current?.kind === "VIDEO" ? (
            <VideoTile url={url} />
          ) : (
            <Image source={{ uri: url }} style={{ width: "100%", height: "80%" }} resizeMode="contain" />
          )}
        </View>
        <View style={{ flexDirection: "row", justifyContent: "space-between", padding: spacing.lg }}>
          <Pressable disabled={index === 0} onPress={() => onIndex(index - 1)} hitSlop={8}>
            <Text style={{ color: index === 0 ? "rgba(255,255,255,0.25)" : colors.white, fontSize: 20 }}>‹</Text>
          </Pressable>
          <Pressable disabled={index >= attachments.length - 1} onPress={() => onIndex(index + 1)} hitSlop={8}>
            <Text style={{ color: index >= attachments.length - 1 ? "rgba(255,255,255,0.25)" : colors.white, fontSize: 20 }}>›</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

/**
 * Tap-to-view overlay for view-once media. The POST happens here and only here,
 * so the single view is spent by an explicit gesture.
 */
export function ViewOnceSheet({ message, onClose }: { message: Message; onClose: (opened: boolean) => void }) {
  const palette = usePalette();
  const [attachments, setAttachments] = useState<Attachment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [index, setIndex] = useState(0);
  const [spent, setSpent] = useState(false);

  const open = async () => {
    if (spent) return;
    setSpent(true);
    try {
      const result = await api.openViewOnce(message.id);
      setAttachments(result.attachments);
      setRevealed(true);
    } catch (err) {
      setSpent(false);
      setError(
        err instanceof ApiRequestError && err.status === 409
          ? "This message has already been viewed."
          : err instanceof Error
            ? err.message
            : "Could not open this message",
      );
    }
  };

  const current = attachments?.[index];
  const url = resolveMediaUrl(current?.mediaUrl ?? null);

  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => onClose(spent)}>
      <View style={{ flex: 1, backgroundColor: revealed ? "rgba(0,0,0,0.97)" : "rgba(6,8,16,0.9)", padding: spacing.lg, alignItems: "center", justifyContent: "center" }}>
        {!revealed ? (
          <>
            <Text style={{ fontSize: 30, marginBottom: spacing.md }}>🔒</Text>
            <Text style={{ color: "rgba(255,255,255,0.8)", fontSize: 14, textAlign: "center", maxWidth: 280 }}>
              {error ?? "View once: the sender sees when you open this, and it disappears after one look."}
            </Text>
            <View style={{ flexDirection: "row", gap: spacing.sm, marginTop: spacing.lg }}>
              {!error && (
                <Pressable onPress={() => void open()} style={{ borderRadius: radius.pill, backgroundColor: colors.iris600, paddingHorizontal: 20, paddingVertical: 12 }}>
                  <Text style={{ color: colors.white, fontWeight: "800" }}>Tap to view</Text>
                </Pressable>
              )}
              <Pressable onPress={() => onClose(spent)} style={{ borderRadius: radius.pill, backgroundColor: palette.raised, paddingHorizontal: 20, paddingVertical: 12 }}>
                <Text style={{ color: palette.text, fontWeight: "700" }}>Close</Text>
              </Pressable>
            </View>
          </>
        ) : (
          <>
            <View style={{ flex: 1, width: "100%", alignItems: "center", justifyContent: "center" }}>
              {!url ? (
                <Text style={{ color: "rgba(255,255,255,0.7)" }}>This file is no longer available.</Text>
              ) : current?.kind === "VIDEO" ? (
                <VideoTile url={url} />
              ) : (
                <Image source={{ uri: url }} style={{ width: "100%", height: "70%" }} resizeMode="contain" />
              )}
            </View>
            {(attachments?.length ?? 0) > 1 && (
              <View style={{ flexDirection: "row", gap: spacing.lg, marginBottom: spacing.sm }}>
                <Pressable disabled={index === 0} onPress={() => setIndex(index - 1)} hitSlop={8}>
                  <Text style={{ color: colors.white, fontSize: 18 }}>‹</Text>
                </Pressable>
                <Text style={{ color: "rgba(255,255,255,0.7)", fontSize: 13 }}>{`${index + 1}/${attachments?.length ?? 0}`}</Text>
                <Pressable disabled={index >= (attachments?.length ?? 1) - 1} onPress={() => setIndex(index + 1)} hitSlop={8}>
                  <Text style={{ color: colors.white, fontSize: 18 }}>›</Text>
                </Pressable>
              </View>
            )}
            <Pressable onPress={() => onClose(spent)} hitSlop={10} style={{ position: "absolute", top: spacing.xl, right: spacing.lg }}>
              <Text style={{ color: colors.white, fontSize: 22 }}>×</Text>
            </Pressable>
          </>
        )}
      </View>
    </Modal>
  );
}

const GALLERY_TABS: Array<SharedMediaKind | "LINK"> = ["ALL", "IMAGE", "VIDEO", "DOCUMENT", "VOICE", "LINK"];

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** "Media, links and docs" grid for one chat. */
export function MediaGallerySheet({
  conversationId,
  visible,
  onClose,
  onViewOnce,
}: {
  conversationId: string;
  visible: boolean;
  onClose: () => void;
  onViewOnce: (message: Message) => void;
}) {
  const palette = usePalette();
  const [kind, setKind] = useState<SharedMediaKind | "LINK">("ALL");
  const [items, setItems] = useState<Message[]>([]);
  const [links, setLinks] = useState<ChatLinkItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ attachments: Attachment[]; index: number } | null>(null);

  const load = async (nextKind: SharedMediaKind | "LINK", after?: string | null) => {
    setLoading(true);
    setError(null);
    try {
      // "Links" reads the scrape cards stored on messages, not an attachment feed.
      if (nextKind === "LINK") {
        const page = await api.chatLinks(conversationId, after ?? undefined);
        setLinks((prev) => (after ? [...prev, ...page.links] : page.links));
        setCursor(page.nextCursor);
        return;
      }
      const page = await api.sharedMedia(conversationId, nextKind, after ?? undefined);
      setItems((prev) => (after ? [...prev, ...page.messages] : page.messages));
      setCursor(page.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load media");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (visible) void load(kind);
  }, [visible, conversationId, kind]);

  const isLinks = kind === "LINK";
  const rowCount = isLinks ? links.length : items.length;

  return (
    <Sheet visible={visible} onClose={onClose} title="Media in this chat">
      <View style={{ flexDirection: "row", gap: spacing.xs, flexWrap: "wrap" }}>
        {GALLERY_TABS.map((tab) => (
          <Pressable
            key={tab}
            onPress={() => {
              setKind(tab);
              void load(tab);
            }}
            style={{
              borderRadius: radius.pill,
              paddingHorizontal: 12,
              paddingVertical: 6,
              backgroundColor: kind === tab ? colors.iris100 : palette.raised,
            }}
          >
            <Text style={{ fontSize: 12, fontWeight: "800", color: kind === tab ? colors.iris700 : palette.textMuted }}>
              {tab === "ALL" ? "All" : tab === "LINK" ? "Links" : attachmentKindLabel(tab, null) ?? tab}
            </Text>
          </Pressable>
        ))}
      </View>
      {error && <Text style={{ fontSize: 13, color: colors.danger }}>{error}</Text>}
      {loading && rowCount === 0 ? (
        <View style={{ paddingVertical: spacing.lg, alignItems: "center" }}>
          <ActivityIndicator color={colors.iris600} />
        </View>
      ) : rowCount === 0 && !error ? (
        <Text style={{ fontSize: 13, color: palette.textFaint, textAlign: "center", paddingVertical: spacing.md }}>
          Nothing here yet.
        </Text>
      ) : isLinks ? (
        <ScrollView style={{ maxHeight: 320 }} contentContainerStyle={{ gap: spacing.sm }}>
          {links.map((link) => (
            <Pressable
              key={link.messageId}
              onPress={() => void Linking.openURL(link.url)}
              style={{
                borderWidth: 1,
                borderColor: palette.border,
                borderRadius: radius.field,
                padding: spacing.sm,
                gap: 2,
                backgroundColor: palette.surface,
              }}
            >
              <Text numberOfLines={1} style={{ fontSize: 13, fontWeight: "700", color: palette.text }}>
                {link.title ?? link.siteName ?? hostnameOf(link.url)}
              </Text>
              <Text numberOfLines={1} style={{ fontSize: 11, color: palette.textFaint }}>
                {link.url}
              </Text>
              <Text style={{ fontSize: 11, color: palette.textFaint }}>
                {link.senderDisplayName ?? "You"} · {relativeTime(link.createdAt)}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : (
        <ScrollView style={{ maxHeight: 320 }} contentContainerStyle={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
          {items.map((message) => {
            const first = message.attachments[0];
            if (!first) return null;
            const locked = message.viewOnce;
            const url = resolveMediaUrl(first.mediaUrl);
            return (
              <Pressable
                key={message.id}
                onPress={() => {
                  if (locked) onViewOnce(message);
                  else setPreview({ attachments: message.attachments, index: 0 });
                }}
                style={{ width: 92, height: 92, borderRadius: radius.field, overflow: "hidden", backgroundColor: palette.raised, alignItems: "center", justifyContent: "center" }}
              >
                {locked ? (
                  <Text style={{ fontSize: 18 }}>🔒</Text>
                ) : first.kind === "IMAGE" && url ? (
                  <Image source={{ uri: url }} style={{ width: 92, height: 92 }} resizeMode="cover" />
                ) : first.kind === "VIDEO" && url ? (
                  <Image source={{ uri: url }} style={{ width: 92, height: 92 }} resizeMode="cover" />
                ) : (
                  <Text numberOfLines={2} style={{ fontSize: 9, fontWeight: "700", color: palette.textMuted, textAlign: "center", paddingHorizontal: 4 }}>
                    {first.fileName ?? attachmentKindLabel(first.kind, null) ?? "File"}
                  </Text>
                )}
              </Pressable>
            );
          })}
        </ScrollView>
      )}
      {cursor && (
        <SheetButton label="Load more" onPress={() => void load(kind, cursor)} palette={palette} muted={loading} />
      )}
      <SheetButton label="Close" onPress={onClose} palette={palette} />
      {preview && (
        <MediaViewer
          attachments={preview.attachments}
          index={preview.index}
          onIndex={(index) => setPreview({ ...preview, index })}
          onClose={() => setPreview(null)}
        />
      )}
    </Sheet>
  );
}

/** Pick destination chats and re-post the selected messages by reference. */
export function ForwardSheet({
  messageIds,
  conversations,
  visible,
  onClose,
  onSent,
}: {
  messageIds: string[];
  conversations: ConversationSummary[];
  visible: boolean;
  onClose: () => void;
  onSent: (count: number) => void;
}) {
  const palette = usePalette();
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    if (picked.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.forwardMessages(messageIds, picked);
      onSent(result.created.length);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not forward");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet visible={visible} onClose={onClose} title={`Forward ${messageIds.length} message${messageIds.length === 1 ? "" : "s"}`}>
      <Text style={{ fontSize: 12, color: palette.textFaint }}>
        View-once messages cannot be forwarded — the single view stays with the recipient.
      </Text>
      <ScrollView style={{ maxHeight: 260 }} contentContainerStyle={{ gap: spacing.xs }}>
        {conversations.length === 0 ? (
          <Text style={{ fontSize: 13, color: palette.textFaint }}>You have no chats to forward to.</Text>
        ) : (
          conversations.map((conv) => {
            const label = conv.type === "GROUP" ? (conv.title ?? "Group") : (conv.peer?.displayName ?? conv.peer?.phone ?? "Unknown");
            const active = picked.includes(conv.id);
            return (
              <Pressable
                key={conv.id}
                onPress={() => setPicked((prev) => (active ? prev.filter((id) => id !== conv.id) : [...prev, conv.id]))}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: spacing.sm,
                  borderRadius: radius.field,
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                  backgroundColor: active ? colors.iris100 : palette.bg,
                }}
              >
                <View style={{ width: 18, height: 18, borderRadius: 4, borderWidth: 1, alignItems: "center", justifyContent: "center", borderColor: active ? colors.iris600 : palette.border, backgroundColor: active ? colors.iris600 : "transparent" }}>
                  {active && <Text style={{ color: colors.white, fontSize: 11, fontWeight: "900" }}>✓</Text>}
                </View>
                <Text numberOfLines={1} style={{ flex: 1, fontSize: 14, fontWeight: "700", color: palette.text }}>
                  {label}
                </Text>
              </Pressable>
            );
          })
        )}
      </ScrollView>
      {error && <Text style={{ fontSize: 13, color: colors.danger }}>{error}</Text>}
      <SheetButton label={busy ? "Forwarding…" : `Forward to ${picked.length} chat${picked.length === 1 ? "" : "s"}`} onPress={() => void send()} palette={palette} />
      <SheetButton label="Cancel" onPress={onClose} palette={palette} muted />
    </Sheet>
  );
}

/* ── Phase 5B extras: link previews, GIFs, location + contact sharing ── */

/** Tap-to-download stand-in for heavy media when auto-download is off. */
function DownloadGate({ attachment, onAllow }: { attachment: Attachment; onAllow: () => void }) {
  const palette = usePalette();
  return (
    <Pressable
      onPress={onAllow}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: spacing.sm,
        width: 240,
        borderRadius: radius.field,
        borderWidth: 1,
        borderColor: palette.border,
        backgroundColor: palette.raised,
        paddingHorizontal: 12,
        paddingVertical: 10,
      }}
    >
      <Text style={{ fontSize: 16 }}>⬇</Text>
      <Text style={{ fontSize: 13, fontWeight: "800", color: palette.textMuted }}>
        Download {attachment.kind === "VIDEO" ? "video" : "voice message"}
        {attachment.sizeBytes > 0 ? ` (${formatBytes(attachment.sizeBytes)})` : ""}
      </Text>
    </Pressable>
  );
}

/** Open Graph card for the first link in a message. */
export function LinkPreviewCard({ preview }: { preview: LinkPreview }) {
  const palette = usePalette();
  return (
    <Pressable
      onPress={() => void Linking.openURL(preview.url).catch(() => {})}
      style={{
        borderRadius: radius.field,
        borderWidth: 1,
        borderColor: palette.border,
        backgroundColor: palette.raised,
        overflow: "hidden",
        marginBottom: 4,
        width: 260,
      }}
    >
      {preview.image ? (
        <Image
          source={{ uri: preview.image }}
          style={{ width: "100%", height: 130, backgroundColor: palette.bg }}
          resizeMode="cover"
        />
      ) : null}
      <View style={{ padding: 10, gap: 2 }}>
        {preview.siteName ? (
          <Text numberOfLines={1} style={{ fontSize: 10, fontWeight: "800", letterSpacing: 0.4, textTransform: "uppercase", color: palette.textFaint }}>
            {preview.siteName}
          </Text>
        ) : null}
        {preview.title ? (
          <Text numberOfLines={2} style={{ fontSize: 13, fontWeight: "800", color: palette.text }}>
            {preview.title}
          </Text>
        ) : null}
        {preview.description ? (
          <Text numberOfLines={3} style={{ fontSize: 12, color: palette.textMuted }}>
            {preview.description}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

/** A shared pin: label + address, opening the map app on tap. */
export function LocationCard({ location }: { location: MessageLocation }) {
  const palette = usePalette();
  const mapsUrl = `https://www.google.com/maps?q=${location.latitude},${location.longitude}`;
  return (
    <Pressable
      onPress={() => void Linking.openURL(mapsUrl).catch(() => {})}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: spacing.sm,
        width: 260,
        borderRadius: radius.field,
        borderWidth: 1,
        borderColor: palette.border,
        backgroundColor: palette.raised,
        paddingHorizontal: 12,
        paddingVertical: 10,
        marginBottom: 4,
      }}
    >
      <Text style={{ fontSize: 18 }}>📍</Text>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ fontSize: 13, fontWeight: "800", color: palette.text }}>
          {location.name ?? "Shared location"}
        </Text>
        <Text numberOfLines={2} style={{ fontSize: 11, color: palette.textFaint }}>
          {location.address ?? `${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)}`}
        </Text>
      </View>
      <Text style={{ fontSize: 13, fontWeight: "800", color: colors.iris600 }}>Map ›</Text>
    </Pressable>
  );
}

/** A shared contact card; tapping opens the dialer / mail sheet. */
export function SharedContactCard({ card }: { card: SharedContact }) {
  const palette = usePalette();
  const open = () => {
    const target = card.phone
      ? `tel:${card.phone}`
      : card.email
        ? `mailto:${card.email}`
        : null;
    if (target) void Linking.openURL(target).catch(() => {});
  };
  return (
    <Pressable
      onPress={open}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: spacing.sm,
        width: 260,
        borderRadius: radius.field,
        borderWidth: 1,
        borderColor: palette.border,
        backgroundColor: palette.raised,
        paddingHorizontal: 12,
        paddingVertical: 10,
        marginBottom: 4,
      }}
    >
      <View
        style={{
          width: 38,
          height: 38,
          borderRadius: 19,
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
          backgroundColor: colors.iris100,
        }}
      >
        {card.avatarUrl ? (
          <Image source={{ uri: card.avatarUrl }} style={{ width: 38, height: 38 }} resizeMode="cover" />
        ) : (
          <Text style={{ fontSize: 15, fontWeight: "900", color: colors.iris700 }}>
            {card.displayName.charAt(0).toUpperCase()}
          </Text>
        )}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ fontSize: 13, fontWeight: "800", color: palette.text }}>
          {card.displayName}
        </Text>
        <Text numberOfLines={1} style={{ fontSize: 11, color: palette.textFaint }}>
          {card.phone ?? card.email ?? "Contact"}
        </Text>
      </View>
    </Pressable>
  );
}

/**
 * GIF picker. Searches run through our own /giphy proxy — the API key never
 * reaches the device. Picking downloads the GIF into Convo media storage, so
 * it stages exactly like a picked photo.
 */
export function GifSheet({
  visible,
  onClose,
  onPicked,
  onError,
}: {
  visible: boolean;
  onClose: () => void;
  onPicked: (files: StagedFile[]) => void;
  onError: (message: string) => void;
}) {
  const palette = usePalette();
  const [term, setTerm] = useState("");
  const [items, setItems] = useState<GiphyItem[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(false);
  const [pickingId, setPickingId] = useState<string | null>(null);

  const search = useCallback(
    async (q: string) => {
      setLoading(true);
      try {
        const result = await api.giphySearch(q.trim() || undefined, 18);
        setEnabled(result.enabled);
        setItems(result.items);
      } catch (err) {
        onError(err instanceof Error ? err.message : "GIF search failed");
      } finally {
        setLoading(false);
      }
    },
    [onError],
  );

  useEffect(() => {
    if (visible) {
      setTerm("");
      void search("");
    }
  }, [visible, search]);

  const pick = async (item: GiphyItem) => {
    setPickingId(item.id);
    try {
      const uploaded = await api.giphyUpload(item.id);
      onPicked([
        {
          storageKey: uploaded.storageKey,
          kind: "IMAGE",
          mimeType: uploaded.mimeType,
          fileName: uploaded.fileName,
          sizeBytes: uploaded.sizeBytes,
          uri: resolveMediaUrl(uploaded.downloadUrl) ?? uploaded.downloadUrl,
        },
      ]);
      onClose();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not fetch that GIF");
    } finally {
      setPickingId(null);
    }
  };

  return (
    <Sheet visible={visible} onClose={onClose} title="Send a GIF">
      <View style={{ flexDirection: "row", gap: spacing.sm }}>
        <TextInput
          value={term}
          onChangeText={setTerm}
          onSubmitEditing={() => void search(term)}
          placeholder="Search GIFs"
          placeholderTextColor={palette.textFaint}
          returnKeyType="search"
          style={{
            flex: 1,
            backgroundColor: palette.bg,
            borderColor: palette.border,
            borderWidth: 1,
            borderRadius: radius.field,
            paddingHorizontal: 12,
            paddingVertical: 9,
            fontSize: 14,
            color: palette.text,
          }}
        />
        <Pressable
          onPress={() => void search(term)}
          style={{ justifyContent: "center", paddingHorizontal: 14, borderRadius: radius.field, backgroundColor: palette.raised }}
        >
          <Text style={{ fontSize: 15, color: palette.textMuted }}>🔍</Text>
        </Pressable>
      </View>
      {!enabled ? (
        <Text style={{ fontSize: 13, color: palette.textMuted, paddingVertical: spacing.md, textAlign: "center" }}>
          GIF search is not configured on this server.
        </Text>
      ) : loading && items.length === 0 ? (
        <View style={{ paddingVertical: spacing.lg, alignItems: "center" }}>
          <ActivityIndicator color={colors.iris600} />
        </View>
      ) : (
        <ScrollView style={{ maxHeight: 340 }} contentContainerStyle={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
          {items.map((item) => (
            <Pressable
              key={item.id}
              onPress={() => void pick(item)}
              style={{ width: "47%", aspectRatio: 1.4, borderRadius: radius.field, overflow: "hidden", backgroundColor: palette.raised, alignItems: "center", justifyContent: "center" }}
            >
              <Image source={{ uri: item.previewUrl }} style={{ width: "100%", height: "100%" }} resizeMode="cover" />
              {pickingId === item.id && (
                <View
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: "rgba(0,0,0,0.35)",
                  }}
                >
                  <ActivityIndicator color={colors.white} />
                </View>
              )}
            </Pressable>
          ))}
        </ScrollView>
      )}
      <SheetButton label="Cancel" onPress={onClose} palette={palette} muted />
    </Sheet>
  );
}

/** Current-position picker for "Send pin". */
export function LocationSheet({
  visible,
  onClose,
  onSend,
}: {
  visible: boolean;
  onClose: () => void;
  onSend: (location: MessageLocation) => void;
}) {
  const palette = usePalette();
  const [coords, setCoords] = useState<{ latitude: number; longitude: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");

  const locate = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (!permission.granted) throw new Error("Convo needs location access to share a pin.");
      const recent = await Location.getLastKnownPositionAsync({ maxAge: 60_000 }).catch(() => null);
      const position = recent ?? (await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }));
      if (!position) throw new Error("Could not read your position — try again.");
      setCoords({ latitude: position.coords.latitude, longitude: position.coords.longitude });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not get your location");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (visible) {
      setName("");
      void locate();
    }
  }, [visible, locate]);

  const send = () => {
    if (!coords) return;
    onSend({
      latitude: coords.latitude,
      longitude: coords.longitude,
      ...(name.trim() ? { name: name.trim() } : {}),
    });
    onClose();
  };

  return (
    <Sheet visible={visible} onClose={onClose} title="Share your location">
      {busy ? (
        <View style={{ paddingVertical: spacing.lg, alignItems: "center" }}>
          <ActivityIndicator color={colors.iris600} />
        </View>
      ) : error ? (
        <>
          <Text style={{ fontSize: 13, color: colors.danger }}>{error}</Text>
          <SheetButton label="Try again" onPress={() => void locate()} palette={palette} />
        </>
      ) : coords ? (
        <>
          <Text style={{ fontSize: 13, fontWeight: "700", color: palette.text }}>
            📍 {coords.latitude.toFixed(5)}, {coords.longitude.toFixed(5)}
          </Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="My current location"
            placeholderTextColor={palette.textFaint}
            style={{
              backgroundColor: palette.bg,
              borderColor: palette.border,
              borderWidth: 1,
              borderRadius: radius.field,
              paddingHorizontal: 12,
              paddingVertical: 9,
              fontSize: 14,
              color: palette.text,
            }}
          />
          <SheetButton label="Send pin" onPress={send} palette={palette} />
        </>
      ) : null}
      <SheetButton label="Cancel" onPress={onClose} palette={palette} muted />
    </Sheet>
  );
}

/** Share one of your saved contacts as a card. */
export function ContactShareSheet({
  visible,
  onClose,
  onSend,
}: {
  visible: boolean;
  onClose: () => void;
  onSend: (card: SharedContact) => void;
}) {
  const palette = usePalette();
  const [contacts, setContacts] = useState<Contact[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setContacts(null);
    setError(null);
    api
      .listContacts()
      .then((list) => setContacts(list.contacts))
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load contacts"));
  }, [visible]);

  const share = (contact: Contact) => {
    onSend({
      ...(contact.convoUserId ? { userId: contact.convoUserId } : {}),
      displayName: contact.displayName,
      ...(contact.phone ? { phone: contact.phone } : {}),
      ...(contact.email ? { email: contact.email } : {}),
      ...(contact.avatarUrl ? { avatarUrl: contact.avatarUrl } : {}),
    });
    onClose();
  };

  return (
    <Sheet visible={visible} onClose={onClose} title="Share a contact">
      {error ? (
        <Text style={{ fontSize: 13, color: colors.danger }}>{error}</Text>
      ) : contacts === null ? (
        <View style={{ paddingVertical: spacing.lg, alignItems: "center" }}>
          <ActivityIndicator color={colors.iris600} />
        </View>
      ) : contacts.length === 0 ? (
        <Text style={{ fontSize: 13, color: palette.textFaint, textAlign: "center", paddingVertical: spacing.md }}>
          No saved contacts yet — add one from the contacts tab first.
        </Text>
      ) : (
        <ScrollView style={{ maxHeight: 300 }} contentContainerStyle={{ gap: spacing.xs }}>
          {contacts.map((contact) => (
            <Pressable
              key={contact.id}
              onPress={() => share(contact)}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: spacing.sm,
                borderRadius: radius.field,
                paddingHorizontal: 12,
                paddingVertical: 10,
                backgroundColor: palette.raised,
              }}
            >
              <Text style={{ fontSize: 16 }}>👤</Text>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text numberOfLines={1} style={{ fontSize: 14, fontWeight: "700", color: palette.text }}>
                  {contact.displayName}
                </Text>
                <Text numberOfLines={1} style={{ fontSize: 11, color: palette.textFaint }}>
                  {contact.phone ?? contact.email ?? "Contact"}
                </Text>
              </View>
            </Pressable>
          ))}
        </ScrollView>
      )}
      <SheetButton label="Cancel" onPress={onClose} palette={palette} muted />
    </Sheet>
  );
}
