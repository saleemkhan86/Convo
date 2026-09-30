import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StatusItem, StatusVisibility, WsServerEvent } from "@convo/shared";
import { PencilIcon, TrashIcon, XIcon, BellOffIcon, PauseIcon, PlayIcon, SendIcon } from "./icons";
import { Badge, Button, Input, Spinner, cx } from "./ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { newClientMessageId } from "../lib/outbox";
import { useRealtimeSubscription } from "../lib/realtime";

/**
 * Status tab (Phase 4B): 24h stories — text, photo, video or link — posted to
 * an audience the author chooses, with a WhatsApp-style viewer and view counts.
 * Phase 5D adds replies that open a chat with the author, muting an author's
 * updates, the author-side read-receipt switch, and pause/seek in the viewer.
 */

const DURATIONS = [
  { hours: 6, label: "6 hours" },
  { hours: 12, label: "12 hours" },
  { hours: 24, label: "24 hours" },
  { hours: 48, label: "2 days" },
];

const AUDIENCES: Array<{ value: StatusVisibility; label: string; hint: string }> = [
  { value: "EVERYONE", label: "Everyone", hint: "Any Convo account can see it" },
  { value: "CONTACTS", label: "My contacts", hint: "Only people you saved" },
  { value: "CUSTOM", label: "Only these people", hint: "Pick a custom list" },
  { value: "CONTACTS_EXCEPT", label: "My contacts except…", hint: "Hide from chosen people" },
];

