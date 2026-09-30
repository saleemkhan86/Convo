import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Attachment,
  AttachmentKind,
  ChatLinkItem,
  Contact,
  ConversationSummary,
  LinkPreview,
  Message,
  MessageLocation,
  SharedContact,
  SharedMediaKind,
} from "@convo/shared";
import { api, ApiRequestError, type MediaUploadResult } from "../lib/api";
import { useAuth } from "../lib/auth";
import {
  DownloadIcon,
  ForwardIcon,
  ImageIcon,
  MapPinIcon,
  MicIcon,
  PaperclipIcon,
  PlayIcon,
  SearchIcon,
  ViewOnceIcon,
  XIcon,
} from "./icons";
import { Button, Input, Spinner, cx } from "./ui";

/**
 * Chat media (Phase 5B): the composer's attachment pipeline, media bubbles,
 * view-once viewing, the shared-media grid and forwarding.
 *
 * View-once media never arrives with a URL in a list payload, so nothing can be
 * downloaded quietly: `ViewOnceViewer` mints the URLs by POSTing /view-once at
 * the moment the recipient actually taps the tile — once per viewer.
 */

/** One file the composer is holding before the message is sent. */
export interface StagedFile {
  storageKey: string;
  kind: Attachment["kind"];
  mimeType: string;
  fileName: string | null;
  sizeBytes: number;
  /** Local object URL so the composer can preview without another request. */
  previewUrl: string;
  width?: number;
  height?: number;
  durationMs?: number;
}

/** Client-side cap on a single message; the server enforces the same limit. */
export const MAX_ATTACHMENTS = 10;

const DOC_ACCEPT = "application/pdf,application/msword,application/zip,text/plain,text/csv";
const OFFICE_ACCEPT =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document," +
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet," +
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

function kindOf(mimeType: string): Attachment["kind"] {
  if (mimeType.startsWith("image/")) return "IMAGE";
  if (mimeType.startsWith("video/")) return "VIDEO";
  if (mimeType.startsWith("audio/")) return "VOICE";
  return "DOCUMENT";
}

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

/** Human label for a media kind ("Photo", "Voice message", the file name…). */
export function attachmentKindLabel(kind: AttachmentKind | string | null, fileName: string | null): string | null {
  if (!kind || kind === "TEXT") return null;
  switch (kind) {
    case "IMAGE":
      return "Photo";
    case "VIDEO":
      return "Video";
    case "VOICE":
      return "Voice message";
    case "DOCUMENT":
      return fileName ?? "Document";
    case "LOCATION":
      return "Location";
    case "CONTACT":
      return "Contact card";
    default:
      return fileName ?? "Attachment";
  }
}

/** One-line description of a message for lists, the reply strip and reports. */
export function messageLabel(message: Message): string {
  if (message.viewOnce) return "View once";
  if (message.location) return "Location";
  if (message.contactCard) return "Contact card";
  const media = message.attachments[0];
  return message.body ?? attachmentKindLabel(media?.kind ?? null, media?.fileName ?? null) ?? "Message";
}

/** Read intrinsic pixel size so the server can store thumbnails' aspect. */
async function imageDimensions(url: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** Upload one picked file and stage it for the composer. */
export async function stageFile(file: File): Promise<StagedFile> {
  const result: MediaUploadResult = await api.uploadMedia(file);
  const previewUrl = URL.createObjectURL(file);
  const dims = result.kind === "IMAGE" ? await imageDimensions(previewUrl) : null;
  return {
    storageKey: result.storageKey,
    kind: result.kind === "OTHER" ? "DOCUMENT" : (result.kind as StagedFile["kind"]),
    mimeType: result.mimeType,
    fileName: result.fileName ?? file.name,
    sizeBytes: result.sizeBytes,
    previewUrl,
    width: dims?.width,
    height: dims?.height,
  };
}

export function toAttachmentInput(file: StagedFile) {
  return {
    storageKey: file.storageKey,
    fileName: file.fileName ?? undefined,
    width: file.width,
    height: file.height,
    durationMs: file.durationMs,
  };
}

export function AttachButton({
  disabled,
  onPicked,
}: {
  disabled?: boolean;
  onPicked: (files: File[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={`image/*,video/*,audio/*,${DOC_ACCEPT},${OFFICE_ACCEPT}`}
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length > 0) onPicked(files);
          e.target.value = "";
        }}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={disabled}
        title="Attach"
        aria-label="Attach"
        className="rounded-full p-2 text-ink-400 transition-colors hover:bg-ink-100 hover:text-ink-700 disabled:opacity-50 dark:hover:bg-night-raised dark:hover:text-ink-200"
      >
        <PaperclipIcon className="h-5 w-5" />
      </button>
    </>
  );
}

