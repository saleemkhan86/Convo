import { useCallback, useEffect, useRef, useState } from "react";
import type { ConversationSummary, Message, WsServerEvent } from "@convo/shared";
import { ArrowLeftIcon, ChatIcon, CheckIcon, PlusIcon } from "./icons";
import { Badge, Button, Input, Spinner, cx } from "./ui";
import { api, ApiRequestError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useRealtime, useRealtimeSubscription } from "../lib/realtime";
import {
  addToOutbox,
  loadOutbox,
  newClientMessageId,
  removeFromOutbox,
  type OutboxItem,
} from "../lib/outbox";

interface PendingMessage {
  clientMessageId: string;
  body: string;
  status: "sending" | "failed";
}

export function ChatsSection({ newChatNonce }: { newChatNonce: number }) {
  const { account } = useAuth();
  const { status: wsStatus, send: wsSend } = useRealtime();
  const [conversations, setConversations] = useState<ConversationSummary[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [typingUntil, setTypingUntil] = useState(0);
  const [peerOnline, setPeerOnline] = useState<Record<string, boolean>>({});
  const [showNewChat, setShowNewChat] = useState(false);
  const [outbox, setOutbox] = useState<OutboxItem[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const typingSentAt = useRef(0);
  const typingTimer = useRef<number | null>(null);

  const selected = conversations?.find((c) => c.id === selectedId) ?? null;

  // Header "New chat" button bumps newChatNonce to open the dialog.
  // Compare the previous value instead of a first-run flag: StrictMode
  // invokes effects twice, which would consume a boolean flag immediately.
  const prevNonce = useRef(newChatNonce);
  useEffect(() => {
    if (newChatNonce !== prevNonce.current) {
      prevNonce.current = newChatNonce;
      setShowNewChat(true);
    }
  }, [newChatNonce]);

  // Initial conversation list + persisted outbox.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await api.listConversations();
        if (!cancelled) {
          setConversations(list.conversations);
          setOutbox(loadOutbox());
        }
      } catch (err) {
        if (!cancelled) setLoadError(errorMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Replay the offline outbox whenever the connection (re)establishes.
  useEffect(() => {
    if (wsStatus !== "open") return;
    const items = loadOutbox();
    if (items.length === 0) return;
    (async () => {
      for (const item of items) {
        try {
          await api.sendMessage(item.conversationId, {
            clientMessageId: item.clientMessageId,
            body: item.body,
          });
          setOutbox(removeFromOutbox(item.clientMessageId));
          setPending((p) => p.filter((m) => m.clientMessageId !== item.clientMessageId));
        } catch (err) {
          if (err instanceof ApiRequestError && err.status < 500 && err.code !== "RATE_LIMITED") {
            // Permanent rejection (e.g. lost membership): drop it instead of retrying forever.
            setOutbox(removeFromOutbox(item.clientMessageId));
            setPending((p) => p.filter((m) => m.clientMessageId !== item.clientMessageId));
          }
        }
      }
      const list = await api.listConversations().catch(() => null);
      if (list) setConversations(list.conversations);
    })();
  }, [wsStatus]);

  // Load timeline when a conversation is opened.
  const openConversation = useCallback(async (conversationId: string) => {
    setSelectedId(conversationId);
    setMessages([]);
    setLoadError(null);
    try {
      const page = await api.listMessages(conversationId);
      setMessages(page.messages);
      await api.markRead(conversationId).catch(() => {});
      setConversations((prev) =>
        prev?.map((c) => (c.id === conversationId ? { ...c, unreadCount: 0 } : c)) ?? prev,
      );
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }, []);

  // Realtime events.
  useRealtimeSubscription(
    useCallback(
      (event: WsServerEvent) => {
        if (event.type === "message.new") {
          const msg = event.message;
          setConversations((prev) => {
            if (!prev) return prev;
            const conv = prev.find((c) => c.id === msg.conversationId);
            if (!conv) {
              void api.listConversations().then((l) => setConversations(l.conversations)).catch(() => {});
              return prev;
            }
            return [
              {
                ...conv,
                lastMessage: msg,
                lastMessageAt: msg.createdAt,
                unreadCount: msg.conversationId === selectedId ? 0 : conv.unreadCount + 1,
              },
              ...prev.filter((c) => c.id !== conv.id),
            ];
          });
          if (msg.conversationId === selectedId) {
            setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
            void api.markRead(msg.conversationId, msg.id).catch(() => {});
          }
        } else if (event.type === "message.read") {
          setConversations((prev) =>
            prev?.map((c) =>
              c.id === event.conversationId ? { ...c, lastReadAt: event.readAt } : c,
            ) ?? prev,
          );
        } else if (event.type === "typing") {
          if (event.conversationId === selectedId && event.isTyping) {
            setTypingUntil(Date.now() + 4000);
          }
        } else if (event.type === "presence") {
          setPeerOnline((prev) => ({ ...prev, [event.userId]: event.online }));
        }
      },
      [selectedId],
    ),
  );

  // Watch the selected peer's presence.
  useEffect(() => {
    if (selected?.peer && wsStatus === "open") {
      wsSend({ type: "watch", userIds: [selected.peer.userId] });
    }
  }, [selected?.peer?.userId, wsStatus, selected?.peer, wsSend]);

  // Typing indicator expiry.
  useEffect(() => {
    if (typingUntil === 0) return;
    const t = window.setTimeout(() => setTypingUntil(0), Math.max(0, typingUntil - Date.now()) + 50);
    return () => window.clearTimeout(t);
  }, [typingUntil]);

  // Auto-scroll on new messages.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, pending.length, typingUntil]);

  const onDraftChange = (value: string) => {
    setDraft(value);
    if (!selectedId) return;
    const now = Date.now();
    if (value.length > 0 && now - typingSentAt.current > 3000) {
      typingSentAt.current = now;
      wsSend({ type: "typing", conversationId: selectedId, isTyping: true });
      if (typingTimer.current) window.clearTimeout(typingTimer.current);
      typingTimer.current = window.setTimeout(() => {
        if (selectedIdRef.current) {
          wsSend({ type: "typing", conversationId: selectedIdRef.current, isTyping: false });
        }
      }, 2500);
    }
  };
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  const sendMessage = async () => {
    const body = draft.trim();
    if (!body || !selectedId) return;
    setDraft("");
    const clientMessageId = newClientMessageId();
    setPending((p) => [...p, { clientMessageId, body, status: "sending" }]);
    setOutbox(addToOutbox({ conversationId: selectedId, clientMessageId, body, queuedAt: Date.now() }));
    try {
      const msg = await api.sendMessage(selectedId, { clientMessageId, body });
      setOutbox(removeFromOutbox(clientMessageId));
      setPending((p) => p.filter((m) => m.clientMessageId !== clientMessageId));
      setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
      setConversations((prev) =>
        prev?.map((c) => (c.id === msg.conversationId ? { ...c, lastMessage: msg, lastMessageAt: msg.createdAt } : c)) ?? prev,
      );
    } catch {
      // Offline or transient failure: stays in the outbox, shows as pending, replays on reconnect.
      setPending((p) => p.map((m) => (m.clientMessageId === clientMessageId ? { ...m, status: "failed" } : m)));
    }
  };

  const onNewChat = async (phone: string): Promise<string | null> => {
    try {
      const conv = await api.startConversation(phone);
      setConversations((prev) => {
        const list = prev ?? [];
        return list.some((c) => c.id === conv.id) ? list : [conv, ...list];
      });
      setShowNewChat(false);
      await openConversation(conv.id);
      return null;
    } catch (err) {
      return errorMessage(err);
    }
  };

  if (loadError && !conversations) {
    return <CenteredError message={loadError} />;
  }

  return (
    <div className="flex h-full min-h-0">
      {/* Conversation list */}
      <div className={cx("w-full shrink-0 flex-col border-r border-ink-200/70 md:flex md:w-80 dark:border-night-border", selectedId ? "hidden md:flex" : "flex")}>
        <div className="flex items-center justify-between px-4 py-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">
            Conversations
            {wsStatus !== "open" && <span className="ml-2 font-normal normal-case text-amber-500">reconnecting…</span>}
          </p>
          <Button variant="secondary" className="!px-2.5 !py-1.5 text-xs md:hidden" onClick={() => setShowNewChat(true)}>
            <PlusIcon className="h-3.5 w-3.5" />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {conversations === null ? (
            <div className="flex justify-center py-10"><Spinner /></div>
          ) : conversations.length === 0 ? (
            <div className="px-6 py-10 text-center">
              <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-ink-100 text-ink-400 dark:bg-night-raised">
                <ChatIcon className="h-5 w-5" />
              </span>
              <p className="mt-3 text-sm font-semibold text-ink-800 dark:text-ink-100">No conversations yet</p>
              <p className="mt-1 text-xs text-ink-400">Start a chat with any phone number on Convo.</p>
            </div>
          ) : (
            conversations.map((conv) => (
              <ConversationRow
                key={conv.id}
                conversation={conv}
                active={conv.id === selectedId}
                online={conv.peer ? peerOnline[conv.peer.userId] === true : false}
                onClick={() => void openConversation(conv.id)}
              />
            ))
          )}
        </div>
      </div>

      {/* Chat view */}
      <div className={cx("min-w-0 flex-1 flex-col", selectedId ? "flex" : "hidden md:flex")}>
        {selected ? (
          <>
            <div className="flex items-center gap-3 border-b border-ink-200/70 bg-white px-4 py-3 dark:border-night-border dark:bg-night-surface">
              <button className="md:hidden" onClick={() => setSelectedId(null)} aria-label="Back">
                <ArrowLeftIcon className="h-5 w-5 text-ink-500" />
              </button>
              <PeerAvatar name={peerName(selected)} online={selected.peer ? peerOnline[selected.peer.userId] === true : false} />
              <div className="min-w-0">
                <p className="truncate text-sm font-bold text-ink-900 dark:text-white">{peerName(selected)}</p>
                <p className="truncate text-xs text-ink-400">
                  {Date.now() < typingUntil
                    ? "typing…"
                    : selected.peer?.phone ?? ""}
                </p>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto bg-ink-50/60 px-4 py-4 dark:bg-night-raised/40">
              {messages.map((msg) => (
                <MessageBubble key={msg.id} message={msg} mine={msg.senderId === account?.id} />
              ))}
              {pending.map((p) => (
                <div key={p.clientMessageId} className="mb-2 flex justify-end">
                  <div className="max-w-[75%] rounded-bubble rounded-br-md bg-iris-500/60 px-3.5 py-2 text-sm text-white">
                    <p className="whitespace-pre-wrap break-words">{p.body}</p>
                    <p className="mt-0.5 text-right text-[10px] text-white/80">
                      {p.status === "failed" ? "Not sent — will retry" : "Sending…"}
                    </p>
                  </div>
                </div>
              ))}
              {Date.now() < typingUntil && (
                <div className="mb-2 flex justify-start">
                  <div className="rounded-bubble rounded-bl-md bg-white px-4 py-2.5 text-sm text-ink-400 shadow-sm dark:bg-night-surface">
                    typing<span className="animate-pulse">…</span>
                  </div>
                </div>
              )}
              <div ref={bottomRef} />
            </div>

            <div className="border-t border-ink-200/70 bg-white p-3 dark:border-night-border dark:bg-night-surface">
              <div className="flex items-end gap-2">
                <textarea
                  value={draft}
                  onChange={(e) => onDraftChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void sendMessage();
                    }
                  }}
                  rows={1}
                  placeholder="Type a message"
                  className="max-h-32 min-h-[42px] flex-1 resize-none rounded-xl border border-ink-200 bg-ink-50 px-3.5 py-2.5 text-sm placeholder:text-ink-400 focus:border-iris-400 focus:outline-none dark:border-night-border dark:bg-night-raised dark:text-ink-100"
                />
                <Button className="!px-4" onClick={() => void sendMessage()} disabled={draft.trim().length === 0}>
                  Send
                </Button>
              </div>
            </div>
          </>
        ) : (
          <div className="flex h-full items-center justify-center p-6">
            <div className="max-w-xs text-center">
              <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-ink-100 text-ink-400 dark:bg-night-raised">
                <ChatIcon className="h-6 w-6" />
              </span>
              <h2 className="mt-4 text-lg font-bold text-ink-900 dark:text-white">Select a conversation</h2>
              <p className="mt-1.5 text-sm text-ink-500 dark:text-ink-400">
                Messages arrive in real time. Sent while offline? They queue and send automatically when you're back.
              </p>
            </div>
          </div>
        )}
      </div>

      {showNewChat && <NewChatDialog onClose={() => setShowNewChat(false)} onStart={onNewChat} />}
    </div>
  );
}

function peerName(conv: ConversationSummary): string {
  if (conv.type === "GROUP") return conv.title ?? "Group";
  return conv.peer?.displayName ?? conv.peer?.phone ?? "Unknown";
}

function previewText(conv: ConversationSummary): string {
  const last = conv.lastMessage;
  if (!last) return "No messages yet";
  if (last.deletedAt) return "Message deleted";
  return last.body ?? "";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong";
}

function ConversationRow({
  conversation,
  active,
  online,
  onClick,
}: {
  conversation: ConversationSummary;
  active: boolean;
  online: boolean;
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
      <PeerAvatar name={peerName(conversation)} online={online} small />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <p className="truncate text-sm font-semibold text-ink-900 dark:text-white">{peerName(conversation)}</p>
          {conversation.lastMessage && (
            <span className="shrink-0 text-[11px] text-ink-400">{relativeTime(conversation.lastMessage.createdAt)}</span>
          )}
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <p className="truncate text-xs text-ink-500 dark:text-ink-400">{previewText(conversation)}</p>
          {conversation.unreadCount > 0 && (
            <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-iris-500 px-1.5 text-[11px] font-bold text-white">
              {conversation.unreadCount > 99 ? "99+" : conversation.unreadCount}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

function MessageBubble({ message, mine }: { message: Message; mine: boolean }) {
  if (message.deletedAt) {
    return (
      <div className={cx("mb-2 flex", mine ? "justify-end" : "justify-start")}>
        <p className="rounded-bubble bg-ink-100 px-3.5 py-2 text-xs italic text-ink-400 dark:bg-night-raised">
          Message deleted
        </p>
      </div>
    );
  }
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
        <p className="whitespace-pre-wrap break-words">{message.body}</p>
        <p className={cx("mt-0.5 text-right text-[10px]", mine ? "text-white/75" : "text-ink-400")}>
          {new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          {mine && <CheckIcon className="ml-1 inline h-3 w-3" />}
        </p>
      </div>
    </div>
  );
}

function PeerAvatar({ name, online, small }: { name: string; online?: boolean; small?: boolean }) {
  const initial = name.replace(/[^\p{L}\p{N}]/gu, "").charAt(0).toUpperCase() || "?";
  const size = small ? "h-10 w-10 text-sm" : "h-9 w-9 text-xs";
  return (
    <span className="relative shrink-0">
      <span className={cx("flex items-center justify-center rounded-full bg-gradient-to-br from-iris-500 to-signal-400 font-bold text-white", size)}>
        {initial}
      </span>
      {online && (
        <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-white bg-emerald-400 dark:border-night-surface" />
      )}
    </span>
  );
}

function NewChatDialog({
  onClose,
  onStart,
}: {
  onClose: () => void;
  onStart: (phone: string) => Promise<string | null>;
}) {
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    const err = await onStart(phone.trim());
    setBusy(false);
    if (err) setError(err);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-sm animate-rise rounded-card border border-ink-200/70 bg-white p-6 shadow-xl dark:border-night-border dark:bg-night-surface"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-bold text-ink-900 dark:text-white">New chat</h2>
        <p className="mt-1 text-xs text-ink-500 dark:text-ink-400">
          Enter the phone number of the person you want to message.
        </p>
        <div className="mt-4">
          <Input
            label="Phone number"
            placeholder="+919876543210"
            value={phone}
            autoFocus
            onChange={(e) => {
              setPhone(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
            error={error ?? undefined}
            hint="E.164 format, e.g. +919876543210"
          />
        </div>
        <div className="mt-5 flex gap-2">
          <Button variant="secondary" block onClick={onClose}>
            Cancel
          </Button>
          <Button block loading={busy} onClick={() => void submit()} disabled={!phone.trim().startsWith("+")}>
            Start chat
          </Button>
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