export function StatusSection() {
  const { account } = useAuth();
  const [mine, setMine] = useState<StatusItem[]>([]);
  const [others, setOthers] = useState<StatusItem[]>([]);
  const [muted, setMuted] = useState<Set<string>>(new Set());
  const [showMutes, setShowMutes] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [composing, setComposing] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [list, mutes] = await Promise.all([api.listStatuses(), api.listStatusMutes()]);
      setMine(list.mine);
      setOthers(list.others);
      setMuted(new Set(mutes.items.map((m) => m.userId)));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load statuses");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useRealtimeSubscription(
    useCallback(
      (event: WsServerEvent) => {
        if (event.type === "status.new") {
          setOthers((prev) => [event.status, ...prev.filter((s) => s.id !== event.status.id)]);
        }
        if (event.type === "status.viewed") {
          setMine((prev) =>
            prev.map((s) =>
              s.id === event.statusId
                ? { ...s, viewCount: (s.viewCount ?? 0) + 1, hasViews: true }
                : s,
            ),
          );
        }
      },
      [],
    ),
  );

  // Muting is private per viewer, so it filters here as well as on the server.
  const feed = useMemo(() => others.filter((s) => !muted.has(s.author.userId)), [others, muted]);
  const current = openIndex !== null ? feed[openIndex] : null;

  const openStatus = async (index: number) => {
    setOpenIndex(index);
    const status = feed[index];
    if (status && !status.seenByMe && status.author.userId !== account?.id) {
      setOthers((prev) => prev.map((s) => (s.id === status.id ? { ...s, seenByMe: true } : s)));
      await api.markStatusViewed(status.id).catch(() => {});
    }
  };

  /** Mute/unmute one author, keeping the local list in step immediately. */
  const toggleMute = async (authorId: string) => {
    const wasMuted = muted.has(authorId);
    setMuted((prev) => {
      const next = new Set(prev);
      if (wasMuted) next.delete(authorId);
      else next.add(authorId);
      return next;
    });
    try {
      if (wasMuted) await api.unmuteStatusAuthor(authorId);
      else await api.muteStatusAuthor(authorId);
    } catch {
      setMuted((prev) => {
        const next = new Set(prev);
        if (wasMuted) next.add(authorId);
        else next.delete(authorId);
        return next;
      });
    }
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="h-7 w-7 text-iris-500" />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-ink-200/70 bg-white px-4 py-4 dark:border-night-border dark:bg-night-surface">
        <div className="flex flex-wrap gap-3">
          <button
            onClick={() => setComposing(true)}
            className="flex flex-col items-center gap-1.5"
          >
            <span className="flex h-14 w-14 items-center justify-center rounded-full border-2 border-dashed border-ink-300 text-ink-400 transition-colors hover:border-iris-500 hover:text-iris-500 dark:border-night-border">
              <PencilIcon className="h-5 w-5" />
            </span>
            <span className="text-[11px] font-semibold text-ink-500">Add status</span>
          </button>

          {mine.length > 0 && (
            <button className="flex flex-col items-center gap-1.5" onClick={() => mine[0] && void openOwn(mine[0])}>
              <span className="flex h-14 w-14 items-center justify-center rounded-full border-2 border-ink-300 p-0.5 dark:border-night-border">
                <span className="flex h-full w-full items-center justify-center overflow-hidden rounded-full bg-ink-100 text-sm font-bold text-ink-500 dark:bg-night-raised">
                  {(mine[0]!.author.displayName ?? "?").charAt(0).toUpperCase()}
                </span>
              </span>
              <span className="text-[11px] font-semibold text-ink-500">
                My status · {mine.length}
              </span>
            </button>
          )}

          {feed.map((status, index) => (
            <button key={status.id} className="flex flex-col items-center gap-1.5" onClick={() => void openStatus(index)}>
              <span
                className={cx(
                  "flex h-14 w-14 items-center justify-center rounded-full p-0.5",
                  status.seenByMe ? "bg-ink-300 dark:bg-night-border" : "bg-gradient-to-br from-iris-500 to-signal-400",
                )}
              >
                <span className="flex h-full w-full items-center justify-center overflow-hidden rounded-full bg-ink-100 text-sm font-bold text-ink-600 ring-2 ring-white dark:bg-night-raised dark:text-ink-200 dark:ring-night-surface">
                  {(status.author.displayName ?? "?").charAt(0).toUpperCase()}
                </span>
              </span>
              <span className="max-w-16 truncate text-[11px] font-semibold text-ink-500">
                {status.author.displayName ?? "Convo user"}
              </span>
            </button>
          ))}
        </div>
        {error && <p className="mt-3 text-xs text-rose-600">{error}</p>}
        {muted.size > 0 && (
          <button
            onClick={() => setShowMutes(true)}
            className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-ink-500 hover:text-iris-600"
          >
            <BellOffIcon className="h-3.5 w-3.5" />
            {muted.size} muted {muted.size === 1 ? "author" : "authors"}
          </button>
        )}
        {feed.length === 0 && mine.length === 0 && (
          <p className="mt-3 text-xs text-ink-400">
            No statuses right now. Post one and it disappears {DURATIONS[2]?.label.toLowerCase() ?? "24 hours"} after you share it.
          </p>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-ink-50/60 p-4 dark:bg-night-raised/40">
        <h2 className="mb-3 text-xs font-bold uppercase tracking-wide text-ink-400">Recent updates</h2>
        <ul className="space-y-2">
          {feed.map((status, index) => (
            <li key={status.id}>
              <button
                onClick={() => void openStatus(index)}
                className="flex w-full items-center gap-3 rounded-card border border-ink-200/70 bg-white p-3 text-left transition-shadow hover:shadow-sm dark:border-night-border dark:bg-night-surface"
              >
                <span
                  className={cx(
                    "flex h-10 w-10 items-center justify-center rounded-full p-0.5",
                    status.seenByMe ? "bg-ink-300 dark:bg-night-border" : "bg-gradient-to-br from-iris-500 to-signal-400",
                  )}
                >
                  <span className="flex h-full w-full items-center justify-center rounded-full bg-ink-100 text-xs font-bold text-ink-600 dark:bg-night-raised dark:text-ink-200">
                    {(status.author.displayName ?? "?").charAt(0).toUpperCase()}
                  </span>
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-ink-900 dark:text-white">
                    {status.author.displayName ?? "Convo user"}
                  </span>
                  <span className="block truncate text-xs text-ink-400">
                    {status.kind === "TEXT" || status.kind === "URL"
                      ? status.text
                      : status.kind === "IMAGE"
                        ? "Photo"
                        : "Video"}{" "}
                    · expires {expiresLabel(status.expiresAt)}
                  </span>
                </span>
                <Badge tone={status.seenByMe ? "neutral" : "iris"}>{status.seenByMe ? "Seen" : "New"}</Badge>
              </button>
            </li>
          ))}
        </ul>

        {mine.length > 0 && (
          <>
            <h2 className="mb-3 mt-6 text-xs font-bold uppercase tracking-wide text-ink-400">My statuses</h2>
            <ul className="space-y-2">
              {mine.map((status) => (
                <li
                  key={status.id}
                  id={`own-${status.id}`}
                  className="flex items-center gap-3 rounded-card border border-ink-200/70 bg-white p-3 dark:border-night-border dark:bg-night-surface"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-ink-900 dark:text-white">
                      {status.kind === "TEXT" || status.kind === "URL" ? status.text : status.kind}
                    </span>
                    <span className="block text-xs text-ink-400">
                      {status.viewCount ?? 0} views
                      {status.shareReadReceipts ? "" : " · receipts off"} · expires{" "}
                      {expiresLabel(status.expiresAt)}
                    </span>
                  </span>
                  <OwnViewsButton statusId={status.id} />
                  <button
                    onClick={() => void api.deleteStatus(status.id).then(refresh)}
                    className="text-ink-400 hover:text-rose-600"
                    aria-label="Delete status"
                  >
                    <TrashIcon className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      {current && (
        <StatusViewer
          statuses={feed}
          index={openIndex ?? 0}
          muted={muted.has(current.author.userId)}
          onToggleMute={(authorId) => void toggleMute(authorId)}
          onJump={(i) => void openStatus(i)}
          onAdvance={() => {
            const next = (openIndex ?? 0) + 1;
            if (next >= feed.length) setOpenIndex(null);
            else void openStatus(next);
          }}
          onBack={() => {
            const prev = (openIndex ?? 0) - 1;
            if (prev < 0) setOpenIndex(null);
            else setOpenIndex(prev);
          }}
          onClose={() => setOpenIndex(null)}
        />
      )}

      {composing && (
        <StatusComposer
          selfUserId={account?.id ?? ""}
          onClose={() => setComposing(false)}
          onPosted={() => {
            setComposing(false);
            void refresh();
          }}
        />
      )}

      {showMutes && (
        <MutedAuthorsDialog
          onClose={() => setShowMutes(false)}
          onUnmuted={(authorId) =>
            setMuted((prev) => {
              const next = new Set(prev);
              next.delete(authorId);
              return next;
            })
          }
        />
      )}
    </div>
  );
}

/** The one screen where a muted author can be found again: WhatsApp's list. */
function MutedAuthorsDialog({
  onClose,
  onUnmuted,
}: {
  onClose: () => void;
  onUnmuted: (authorId: string) => void;
}) {
  const [items, setItems] = useState<Awaited<ReturnType<typeof api.listStatusMutes>>["items"] | null>(
    null,
  );

  useEffect(() => {
    void api.listStatusMutes().then((r) => setItems(r.items));
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xs animate-rise rounded-card border border-ink-200/70 bg-white p-4 shadow-xl dark:border-night-border dark:bg-night-surface"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="mb-2 text-sm font-bold text-ink-900 dark:text-white">Muted status updates</p>
        <ul className="max-h-56 space-y-1 overflow-y-auto">
          {!items && <li className="py-4 text-center text-xs text-ink-400">Loading…</li>}
          {items && items.length === 0 && (
            <li className="py-4 text-center text-xs text-ink-400">Nobody is muted.</li>
          )}
          {items?.map((m) => (
            <li key={m.userId} className="flex items-center justify-between gap-2 text-sm">
              <span className="truncate text-ink-700 dark:text-ink-200">
                {m.displayName ?? "Convo user"}
              </span>
              <button
                onClick={() => {
                  void api.unmuteStatusAuthor(m.userId).then(() => onUnmuted(m.userId));
                  setItems((prev) => (prev ?? []).filter((x) => x.userId !== m.userId));
                }}
                className="text-xs font-semibold text-iris-600 hover:underline"
              >
                Unmute
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function openOwn(status: StatusItem): void {
  // Own statuses are managed in the list below the rail; scroll into view.
  document.getElementById(`own-${status.id}`)?.scrollIntoView({ behavior: "smooth" });
}

function expiresLabel(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "now";
  const hours = Math.floor(ms / 3600_000);
  if (hours < 1) return `in ${Math.max(1, Math.round(ms / 60_000))}m`;
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.floor(hours / 24)}d`;
}

function OwnViewsButton({ statusId }: { statusId: string }) {
  const [viewers, setViewers] = useState<Awaited<ReturnType<typeof api.statusViewers>>["viewers"] | null>(null);
  return (
    <>
      <button
        onClick={() => {
          void api.statusViewers(statusId).then((r) => setViewers(r.viewers));
        }}
        className="text-xs font-semibold text-iris-600 hover:underline"
      >
        Viewed by
      </button>
      {viewers && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4 backdrop-blur-sm" onClick={() => setViewers(null)}>
          <div
            className="w-full max-w-xs animate-rise rounded-card border border-ink-200/70 bg-white p-4 shadow-xl dark:border-night-border dark:bg-night-surface"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="mb-2 text-sm font-bold text-ink-900 dark:text-white">Viewed by ({viewers.length})</p>
            <ul className="max-h-56 space-y-1 overflow-y-auto">
              {viewers.length === 0 && <li className="py-4 text-center text-xs text-ink-400">Nobody yet.</li>}
              {viewers.map((v) => (
                <li key={v.userId} className="flex items-center justify-between gap-2 text-sm text-ink-700 dark:text-ink-200">
                  <span className="truncate">{v.displayName ?? "Convo user"}</span>
                  <span className="text-[11px] text-ink-400">{new Date(v.viewedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </>
  );
}

const AUTOPLAY_MS = 6000;

function StatusViewer({
  statuses,
  index,
  muted,
  onToggleMute,
  onJump,
  onAdvance,
  onBack,
  onClose,
}: {
  statuses: StatusItem[];
  index: number;
  muted: boolean;
  onToggleMute: (authorId: string) => void;
  onJump: (index: number) => void;
  onAdvance: () => void;
  onBack: () => void;
  onClose: () => void;
}) {
  const status = statuses[index];
  const [progress, setProgress] = useState(0);
  const [paused, setPaused] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [replyState, setReplyState] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  const elapsed = useRef(0);
  const video = useRef<HTMLVideoElement | null>(null);
  /** Hold-to-pause only counts while the pointer stays down on the media. */
  const holding = useRef(false);

  useEffect(() => {
    setProgress(0);
    elapsed.current = 0;
    setDraft("");
    setReplyState(null);
    setError(null);
    timer.current = window.setInterval(() => {
      // A paused viewer stops the clock instead of jumping the moment it
      // resumes, so reading a long caption or typing a reply is possible.
      if (paused || holding.current) return;
      elapsed.current += 100;
      const pct = Math.min(100, (elapsed.current / AUTOPLAY_MS) * 100);
      setProgress(pct);
      if (pct >= 100) onAdvance();
    }, 100);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.id, paused]);

  useEffect(() => {
    const node = video.current;
    if (!node) return;
    if (paused) node.pause();
    else void node.play().catch(() => {});
  }, [paused, status?.id]);

  if (!status) return null;

  /** Tap the running bar to jump forward/back inside this status. */
  const seekWithin = (bar: HTMLElement, clientX: number) => {
    const rect = bar.getBoundingClientRect();
    const pct = Math.min(100, Math.max(0, ((clientX - rect.left) / rect.width) * 100));
    elapsed.current = (pct / 100) * AUTOPLAY_MS;
    setProgress(pct);
    const node = video.current;
    if (node && Number.isFinite(node.duration)) node.currentTime = (pct / 100) * node.duration;
  };

  const sendReply = async () => {
    const body = draft.trim();
    if (!body) return;
    setSending(true);
    setError(null);
    try {
      await api.replyToStatus(status.id, { clientMessageId: newClientMessageId(), body });
      setDraft("");
      setReplyState("Reply sent — it is waiting in your chat with them.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send the reply");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-ink-900/95 backdrop-blur">
      <div className="flex gap-1 px-4 pt-4">
        {statuses.map((s, i) => (
          <button
            key={s.id}
            className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/25"
            onClick={(event) => {
              if (i === index) seekWithin(event.currentTarget, event.clientX);
              else onJump(i);
            }}
            aria-label={`Status ${i + 1} of ${statuses.length}`}
          >
            <span
              className="block h-full bg-white transition-[width] duration-100"
              style={{ width: i < index ? "100%" : i === index ? `${progress}%` : "0%" }}
            />
          </button>
        ))}
      </div>
      <div className="flex items-center justify-between px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-bold text-white">{status.author.displayName ?? "Convo user"}</p>
          <p className="text-[11px] text-white/70">
            {expiresLabel(status.expiresAt)}
            {muted ? " · author muted" : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setPaused(!paused)}
            aria-label={paused ? "Resume" : "Pause"}
            className="text-white/80 hover:text-white"
          >
            {paused ? <PlayIcon className="h-5 w-5" /> : <PauseIcon className="h-5 w-5" />}
          </button>
          <button
            onClick={() => onToggleMute(status.author.userId)}
            aria-label={muted ? "Unmute author" : "Mute author"}
            className={cx("hover:text-white", muted ? "text-signal-300" : "text-white/80")}
          >
            <BellOffIcon className="h-5 w-5" />
          </button>
          <button onClick={onClose} aria-label="Close" className="text-white/80 hover:text-white">
            <XIcon className="h-6 w-6" />
          </button>
        </div>
      </div>

      <div
        className="relative flex min-h-0 flex-1 items-center justify-center p-4"
        onPointerDown={() => {
          holding.current = true;
        }}
        onPointerUp={() => {
          holding.current = false;
        }}
        onPointerLeave={() => {
          holding.current = false;
        }}
      >
        <button className="absolute left-0 top-0 h-full w-1/3" onClick={onBack} aria-label="Previous" />
        <button className="absolute right-0 top-0 h-full w-1/3" onClick={onAdvance} aria-label="Next" />
        {status.kind === "TEXT" && (
          <p className="max-w-lg whitespace-pre-wrap break-words rounded-card bg-gradient-to-br from-iris-600 to-signal-500 p-8 text-center text-xl font-semibold text-white">
            {status.text}
          </p>
        )}
        {status.kind === "URL" && (
          <a
            href={status.text ?? "#"}
            target="_blank"
            rel="noreferrer"
            className="max-w-md rounded-card border border-white/20 bg-white/10 p-8 text-center text-lg font-semibold text-white hover:bg-white/20"
          >
            {status.text}
          </a>
        )}
        {status.kind === "IMAGE" && status.mediaUrl && (
          <img src={status.mediaUrl} alt="" className="max-h-full max-w-full rounded-card object-contain" />
        )}
        {status.kind === "VIDEO" && status.mediaUrl && (
          <video
            ref={video}
            src={status.mediaUrl}
            autoPlay
            controls
            className="max-h-full max-w-full rounded-card"
          />
        )}
        {paused && (
          <span className="pointer-events-none absolute bottom-3 right-3 rounded-full bg-black/50 px-2 py-1 text-[11px] font-semibold text-white">
            Paused
          </span>
        )}
      </div>

      {replyState && <p className="px-4 text-center text-xs text-signal-300">{replyState}</p>}
      {error && <p className="px-4 text-center text-xs text-rose-400">{error}</p>}
      <div className="flex items-center gap-2 px-4 pb-5 pt-3">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void sendReply();
          }}
          placeholder={`Reply to ${status.author.displayName ?? "this status"}`}
          className="min-w-0 flex-1 rounded-full border border-white/20 bg-white/10 px-4 py-2 text-sm text-white placeholder:text-white/50 focus:border-white/40 focus:outline-none"
        />
        <button
          onClick={() => void sendReply()}
          disabled={!draft.trim() || sending}
          aria-label="Send reply"
          className="rounded-full bg-white/15 p-2 text-white transition-colors hover:bg-white/25 disabled:opacity-40"
        >
          <SendIcon className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
}

function StatusComposer({
  selfUserId,
  onClose,
  onPosted,
}: {
  selfUserId: string;
  onClose: () => void;
  onPosted: () => void;
}) {
  const [kind, setKind] = useState<"TEXT" | "IMAGE" | "VIDEO" | "URL">("TEXT");
  const [text, setText] = useState("");
  const [media, setMedia] = useState<{ storageKey: string; mimeType: string; previewUrl: string } | null>(null);
  const [hours, setHours] = useState(24);
  const [visibility, setVisibility] = useState<StatusVisibility>("EVERYONE");
  const [shareReceipts, setShareReceipts] = useState(true);
  const [people, setPeople] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const result = await api.uploadMedia(file);
      setMedia({
        storageKey: result.storageKey,
        mimeType: result.mimeType,
        previewUrl: URL.createObjectURL(file),
      });
      setKind(result.kind === "VIDEO" ? "VIDEO" : "IMAGE");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
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
        text: kind === "IMAGE" || kind === "VIDEO" ? (text.trim() || undefined) : text.trim(),
        storageKey: kind === "IMAGE" || kind === "VIDEO" ? media?.storageKey : undefined,
        mimeType: kind === "IMAGE" || kind === "VIDEO" ? media?.mimeType : undefined,
        durationHours: hours,
        visibility,
        userIds,
        shareReadReceipts: shareReceipts,
      });
      onPosted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not post your status");
      setBusy(false);
    }
  };

  const needsUpload = (kind === "IMAGE" || kind === "VIDEO") && !media;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-md animate-rise rounded-card border border-ink-200/70 bg-white p-6 shadow-xl dark:border-night-border dark:bg-night-surface"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-ink-900 dark:text-white">New status</h2>
          <button onClick={onClose} aria-label="Close" className="text-ink-400 hover:text-ink-600">
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-4 flex gap-1 rounded-full bg-ink-100 p-1 dark:bg-night-raised">
          {(["TEXT", "IMAGE", "VIDEO", "URL"] as const).map((option) => (
            <button
              key={option}
              onClick={() => setKind(option)}
              className={cx(
                "flex-1 rounded-full py-1.5 text-xs font-semibold transition-colors",
                kind === option
                  ? "bg-white text-ink-900 shadow-sm dark:bg-night-surface dark:text-white"
                  : "text-ink-500",
              )}
            >
              {option === "TEXT" ? "Text" : option === "URL" ? "Link" : option === "IMAGE" ? "Photo" : "Video"}
            </button>
          ))}
        </div>

        <div className="mt-4 space-y-4">
          {(kind === "IMAGE" || kind === "VIDEO") && (
            <div>
              <input
                ref={fileRef}
                type="file"
                accept={kind === "IMAGE" ? "image/*" : "video/*"}
                className="hidden"
                onChange={(e) => void pickFile(e.target.files?.[0])}
              />
              <button
                onClick={() => fileRef.current?.click()}
                className="w-full rounded-card border-2 border-dashed border-ink-300 p-6 text-sm text-ink-500 transition-colors hover:border-iris-400 dark:border-night-border"
              >
                {uploading ? "Uploading…" : media ? "Replace selection" : `Choose a ${kind === "IMAGE" ? "photo" : "video"}`}
              </button>
              {media && (
                <div className="mt-2 overflow-hidden rounded-xl bg-ink-100 dark:bg-night-raised">
                  {kind === "IMAGE" ? (
                    <img src={media.previewUrl} alt="" className="max-h-40 w-full object-contain" />
                  ) : (
                    <video src={media.previewUrl} className="max-h-40 w-full" controls />
                  )}
                </div>
              )}
              <Input
                className="mt-3"
                label="Caption (optional)"
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </div>
          )}

          {(kind === "TEXT" || kind === "URL") && (
            <Input
              label={kind === "TEXT" ? "What's on your mind?" : "Link (https://…)"}
              value={text}
              autoFocus
              onChange={(e) => setText(e.target.value)}
              placeholder={kind === "TEXT" ? "Say something" : "https://example.com"}
            />
          )}

          <div>
            <p className="mb-1.5 text-sm font-medium text-ink-600 dark:text-ink-300">Disappears after</p>
            <div className="flex flex-wrap gap-2">
              {DURATIONS.map((d) => (
                <button
                  key={d.hours}
                  onClick={() => setHours(d.hours)}
                  className={cx(
                    "rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors",
                    hours === d.hours
                      ? "border-iris-500 bg-iris-50 text-iris-700 dark:bg-iris-500/15 dark:text-iris-300"
                      : "border-ink-200 text-ink-500 dark:border-night-border",
                  )}
                >
                  {d.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="mb-1.5 text-sm font-medium text-ink-600 dark:text-ink-300">Who can see it</p>
            <div className="space-y-1">
              {AUDIENCES.map((option) => (
                <label key={option.value} className="flex cursor-pointer items-start gap-2">
                  <input
                    type="radio"
                    name="audience"
                    checked={visibility === option.value}
                    onChange={() => setVisibility(option.value)}
                    className="mt-1 h-4 w-4 accent-iris-600"
                  />
                  <span>
                    <span className="block text-sm text-ink-700 dark:text-ink-200">{option.label}</span>
                    <span className="block text-[11px] text-ink-400">{option.hint}</span>
                  </span>
                </label>
              ))}
            </div>
            {(visibility === "CUSTOM" || visibility === "CONTACTS_EXCEPT") && (
              <Input
                className="mt-3"
                label="User ids"
                value={people}
                onChange={(e) => setPeople(e.target.value)}
                placeholder="clx…, clx…"
                hint="Comma or space separated account ids."
              />
            )}
          </div>

          <label className="flex cursor-pointer items-start gap-2">
            <input
              type="checkbox"
              checked={shareReceipts}
              onChange={(e) => setShareReceipts(e.target.checked)}
              className="mt-1 h-4 w-4 accent-iris-600"
            />
            <span>
              <span className="block text-sm text-ink-700 dark:text-ink-200">Show who viewed it</span>
              <span className="block text-[11px] text-ink-400">
                Off means views are never recorded for this status — not even for you.
              </span>
            </span>
          </label>

          {error && <p className="text-sm text-rose-600">{error}</p>}

          <Button block loading={busy} disabled={needsUpload || uploading || !text.trim() && kind !== "IMAGE" && kind !== "VIDEO" || (selfUserId.length === 0)} onClick={() => void submit()}>
            {kind === "TEXT" ? "Post status" : kind === "URL" ? "Share link" : "Share media"}
          </Button>
        </div>
      </div>
    </div>
  );
}