/**
 * Voice note recorder. MediaRecorder emits whatever the browser supports
 * (webm/ogg today); the server accepts any audio/* and files it as VOICE.
 */
export function VoiceRecorder({ onRecorded }: { onRecorded: (file: File, durationMs: number) => void }) {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const startedAt = useRef(0);

  const stop = () => {
    recorder.current?.stop();
  };

  const toggle = async () => {
    setError(null);
    if (recording) {
      stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      chunks.current = [];
      mr.ondataavailable = (e) => chunks.current.push(e.data);
      mr.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks.current, { type: mr.mimeType || "audio/webm" });
        const durationMs = Date.now() - startedAt.current;
        if (blob.size > 0) {
          onRecorded(new File([blob], `voice-${Date.now()}.webm`, { type: blob.type }), durationMs);
        }
        setRecording(false);
      };
      recorder.current = mr;
      startedAt.current = Date.now();
      mr.start();
      setRecording(true);
    } catch {
      setError("Microphone unavailable");
    }
  };

  return (
    <span className="relative">
      <button
        type="button"
        onClick={() => void toggle()}
        title={recording ? "Stop recording" : "Record a voice note"}
        aria-label={recording ? "Stop recording" : "Record a voice note"}
        className={cx(
          "rounded-full p-2 transition-colors",
          recording
            ? "bg-rose-500/15 text-rose-500"
            : "text-ink-400 hover:bg-ink-100 hover:text-ink-700 dark:hover:bg-night-raised dark:hover:text-ink-200",
        )}
      >
        <MicIcon className="h-5 w-5" />
      </button>
      {recording && <span className="absolute -right-0.5 -top-0.5 h-2 w-2 animate-pulse rounded-full bg-rose-500" />}
      {error && <span className="absolute -top-7 right-0 whitespace-nowrap text-[10px] text-rose-500">{error}</span>}
    </span>
  );
}

