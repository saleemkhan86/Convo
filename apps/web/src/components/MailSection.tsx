import { useCallback, useEffect, useRef, useState } from "react";
import type { MailMessage, MailThreadSummary, WsServerEvent } from "@convo/shared";
import { ArrowLeftIcon, CheckIcon, MailIcon } from "./icons";
import { Badge, Button, Input, Spinner, cx } from "./ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useRealtime, useRealtimeSubscription } from "../lib/realtime";

interface PendingMail {
  clientSendId: string;
  body: string;
  status: "sending" | "failed";
}

export function MailSection({ newMailNonce }: { newMailNonce: number }) {
  const { account } = useAuth();
  const { status: wsStatus } = useRealtime();
  const [threads, setThreads] = useState<MailThreadSummary[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MailMessage[]>([]);
  const [pending, setPending] = useState<PendingMail[]>([]);
  const [draft, setDraft] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showCompose, setShowCompose] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const myEmail = account?.email?.email ?? null;
  const selected = threads?.find((t) => t.id === selectedId) ?? null;

  // Header "New mail" button bumps newMailNonce to open the composer.
  const prevNonce = useRef(newMailNonce);
  useEffect(() => {
    if (newMailNonce !== prevNonce.current) {
      prevNonce.current = newMailNonce;
      setShowCompose(true);
    }
  }, [newMailNonce]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await api.listMailThreads();
        if (!cancelled) setThreads(list.threads);
      } catch (err) {
        if (!cancelled) setLoadError(errorMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const openThread = useCallback(async (threadId: string) => {
    setSelectedId(threadId);
    setMessages([]);
    setPending([]);
    setLoadError(null);
    try {
      const page = await api.listMailMessages(threadId);
      setMessages(page.messages);
      await api.markThreadRead(threadId).catch(() => {});
      setThreads((prev) =>
        prev?.map((t) => (t.id === threadId ? { ...t, unreadCount: 0 } : t)) ?? prev,
      );
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }, []);

  useRealtimeSubscription(
    useCallback(
      (event: WsServerEvent) => {
        if (event.type !== "mail.new") return;
        const { thread, message } = event;
        setThreads((prev) => {
          const list = prev ?? [];
          const merged: MailThreadSummary = {
            ...thread,
            unreadCount: thread.id === selectedId ? 0 : thread.unreadCount,
          };
          return [merged, ...list.filter((t) => t.id !== thread.id)];
        });
        if (thread.id === selectedId) {
          setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));
          void api.markThreadRead(thread.id).catch(() => {});
        }
      },
      [selectedId],
    ),
  );

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, pending.length]);

  const sendReply = async () => {
    const body = draft.trim();
    if (!body || !selectedId) return;
    setDraft("");
    const clientSendId = crypto.randomUUID();
    setPending((p) => [...p, { clientSendId, body, status: "sending" }]);
    try {
      const result = await api.replyMail(selectedId, { clientSendId, body });
      setPending((p) => p.filter((m) => m.clientSendId !== clientSendId));
      setMessages((prev) =>
        prev.some((m) => m.id === result.message.id) ? prev : [...prev, result.message],
      );
      setThreads((prev) =>
        prev?.map((t) =>
          t.id === result.thread.id ? { ...result.thread, unreadCount: 0 } : t,
        ) ?? prev,
      );
    } catch {
      setPending((p) => p.map((m) => (m.clientSendId === clientSendId ? { ...m, status: "failed" } : m)));
    }
  };

  const onComposed = async (to: string[], subject: string, body: string): Promise<string | null> => {
    try {
      const result = await api.composeMail({ clientSendId: crypto.randomUUID(), to, subject: subject || undefined, body });
      setShowCompose(false);
      setThreads((prev) => [result.thread, ...(prev ?? []).filter((t) => t.id !== result.thread.id)]);
      await openThread(result.thread.id);
      return null;
    } catch (err) {
      return errorMessage(err);
    }
  };

  if (loadError && !threads) return <CenteredError message={loadError} />;

  return (
    <div className="flex h-full min-h-0">
      {/* Thread list */}
      <div className={cx("w-full shrink-0 flex-col border-r border-ink-200/70 md:flex md:w-80 dark:border-night-border", selectedId ? "hidden md:flex" : "flex")}>
        <div className="flex items-center justify-between px-4 py-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">
            Inbox
            {wsStatus !== "open" && <span className="ml-2 font-normal normal-case text-amber-500">reconnecting…</span>}
          </p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {threads === null ? (
            <div className="flex justify-center py-10"><Spinner /></div>
          ) : threads.length === 0 ? (
            <div className="px-6 py-10 text-center">
              <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-ink-100 text-ink-400 dark:bg-night-raised">
                <MailIcon className="h-5 w-5" />
              </span>
              <p className="mt-3 text-sm font-semibold text-ink-800 dark:text-ink-100">No mail yet</p>
              <p className="mt-1 text-xs text-ink-400">Compose a message to anyone — Convo users or external addresses.</p>
            </div>
          ) : (
            threads.map((thread) => (
              <ThreadRow
                key={thread.id}
                thread={thread}
                active={thread.id === selectedId}
                myEmail={myEmail}
                onClick={() => void openThread(thread.id)}
              />
            ))
          )}
        </div>
      </div>

      {/* Thread view */}
      <div className={cx("min-w-0 flex-1 flex-col", selectedId ? "flex" : "hidden md:flex")}>
        {selected ? (
          <>
            <div className="flex items-start gap-3 border-b border-ink-200/70 bg-white px-4 py-3 dark:border-night-border dark:bg-night-surface">
              <button className="mt-0.5 md:hidden" onClick={() => setSelectedId(null)} aria-label="Back">
                <ArrowLeftIcon className="h-5 w-5 text-ink-500" />
              </button>
              <div className="min-w-0">
                <p className="truncate text-sm font-bold text-ink-900 dark:text-white">
                  {threadTitle(selected, myEmail)}
                </p>
                <p className="truncate text-xs text-ink-400">{participantsLabel(selected, myEmail)}</p>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto bg-ink-50/60 px-4 py-4 dark:bg-night-raised/40">
              {messages.map((msg) => (
                <MailBubble key={msg.id} message={msg} mine={msg.direction === "OUTBOUND"} />
              ))}
              {pending.map((p) => (
                <div key={p.clientSendId} className="mb-2 flex justify-end">
                  <div className="max-w-[75%] rounded-bubble rounded-br-md bg-iris-500/60 px-3.5 py-2 text-sm text-white">
                    <p className="whitespace-pre-wrap break-words">{p.body}</p>
                    <p className="mt-0.5 text-right text-[10px] text-white/80">
                      {p.status === "failed" ? "Not sent — tap to retry" : "Sending…"}
                    </p>
                  </div>
                </div>
              ))}
              <div ref={bottomRef} />
            </div>

            <div className="border-t border-ink-200/70 bg-white p-3 dark:border-night-border dark:bg-night-surface">
              <div className="flex items-end gap-2">
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void sendReply();
                    }
                  }}
                  rows={1}
                  placeholder="Reply…"
                  className="max-h-32 min-h-[42px] flex-1 resize-none rounded-xl border border-ink-200 bg-ink-50 px-3.5 py-2.5 text-sm placeholder:text-ink-400 focus:border-iris-400 focus:outline-none dark:border-night-border dark:bg-night-raised dark:text-ink-100"
                />
                <Button className="!px-4" onClick={() => void sendReply()} disabled={draft.trim().length === 0}>
                  Send
                </Button>
              </div>
            </div>
          </>
        ) : (
          <div className="flex h-full items-center justify-center p-6">
            <div className="max-w-xs text-center">
              <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-ink-100 text-ink-400 dark:bg-night-raised">
                <MailIcon className="h-6 w-6" />
              </span>
              <h2 className="mt-4 text-lg font-bold text-ink-900 dark:text-white">Select a conversation</h2>
              <p className="mt-1.5 text-sm text-ink-500 dark:text-ink-400">
                Mail arrives chat-style. Convo users get it instantly; external addresses go out over email.
              </p>
            </div>
          </div>
        )}
      </div>

      {showCompose && <ComposeDialog onClose={() => setShowCompose(false)} onSend={onComposed} />}
    </div>
  );
}

function ThreadRow({
  thread,
  active,
  myEmail,
  onClick,
}: {
  thread: MailThreadSummary;
  active: boolean;
  myEmail: string | null;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cx(
        "flex w-full items-center gap-3 px-4 py-3 text-left transition-colors",
        active ? "bg-iris-50 dark:bg-iris-500/10" : "hover:bg-ink-50 dark:hover:bg-night-raised/60",
      )}
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-iris-500 to-signal-400 font-bold text-white">
        {initialOf(threadTitle(thread, myEmail))}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <p className="truncate text-sm font-semibold text-ink-900 dark:text-white">{threadTitle(thread, myEmail)}</p>
          {thread.lastMessage && (
            <span className="shrink-0 text-[11px] text-ink-400">{relativeTime(thread.lastMessage.createdAt)}</span>
          )}
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <p className="truncate text-xs text-ink-500 dark:text-ink-400">{previewText(thread)}</p>
          {thread.unreadCount > 0 && (
            <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-iris-500 px-1.5 text-[11px] font-bold text-white">
              {thread.unreadCount > 99 ? "99+" : thread.unreadCount}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

function MailBubble({ message, mine }: { message: MailMessage; mine: boolean }) {
  return (
    <div className={cx("mb-2 flex", mine ? "justify-end" : "justify-start")}>
      <div
        className={cx(
          "max-w-[75%] rounded-bubble px-3.5 py-2 text-sm shadow-sm",
          mine
            ? "rounded-br-md bg-iris-500 text-white"
            : "rounded-bl-md bg-white text-ink-800 dark:bg-night-surface dark:text-ink-100",
        )}
      >
        <p className="whitespace-pre-wrap break-words">{message.bodyText}</p>
        <p className={cx("mt-0.5 text-right text-[10px]", mine ? "text-white/75" : "text-ink-400")}>
          {clockTime(message.createdAt)}
          {mine && <CheckIcon className="ml-1 inline h-3 w-3" />}
        </p>
      </div>
    </div>
  );
}

function ComposeDialog({
  onClose,
  onSend,
}: {
  onClose: () => void;
  onSend: (to: string[], subject: string, body: string) => Promise<string | null>;
}) {
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [showSubject, setShowSubject] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const addresses = to.split(/[,\s]+/).map((a) => a.trim()).filter(Boolean);
  const canSend = addresses.length > 0 && body.trim().length > 0;

  const submit = async () => {
    setBusy(true);
    const err = await onSend(addresses, subject.trim(), body.trim());
    setBusy(false);
    if (err) setError(err);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-md animate-rise rounded-card border border-ink-200/70 bg-white p-6 shadow-xl dark:border-night-border dark:bg-night-surface"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-bold text-ink-900 dark:text-white">New mail</h2>
        <div className="mt-4 space-y-3">
          <Input
            label="To"
            placeholder="person@example.com"
            value={to}
            autoFocus
            onChange={(e) => { setTo(e.target.value); setError(null); }}
            hint="Separate multiple addresses with commas"
            error={error ?? undefined}
          />
          <button
            type="button"
            className="text-xs font-semibold text-iris-600 hover:underline dark:text-iris-400"
            onClick={() => setShowSubject((s) => !s)}
          >
            {showSubject ? "− Hide subject" : "+ Add subject"}
          </button>
          {showSubject && (
            <Input label="Subject" placeholder="Subject (optional)" value={subject} onChange={(e) => setSubject(e.target.value)} />
          )}
          <div>
            <label className="mb-1 block text-xs font-semibold text-ink-500 dark:text-ink-400">Message</label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={5}
              placeholder="Write your message…"
              className="w-full resize-none rounded-xl border border-ink-200 bg-ink-50 px-3.5 py-2.5 text-sm placeholder:text-ink-400 focus:border-iris-400 focus:outline-none dark:border-night-border dark:bg-night-raised dark:text-ink-100"
            />
          </div>
        </div>
        <div className="mt-5 flex gap-2">
          <Button variant="secondary" block onClick={onClose}>Cancel</Button>
          <Button block loading={busy} onClick={() => void submit()} disabled={!canSend}>Send</Button>
        </div>
      </div>
    </div>
  );
}

function CenteredError({ message }: { message: string }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-sm text-center">
        <Badge tone="neutral">Connection problem</Badge>
        <p className="mt-3 text-sm text-ink-500 dark:text-ink-400">{message}</p>
      </div>
    </div>
  );
}

// ────────────────────────────── helpers ──────────────────────────────

function otherParticipants(thread: MailThreadSummary, myEmail: string | null): string[] {
  return thread.participants
    .filter((p) => p.address !== myEmail)
    .map((p) => p.displayName ?? p.address);
}

function threadTitle(thread: MailThreadSummary, myEmail: string | null): string {
  if (thread.subject) return thread.subject;
  const others = otherParticipants(thread, myEmail);
  return others[0] ?? "Conversation";
}

function participantsLabel(thread: MailThreadSummary, myEmail: string | null): string {
  const others = thread.participants
    .filter((p) => p.address !== myEmail)
    .map((p) => p.address);
  return others.join(", ");
}

function previewText(thread: MailThreadSummary): string {
  const last = thread.lastMessage;
  if (!last) return "No messages yet";
  return last.bodyText ?? "";
}

function initialOf(name: string): string {
  return name.replace(/[^\p{L}\p{N}]/gu, "").charAt(0).toUpperCase() || "?";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong";
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString();
}

function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