export function AttachmentTray({
  files,
  busy,
  onRemove,
}: {
  files: StagedFile[];
  busy: boolean;
  onRemove: (storageKey: string) => void;
}) {
  if (files.length === 0) return null;
  return (
    <div className="mb-2 flex flex-wrap gap-2">
      {files.map((file) => (
        <div
          key={file.storageKey}
          className="relative flex h-16 w-16 items-center justify-center overflow-hidden rounded-xl border border-ink-200 bg-ink-50 dark:border-night-border dark:bg-night-raised"
        >
          {busy ? (
            <Spinner />
          ) : file.kind === "IMAGE" ? (
            <img src={file.previewUrl} alt="" className="h-full w-full object-cover" />
          ) : file.kind === "VIDEO" ? (
            <video src={file.previewUrl} className="h-full w-full object-cover" />
          ) : file.kind === "VOICE" ? (
            <MicIcon className="h-5 w-5 text-ink-400" />
          ) : (
            <span className="px-1 text-center text-[9px] font-semibold text-ink-500">
              {file.fileName?.split(".").pop()?.toUpperCase() ?? "FILE"}
            </span>
          )}
          <button
            type="button"
            onClick={() => onRemove(file.storageKey)}
            aria-label="Remove attachment"
            className="absolute right-0.5 top-0.5 rounded-full bg-ink-900/60 p-0.5 text-white"
          >
            <XIcon className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Thumbnails + downloads inside a message bubble. */
export function MessageAttachments({
  message,
  onViewOnce,
}: {
  message: Message;
  onViewOnce: (message: Message) => void;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const media = message.attachments;
  if (media.length === 0) return null;

  // Stickers float on their own: no frame, no lightbox, just the art.
  if (message.type === "STICKER") {
    return (
      <div className="flex gap-1">
        {media.map((attachment) =>
          attachment.mediaUrl ? (
            <img
              key={attachment.id}
              src={attachment.mediaUrl}
              alt={attachment.fileName ?? "Sticker"}
              className="h-36 w-36 object-contain"
            />
          ) : null,
        )}
      </div>
    );
  }

  if (message.viewOnce) {
    const opened = message.viewOnceOpened;
    return (
      <button
        type="button"
        onClick={() => !opened && onViewOnce(message)}
        className={cx(
          "flex w-48 items-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold transition-colors",
          opened
            ? "cursor-default border-ink-200 text-ink-400 dark:border-night-border"
            : "border-iris-300 bg-iris-50 text-iris-600 hover:bg-iris-100 dark:border-iris-500/40 dark:bg-iris-500/15 dark:text-iris-300",
        )}
      >
        <ViewOnceIcon className="h-4 w-4 shrink-0" />
        {opened ? "Opened" : `Tap to view ${media.length > 1 ? `${media.length} items` : ""}`.trim()}
      </button>
    );
  }

  return (
    <div className="mb-1 space-y-1.5">
      {media.map((attachment, index) => (
        <AttachmentTile
          key={attachment.id}
          attachment={attachment}
          onExpand={
            attachment.kind === "IMAGE" || attachment.kind === "VIDEO"
              ? () => setOpen(index)
              : undefined
          }
        />
      ))}
      {open !== null && (
        <Lightbox
          attachments={media}
          index={open}
          onIndex={setOpen}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}

/**
 * Honor the account's media-auto-download preference (spec §24). WIFI_ONLY
 * defers heavy video/audio until the user taps, when the network does not
 * look like Wi-Fi. Images stay automatic — they are the chat, not the cost.
 */
export function useMediaAutoAllowed(): boolean {
  const { account } = useAuth();
  if (account?.mediaAutoDownload !== "WIFI_ONLY") return true;
  return isWifiNetwork();
}

function isWifiNetwork(): boolean {
  const conn = (navigator as unknown as {
    connection?: { type?: string; effectiveType?: string };
  }).connection;
  if (!conn) return true;
  if (conn.type === "wifi" || conn.effectiveType === "wifi") return true;
  if (conn.type && conn.type !== "unknown") return false;
  return conn.effectiveType ? ["4g"].includes(conn.effectiveType) : true;
}

function AttachmentTile({
  attachment,
  onExpand,
}: {
  attachment: Attachment;
  onExpand?: () => void;
}) {
  const autoAllowed = useMediaAutoAllowed();
  const [forced, setForced] = useState(false);
  const url = attachment.mediaUrl;
  if (!url) return null;

  const heavy = attachment.kind === "VIDEO" || attachment.kind === "VOICE";
  if (heavy && !autoAllowed && !forced) {
    return (
      <button
        type="button"
        onClick={() => setForced(true)}
        className="flex w-56 items-center gap-2 rounded-lg bg-black/5 px-2.5 py-2 text-xs font-medium hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/15"
      >
        {attachment.kind === "VIDEO" ? <PlayIcon className="h-4 w-4 shrink-0 opacity-70" /> : <MicIcon className="h-4 w-4 shrink-0 opacity-70" />}
        <span className="min-w-0 flex-1 truncate text-left">
          Download {attachment.kind === "VIDEO" ? "video" : "voice message"}
        </span>
        <span className="shrink-0 opacity-60">{formatBytes(attachment.sizeBytes)}</span>
      </button>
    );
  }

  if (attachment.kind === "IMAGE") {
    return (
      <button type="button" onClick={onExpand} className="block w-full overflow-hidden rounded-lg">
        <img src={url} alt={attachment.fileName ?? ""} className="max-h-64 w-full object-cover" />
      </button>
    );
  }
  if (attachment.kind === "VIDEO") {
    return (
      <video src={url} controls playsInline className="max-h-64 w-full rounded-lg bg-black" />
    );
  }
  if (attachment.kind === "VOICE") {
    return (
      <div className="w-56">
        <audio src={url} controls className="w-full" />
        {attachment.durationMs ? (
          <p className="mt-0.5 text-[10px] opacity-70">{formatDuration(attachment.durationMs)}</p>
        ) : null}
      </div>
    );
  }
  return (
    <a
      href={url}
      download={attachment.fileName ?? undefined}
      className="flex w-56 items-center gap-2 rounded-lg bg-black/5 px-2.5 py-2 text-xs font-medium hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/15"
    >
      <DownloadIcon className="h-4 w-4 shrink-0 opacity-70" />
      <span className="min-w-0 flex-1 truncate">{attachment.fileName ?? "Attachment"}</span>
      <span className="shrink-0 opacity-60">{formatBytes(attachment.sizeBytes)}</span>
    </a>
  );
}

/** Full-size media viewer with prev/next across one message's attachments. */
export function Lightbox({
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight" && index < attachments.length - 1) onIndex(index + 1);
      if (e.key === "ArrowLeft" && index > 0) onIndex(index - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, attachments.length, onClose, onIndex]);

  if (!current?.mediaUrl) return null;
  return (
    <div
      className="fixed inset-0 z-[60] flex flex-col items-center justify-center bg-ink-900/85 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div className="flex max-h-[80vh] w-full max-w-3xl items-center justify-center" onClick={(e) => e.stopPropagation()}>
        {current.kind === "VIDEO" ? (
          <video src={current.mediaUrl} controls autoPlay playsInline className="max-h-[80vh] w-full rounded-card" />
        ) : (
          <img src={current.mediaUrl} alt={current.fileName ?? ""} className="max-h-[80vh] w-auto rounded-card" />
        )}
      </div>
      <div className="mt-3 flex items-center gap-3" onClick={(e) => e.stopPropagation()}>
        {index > 0 && (
          <button className="text-xs font-semibold text-white/80 hover:text-white" onClick={() => onIndex(index - 1)}>
            Previous
          </button>
        )}
        <span className="text-xs text-white/60">
          {current.fileName ?? ""} {attachments.length > 1 ? `· ${index + 1}/${attachments.length}` : ""}
        </span>
        <a
          href={current.mediaUrl}
          download={current.fileName ?? undefined}
          className="text-xs font-semibold text-white/80 hover:text-white"
        >
          Download
        </a>
        {index < attachments.length - 1 && (
          <button className="text-xs font-semibold text-white/80 hover:text-white" onClick={() => onIndex(index + 1)}>
            Next
          </button>
        )}
      </div>
      <button
        onClick={onClose}
        aria-label="Close"
        className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
      >
        <XIcon className="h-5 w-5" />
      </button>
    </div>
  );
}

/**
 * Tap-to-view overlay for view-once media. The POST happens here and only here,
 * so the single view is spent by an explicit gesture; closing burns the message.
 */
export function ViewOnceViewer({
  message,
  onClose,
}: {
  message: Message;
  onClose: (opened: boolean) => void;
}) {
  const [attachments, setAttachments] = useState<Attachment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [index, setIndex] = useState(0);
  const spent = useRef(false);

  const open = async () => {
    if (spent.current) return;
    spent.current = true;
    try {
      const result = await api.openViewOnce(message.id);
      setAttachments(result.attachments);
      setRevealed(true);
    } catch (err) {
      spent.current = false;
      if (err instanceof ApiRequestError && err.status === 409) {
        setError("This message has already been viewed.");
        setAttachments([]);
      } else {
        setError(err instanceof Error ? err.message : "Could not open this message");
      }
    }
  };

  const finish = () => onClose(spent.current);

  if (!revealed) {
    return (
      <div className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-4 bg-ink-900/85 p-6 backdrop-blur-sm">
        <ViewOnceIcon className="h-10 w-10 text-white/70" />
        <p className="max-w-xs text-center text-sm text-white/80">
          {error ?? "View once: the sender can see when you open this, and it disappears after one look."}
        </p>
        <div className="flex gap-2">
          {!error && (
            <Button onClick={() => void open()}>
              <PlayIcon className="mr-1 h-4 w-4" /> Tap to view
            </Button>
          )}
          <Button variant="secondary" onClick={finish}>
            Close
          </Button>
        </div>
      </div>
    );
  }

  const current = attachments?.[index];
  return (
    <div className="fixed inset-0 z-[60] flex flex-col items-center justify-center bg-black p-4">
      {current?.mediaUrl ? (
        current.kind === "VIDEO" ? (
          <video src={current.mediaUrl} controls autoPlay playsInline className="max-h-[80vh] w-full" />
        ) : (
          <img src={current.mediaUrl} alt="" className="max-h-[80vh] w-auto" />
        )
      ) : (
        <p className="text-sm text-white/70">{attachments?.length ? "No media to show" : "This message is empty"}</p>
      )}
      {current && attachments && attachments.length > 1 && (
        <div className="mt-3 flex gap-3 text-xs font-semibold text-white/80">
          {index > 0 && <button onClick={() => setIndex(index - 1)}>Previous</button>}
          <span>{`${index + 1}/${attachments.length}`}</span>
          {index < attachments.length - 1 && <button onClick={() => setIndex(index + 1)}>Next</button>}
        </div>
      )}
      <button
        onClick={finish}
        aria-label="Close"
        className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
      >
        <XIcon className="h-5 w-5" />
      </button>
    </div>
  );
}

/**
 * Gallery tabs. `LINK` is not a SharedMediaKind: it reads the dedicated links
 * endpoint, which serves the scrape cards stored on messages (5E).
 */
const GALLERY_TABS: Array<SharedMediaKind | "LINK"> = [
  "ALL",
  "IMAGE",
  "VIDEO",
  "DOCUMENT",
  "VOICE",
  "LINK",
];

/** "Media, links and docs" grid for one chat. */
export function MediaGalleryDialog({
  conversationId,
  onClose,
  onOpenMessage,
}: {
  conversationId: string;
  onClose: () => void;
  onOpenMessage: (message: Message) => void;
}) {
  const [kind, setKind] = useState<SharedMediaKind | "LINK">("ALL");
  const [items, setItems] = useState<Message[] | null>(null);
  const [links, setLinks] = useState<ChatLinkItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (nextKind: SharedMediaKind | "LINK", after?: string | null) => {
      try {
        if (nextKind === "LINK") {
          const page = await api.chatLinks(conversationId, after ?? undefined);
          setLinks((prev) => (after ? [...(prev ?? []), ...page.links] : page.links));
          setCursor(page.nextCursor);
          return;
        }
        const page = await api.sharedMedia(conversationId, nextKind, after ?? undefined);
        setItems((prev) => (after ? [...(prev ?? []), ...page.messages] : page.messages));
        setCursor(page.nextCursor);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load media");
      }
    },
    [conversationId],
  );

  useEffect(() => {
    setItems(null);
    setLinks(null);
    setError(null);
    void load(kind);
  }, [kind, load]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-2xl animate-rise flex-col rounded-card border border-ink-200/70 bg-white shadow-xl dark:border-night-border dark:bg-night-surface"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 pt-4">
          <h2 className="text-base font-bold text-ink-900 dark:text-white">Media in this chat</h2>
          <button onClick={onClose} aria-label="Close" className="text-ink-400 hover:text-ink-600">
            <XIcon className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-3 flex gap-1 border-b border-ink-200/70 px-5 dark:border-night-border">
          {GALLERY_TABS.map((tab) => (
            <button
              key={tab}
              onClick={() => setKind(tab)}
              className={cx(
                "-mb-px border-b-2 px-3 pb-2 text-xs font-semibold transition-colors",
                kind === tab
                  ? "border-iris-500 text-iris-600 dark:text-iris-300"
                  : "border-transparent text-ink-400 hover:text-ink-600",
              )}
            >
              {tab === "ALL" ? "All" : tab === "LINK" ? "Links" : tab}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {error ? (
            <p className="text-sm text-rose-500">{error}</p>
          ) : kind === "LINK" ? (
            links === null ? (
              <div className="flex justify-center py-10"><Spinner /></div>
            ) : links.length === 0 ? (
              <p className="py-10 text-center text-sm text-ink-400">Nothing here yet.</p>
            ) : (
              <ul className="space-y-2">
                {links.map((link) => (
                  <li key={link.messageId}>
                    <a
                      href={link.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="block rounded-xl border border-ink-200/70 px-3 py-2 hover:bg-ink-50 dark:border-night-border dark:hover:bg-night-raised"
                    >
                      <span className="block truncate text-sm font-semibold text-ink-800 dark:text-ink-100">
                        {link.title ?? link.siteName ?? hostnameOf(link.url)}
                      </span>
                      <span className="block truncate text-[11px] text-ink-400">{link.url}</span>
                    </a>
                  </li>
                ))}
              </ul>
            )
          ) : items === null ? (
            <div className="flex justify-center py-10"><Spinner /></div>
          ) : items.length === 0 ? (
            <p className="py-10 text-center text-sm text-ink-400">Nothing here yet.</p>
          ) : (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {items.map((message) => (
                <GalleryTile key={message.id} message={message} onOpen={() => onOpenMessage(message)} />
              ))}
            </div>
          )}
          {cursor && (
            <Button
              variant="secondary"
              className="mt-4 w-full"
              onClick={() => void load(kind, cursor)}
            >
              Load more
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Hostname for a link card label; a malformed url just shows as-is. */
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function GalleryTile({ message, onOpen }: { message: Message; onOpen: () => void }) {
  const first = message.attachments[0];
  if (!first) return null;
  const locked = message.viewOnce;
  return (
    <button
      onClick={onOpen}
      title={`${message.body ?? ""} ${new Date(message.createdAt).toLocaleDateString()}`}
      className="relative flex aspect-square items-center justify-center overflow-hidden rounded-xl bg-ink-100 dark:bg-night-raised"
    >
      {locked || first.kind === "DOCUMENT" ? (
        <span className="flex flex-col items-center gap-1 px-1 text-center text-[10px] font-semibold text-ink-500">
          {locked ? <ViewOnceIcon className="h-5 w-5" /> : <ImageIcon className="h-5 w-5" />}
          {locked ? "View once" : (first.fileName ?? "File")}
        </span>
      ) : first.kind === "IMAGE" ? (
        <img src={first.mediaUrl ?? ""} alt="" className="h-full w-full object-cover" />
      ) : first.kind === "VIDEO" ? (
        <>
          <video src={first.mediaUrl ?? ""} className="h-full w-full object-cover" muted />
          <PlayIcon className="absolute h-6 w-6 text-white/90" />
        </>
      ) : (
        <MicIcon className="h-5 w-5 text-ink-500" />
      )}
    </button>
  );
}

/** Pick destination chats and re-post the selected messages by reference. */
export function ForwardDialog({
  messageIds,
  conversations,
  onClose,
  onSent,
}: {
  messageIds: string[];
  conversations: ConversationSummary[];
  onClose: () => void;
  onSent: (count: number) => void;
}) {
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
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="flex max-h-[80vh] w-full max-w-sm animate-rise flex-col rounded-card border border-ink-200/70 bg-white p-5 shadow-xl dark:border-night-border dark:bg-night-surface"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-base font-bold text-ink-900 dark:text-white">
            Forward {messageIds.length} message{messageIds.length === 1 ? "" : "s"}
          </h2>
          <button onClick={onClose} aria-label="Close" className="text-ink-400 hover:text-ink-600">
            <XIcon className="h-4 w-4" />
          </button>
        </div>
        <p className="mt-1 text-xs text-ink-400">
          View-once messages cannot be forwarded — the single view stays with the recipient.
        </p>
        <div className="mt-3 min-h-0 flex-1 overflow-y-auto">
          {conversations.length === 0 ? (
            <p className="py-6 text-center text-sm text-ink-400">You have no chats to forward to.</p>
          ) : (
            conversations.map((conv) => {
              const label = conv.type === "GROUP" ? (conv.title ?? "Group") : (conv.peer?.displayName ?? conv.peer?.phone ?? "Unknown");
              const active = picked.includes(conv.id);
              return (
                <button
                  key={conv.id}
                  onClick={() =>
                    setPicked((prev) => (prev.includes(conv.id) ? prev.filter((id) => id !== conv.id) : [...prev, conv.id]))
                  }
                  className={cx(
                    "flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left text-sm transition-colors",
                    active ? "bg-iris-50 dark:bg-iris-500/10" : "hover:bg-ink-50 dark:hover:bg-night-raised/60",
                  )}
                >
                  <span
                    className={cx(
                      "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                      active ? "border-iris-500 bg-iris-500 text-white" : "border-ink-300 dark:border-night-border",
                    )}
                  >
                    {active && <ForwardIcon className="h-3 w-3" />}
                  </span>
                  <span className="truncate font-medium text-ink-800 dark:text-ink-100">{label}</span>
                </button>
              );
            })
          )}
          {error && <p className="mt-2 text-xs text-rose-500">{error}</p>}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void send()} disabled={busy || picked.length === 0}>
            {busy ? "Forwarding…" : `Forward to ${picked.length || ""}${picked.length === 1 ? " chat" : picked.length ? " chats" : ""}`}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────── Phase 5B extras ───────────────────────

/** Open Graph card for the first link in a message; scraped after the send. */
export function LinkPreviewCard({ preview }: { preview: LinkPreview }) {
  return (
    <a
      href={preview.url}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className="mb-1 block w-64 max-w-full overflow-hidden rounded-lg border border-ink-200 bg-white text-ink-800 no-underline transition-colors hover:bg-ink-50 dark:border-night-border dark:bg-night-raised dark:text-ink-100 dark:hover:bg-night-surface"
    >
      {preview.image && (
        <img src={preview.image} alt="" loading="lazy" className="h-32 w-full bg-ink-100 object-cover dark:bg-night-surface" />
      )}
      <span className="block px-2.5 py-2">
        {preview.siteName && (
          <span className="block text-[10px] font-semibold uppercase tracking-wide text-ink-400">
            {preview.siteName}
          </span>
        )}
        {preview.title && <span className="mt-0.5 block truncate text-xs font-bold">{preview.title}</span>}
        {preview.description && (
          <span className="mt-0.5 line-clamp-2 block text-[11px] leading-snug text-ink-500 dark:text-ink-400">
            {preview.description}
          </span>
        )}
      </span>
    </a>
  );
}

/** Dropped pin (LOCATION message). The map link is built from the coordinates. */
export function LocationCard({ location }: { location: MessageLocation }) {
  const mapsUrl = `https://www.google.com/maps?q=${location.latitude},${location.longitude}`;
  return (
    <a
      href={mapsUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="mb-1 flex w-56 max-w-full items-center gap-2.5 rounded-lg border border-ink-200 bg-white px-2.5 py-2 text-ink-800 no-underline transition-colors hover:bg-ink-50 dark:border-night-border dark:bg-night-raised dark:text-ink-100 dark:hover:bg-night-surface"
    >
      <MapPinIcon className="h-8 w-8 shrink-0 text-rose-500" />
      <span className="min-w-0">
        <span className="block truncate text-xs font-bold">{location.name ?? "Shared location"}</span>
        <span className="block truncate text-[11px] text-ink-500 dark:text-ink-400">
          {location.address ?? `${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)}`}
        </span>
      </span>
    </a>
  );
}

/** Frozen contact card (CONTACT message). */
export function SharedContactCard({ card }: { card: SharedContact }) {
  return (
    <div className="mb-1 flex w-56 max-w-full items-center gap-2.5 rounded-lg border border-ink-200 bg-white px-2.5 py-2 dark:border-night-border dark:bg-night-raised">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-iris-500 to-signal-400 text-sm font-bold text-white">
        {card.displayName.charAt(0).toUpperCase()}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-xs font-bold text-ink-900 dark:text-white">{card.displayName}</span>
        {(card.phone || card.email) && (
          <span className="block truncate text-[11px] text-ink-500 dark:text-ink-400">
            {card.phone ?? card.email}
          </span>
        )}
      </span>
    </div>
  );
}

/** GIF search grid. Picking a GIF downloads it server-side and stages it. */
export function GifPickerDialog({
  onClose,
  onStaged,
}: {
  onClose: () => void;
  onStaged: (file: StagedFile) => void;
}) {
  const [term, setTerm] = useState("");
  const [items, setItems] = useState<{ id: string; previewUrl: string; title: string | null }[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (q: string) => {
    setError(null);
    try {
      const result = await api.giphySearch(q || undefined);
      setEnabled(result.enabled);
      setItems(result.items.map((g) => ({ id: g.id, previewUrl: g.previewUrl, title: g.title })));
    } catch (err) {
      setError(err instanceof Error ? err.message : "GIF search failed");
    }
  }, []);

  useEffect(() => {
    void load("");
  }, [load]);

  const pick = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      const result: MediaUploadResult = await api.giphyUpload(id);
      onStaged({
        storageKey: result.storageKey,
        kind: "IMAGE",
        mimeType: result.mimeType,
        fileName: result.fileName,
        sizeBytes: result.sizeBytes,
        previewUrl: result.downloadUrl,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add this GIF");
      setBusyId(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="flex max-h-[80vh] w-full max-w-lg animate-rise flex-col rounded-card border border-ink-200/70 bg-white shadow-xl dark:border-night-border dark:bg-night-surface"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 pt-4">
          <h2 className="text-base font-bold text-ink-900 dark:text-white">Send a GIF</h2>
          <button onClick={onClose} aria-label="Close" className="text-ink-400 hover:text-ink-600">
            <XIcon className="h-4 w-4" />
          </button>
        </div>
        <div className="px-5 pt-3">
          <div className="flex items-center gap-2 rounded-xl border border-ink-200 bg-ink-50 px-3 py-2 dark:border-night-border dark:bg-night-raised">
            <SearchIcon className="h-4 w-4 shrink-0 text-ink-400" />
            <input
              value={term}
              autoFocus
              placeholder="Search GIFs"
              onChange={(e) => setTerm(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void load(term.trim());
              }}
              className="w-full bg-transparent text-sm text-ink-900 placeholder:text-ink-400 focus:outline-none dark:text-white"
            />
            <button
              className="shrink-0 text-xs font-semibold text-iris-600 dark:text-iris-300"
              onClick={() => void load(term.trim())}
            >
              Search
            </button>
          </div>
        </div>
        <div className="mt-3 min-h-0 flex-1 overflow-y-auto p-5">
          {error ? (
            <p className="text-sm text-rose-500">{error}</p>
          ) : !enabled ? (
            <p className="py-10 text-center text-sm text-ink-400">
              GIF search is not configured on this server (GIPHY_API_KEY).
            </p>
          ) : items.length === 0 ? (
            <div className="flex justify-center py-10"><Spinner /></div>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {items.map((item) => (
                <button
                  key={item.id}
                  onClick={() => void pick(item.id)}
                  disabled={busyId !== null}
                  title={item.title ?? "GIF"}
                  className="relative overflow-hidden rounded-xl bg-ink-100 dark:bg-night-raised"
                >
                  <img src={item.previewUrl} alt="" loading="lazy" className="h-24 w-full object-cover" />
                  {busyId === item.id && (
                    <span className="absolute inset-0 flex items-center justify-center bg-ink-900/40"><Spinner /></span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Grab the browser's position and turn it into a LOCATION message. */
export function LocationShareDialog({
  onClose,
  onSend,
}: {
  onClose: () => void;
  onSend: (location: MessageLocation) => void;
}) {
  const [coords, setCoords] = useState<{ latitude: number; longitude: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");

  const locate = useCallback(() => {
    setError(null);
    if (!navigator.geolocation) {
      setError("This browser cannot share locations");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) =>
        setCoords({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        }),
      (err) => setError(err.message || "Could not get your location"),
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  }, []);

  useEffect(() => {
    locate();
  }, [locate]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-sm animate-rise rounded-card border border-ink-200/70 bg-white p-5 shadow-xl dark:border-night-border dark:bg-night-surface"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-bold text-ink-900 dark:text-white">Send your location</h2>
        {error ? (
          <>
            <p className="mt-2 text-sm text-rose-500">{error}</p>
            <div className="mt-4 flex gap-2">
              <Button variant="secondary" block onClick={onClose}>Close</Button>
              <Button block onClick={locate}>Try again</Button>
            </div>
          </>
        ) : !coords ? (
          <div className="flex items-center gap-2 py-6 text-sm text-ink-500"><Spinner /> Finding you…</div>
        ) : (
          <>
            <p className="mt-1 text-xs text-ink-400">
              {coords.latitude.toFixed(6)}, {coords.longitude.toFixed(6)}
            </p>
            <div className="mt-3">
              <Input
                label="Label (optional)"
                placeholder="My current location"
                value={name}
                autoFocus
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="mt-4 flex gap-2">
              <Button variant="secondary" block onClick={onClose}>Cancel</Button>
              <Button
                block
                onClick={() => {
                  onSend({
                    latitude: coords.latitude,
                    longitude: coords.longitude,
                    ...(name.trim() ? { name: name.trim() } : {}),
                  });
                  onClose();
                }}
              >
                Send pin
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Share one of the caller's saved contacts as a CONTACT message. */
export function ContactShareDialog({
  onClose,
  onSend,
}: {
  onClose: () => void;
  onSend: (card: SharedContact) => void;
}) {
  const [contacts, setContacts] = useState<Contact[] | null>(null);

  useEffect(() => {
    api.listContacts().then((list) => setContacts(list.contacts)).catch(() => setContacts([]));
  }, []);

  const share = (contact: Contact) => {
    onSend({
      displayName: contact.displayName,
      ...(contact.convoUserId ? { userId: contact.convoUserId } : {}),
      ...(contact.phone ? { phone: contact.phone } : {}),
      ...(contact.email ? { email: contact.email } : {}),
      ...(contact.avatarUrl ? { avatarUrl: contact.avatarUrl } : {}),
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="flex max-h-[70vh] w-full max-w-sm animate-rise flex-col rounded-card border border-ink-200/70 bg-white p-5 shadow-xl dark:border-night-border dark:bg-night-surface"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-bold text-ink-900 dark:text-white">Share a contact</h2>
        <div className="mt-2 min-h-0 flex-1 overflow-y-auto">
          {contacts === null ? (
            <div className="flex justify-center py-8"><Spinner /></div>
          ) : contacts.length === 0 ? (
            <p className="py-8 text-center text-sm text-ink-400">No saved contacts yet.</p>
          ) : (
            contacts.map((contact) => (
              <button
                key={contact.id}
                onClick={() => share(contact)}
                className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-ink-50 dark:hover:bg-night-raised"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-iris-500 to-signal-400 text-sm font-bold text-white">
                  {contact.displayName.charAt(0).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-ink-800 dark:text-ink-100">{contact.displayName}</span>
                  <span className="block truncate text-xs text-ink-400">{contact.phone ?? contact.email ?? ""}</span>
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
