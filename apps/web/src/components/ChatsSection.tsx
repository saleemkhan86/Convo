import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { Attachment, ChatPin, ConversationSummary, GroupDetail, GroupMember, Message, MessageLocation, ReportTargetType, SharedContact, WsServerEvent } from "@convo/shared";
import {
  ArrowLeftIcon,
  BellOffIcon,
  ChatIcon,
  CheckIcon,
  ContactsIcon,
  DotsIcon,
  DoubleCheckIcon,
  FlagIcon,
  ForwardIcon,
  GifIcon,
  GroupsIcon,
  ImageIcon,
  MapPinIcon,
  PencilIcon,
  PinIcon,
  PlusIcon,
  PhoneIcon,
  ReplyIcon,
  SearchIcon,
  SmileIcon,
  StarIcon,
  TimerIcon,
  TrashIcon,
  VideoIcon,
  ViewOnceIcon,
  XIcon,
} from "./icons";
import { useCall } from "../lib/calls";
import { Badge, Button, Input, Spinner, cx } from "./ui";
import { GroupDirectoryDialog, GroupPanel } from "./GroupPanel";
import {
  BlockedList,
  ChatMenu,
  ConfirmDialog,
  ContactsDialog,
  StarredDialog,
  SearchDialog,
  ContactInfoDialog,
  ReportDialog,
  chatFlags,
  shortEphemeral,
  type ChatAction,
} from "./ChatControls";
import {
  AttachButton,
  AttachmentTray,
  ContactShareDialog,
  ForwardDialog,
  GifPickerDialog,
  Lightbox,
  LinkPreviewCard,
  LocationCard,
  LocationShareDialog,
  MAX_ATTACHMENTS,
  MediaGalleryDialog,
  MessageAttachments,
  SharedContactCard,
  ViewOnceViewer,
  VoiceRecorder,
  attachmentKindLabel,
  messageLabel,
  stageFile,
  toAttachmentInput,
  type StagedFile,
} from "./ChatMedia";
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
  /** Media messages show a placeholder line while they are in flight. */
  attachmentCount: number;
}

/** What an in-flight message shows when it has no text (photo-only, voice-only…). */
function pendingLabel(body: string, attachmentCount: number): string {
  if (body) return body;
  if (attachmentCount === 1) return "1 attachment";
  return `${attachmentCount} attachments`;
}

const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

export function ChatsSection({ newChatNonce }: { newChatNonce: number }) {
  const { account } = useAuth();
  const { status: wsStatus, send: wsSend } = useRealtime();
  const { start: startCall, phase: callPhase } = useCall();
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
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [pickerId, setPickerId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Message | null>(null);
  const [groupInfo, setGroupInfo] = useState<GroupDetail | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [showGroups, setShowGroups] = useState(false);
  // Phase 5A chat controls.
  const [listMode, setListMode] = useState<"chats" | "archived">("chats");
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{ action: ChatAction; conversation: ConversationSummary } | null>(null);
  const [infoFor, setInfoFor] = useState<string | null>(null);
  const [reportFor, setReportFor] = useState<{ type: ReportTargetType; id: string; label: string } | null>(null);
  const [showStarred, setShowStarred] = useState(false);
  const [showContacts, setShowContacts] = useState(false);
  const [showBlocked, setShowBlocked] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [chatSearch, setChatSearch] = useState<string | null>(null);
  // Phase 5B chat media.
  const [staged, setStaged] = useState<StagedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [viewOnceDraft, setViewOnceDraft] = useState(false);
  const [stickerDraft, setStickerDraft] = useState(false);
  const [viewOnceFor, setViewOnceFor] = useState<Message | null>(null);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [galleryPreview, setGalleryPreview] = useState<{ attachments: Attachment[]; index: number } | null>(null);
  const [forwardFor, setForwardFor] = useState<string[] | null>(null);
  // Phase 5B extras: GIF picker, location pin, contact-card share.
  const [gifOpen, setGifOpen] = useState(false);
  const [locationOpen, setLocationOpen] = useState(false);
  const [contactShareOpen, setContactShareOpen] = useState(false);
  // Phase 5E group parity: pins, @mentions, multi-select forward.
  const [pins, setPins] = useState<ChatPin[]>([]);
  const [pinsOpen, setPinsOpen] = useState(false);
  const [mentionIdx, setMentionIdx] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const [selectIds, setSelectIds] = useState<string[] | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const typingSentAt = useRef(0);
  const typingTimer = useRef<number | null>(null);

  const selected = conversations?.find((c) => c.id === selectedId) ?? null;

  const refreshGroupInfo = useCallback(async (conversationId: string) => {
    try {
      setGroupInfo(await api.group(conversationId));
    } catch {
      setGroupInfo(null);
    }
  }, []);

  /** Pinned messages (5E) drive the banner, so the newest pin is always known. */
  const refreshPins = useCallback(async (conversationId: string) => {
    try {
      setPins((await api.pinnedMessages(conversationId)).pins);
    } catch {
      setPins([]);
    }
  }, []);

  // Header "New chat" button bumps newChatNonce to open the dialog.
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
        const list = listMode === "archived" ? await api.listArchived() : await api.listConversations();
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
  }, [listMode]);

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
            setOutbox(removeFromOutbox(item.clientMessageId));
            setPending((p) => p.filter((m) => m.clientMessageId !== clientMsg(item)));
          }
        }
      }
      const list = await api.listConversations().catch(() => null);
      if (list) setConversations(list.conversations);
    })();
  }, [wsStatus]);

  // Object URLs are cheap to leak but not free: drop them whenever the composer
  // empties or the chat changes.
  const stagedRef = useRef<StagedFile[]>([]);
  stagedRef.current = staged;
  const clearStaged = useCallback(() => {
    stagedRef.current.forEach((file) => URL.revokeObjectURL(file.previewUrl));
    setStaged([]);
    setViewOnceDraft(false);
    setStickerDraft(false);
    setMediaError(null);
  }, []);

  // Load timeline when a conversation is opened.
  const openConversation = useCallback(async (conversationId: string) => {
    setSelectedId(conversationId);
    setMessages([]);
    setLoadError(null);
    setReplyTo(null);
    setEditing(null);
    setPickerId(null);
    setPanelOpen(false);
    setGroupInfo(null);
    setChatSearch(null);
    setGalleryOpen(false);
    setGalleryPreview(null);
    setForwardFor(null);
    setViewOnceFor(null);
    setGifOpen(false);
    setLocationOpen(false);
    setContactShareOpen(false);
    setPins([]);
    setPinsOpen(false);
    setSelectIds(null);
    clearStaged();
    try {
      const page = await api.listMessages(conversationId);
      setMessages(page.messages);
      await api.markRead(conversationId).catch(() => {});
      setConversations((prev) =>
        prev?.map((c) =>
          c.id === conversationId ? { ...c, unreadCount: 0, unreadMentions: 0 } : c,
        ) ?? prev,
      );
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }, []);

  /**
   * In-chat search (Phase 5A): the server filters, so a match outside the
   * loaded window is still found. Empty query restores the normal timeline.
   */
  const runChatSearch = useCallback(
    async (conversationId: string, q: string) => {
      const term = q.trim();
      if (!term) {
        const page = await api.listMessages(conversationId);
        setMessages(page.messages);
        return;
      }
      const page = await api.listMessages(conversationId, undefined, 50, { q: term });
      setMessages(page.messages);
    },
    [],
  );

  // Group chats carry extra metadata (roster, join requests) for the header and bubbles.
  useEffect(() => {
    if (selected?.type === "GROUP") void refreshGroupInfo(selected.id);
    else setGroupInfo(null);
  }, [selected?.id, selected?.type, refreshGroupInfo]);

  // Pinned messages feed the banner under the header.
  useEffect(() => {
    if (selectedId) void refreshPins(selectedId);
  }, [selectedId, refreshPins]);

  // A new @token starts the typeahead from the top of the list.
  useEffect(() => {
    setMentionIdx(0);
  }, [draft]);

  // Realtime events (spec §22): the socket only ever mutates local state.
  useRealtimeSubscription(
    useCallback(
      (event: WsServerEvent) => {
        switch (event.type) {
          case "message.new": {
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
                  unreadMentions:
                    msg.conversationId === selectedId ? 0 : conv.unreadMentions + (msg.mentionedMe ? 1 : 0),
                },
                ...prev.filter((c) => c.id !== conv.id),
              ];
            });
            if (msg.conversationId === selectedId) {
              setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
              void api.markRead(msg.conversationId, msg.id).catch(() => {});
            }
            break;
          }
          case "message.edited": {
            if (event.conversationId !== selectedId) break;
            setMessages((prev) =>
              prev.map((m) =>
                m.id === event.messageId ? { ...m, body: event.body, editedAt: event.editedAt } : m,
              ),
            );
            break;
          }
          case "message.deleted": {
            if (event.conversationId !== selectedId) break;
            if (event.scope === "MINE") {
              if (event.userId === account?.id) {
                setMessages((prev) => prev.filter((m) => m.id !== event.messageId));
              }
            } else {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === event.messageId
                    ? { ...m, deletedAt: new Date().toISOString(), body: null, reactions: [] }
                    : m,
                ),
              );
            }
            break;
          }
          case "message.reacted": {
            if (event.conversationId !== selectedId) break;
            setMessages((prev) =>
              prev.map((m) => {
                if (m.id !== event.messageId) return m;
                const mineByEmoji = new Map(m.reactions.map((r) => [r.emoji, r.reactedByMe]));
                return {
                  ...m,
                  reactions: event.reactions.map((t) => ({
                    emoji: t.emoji,
                    count: t.count,
                    reactedByMe: mineByEmoji.get(t.emoji) ?? false,
                  })),
                };
              }),
            );
            break;
          }
          case "message.viewOnceOpened": {
            // The viewer's own burn arrives here too; the overlay marks it locally.
            setMessages((prev) =>
              prev.map((m) => (m.id === event.messageId ? { ...m, viewOnceOpened: true } : m)),
            );
            setConversations((prev) =>
              prev?.map((c) =>
                c.lastMessage?.id === event.messageId ? { ...c, lastMessage: { ...c.lastMessage, viewOnceOpened: true } } : c,
              ) ?? prev,
            );
            break;
          }
          case "message.linkPreview": {
            // The async scrape landed; show the card on the existing bubble.
            setMessages((prev) =>
              prev.map((m) => (m.id === event.messageId ? { ...m, linkPreview: event.preview } : m)),
            );
            setConversations((prev) =>
              prev?.map((c) =>
                c.lastMessage?.id === event.messageId
                  ? { ...c, lastMessage: { ...c.lastMessage, linkPreview: event.preview } }
                  : c,
              ) ?? prev,
            );
            break;
          }
          case "message.pin": {
            // A pin is shared state, so the row is patched wherever it appears.
            setMessages((prev) =>
              prev.map((m) => (m.id === event.messageId ? { ...m, pinned: event.pin } : m)),
            );
            setConversations((prev) =>
              prev?.map((c) =>
                c.lastMessage?.id === event.messageId
                  ? { ...c, lastMessage: { ...c.lastMessage, pinned: event.pin } }
                  : c,
              ) ?? prev,
            );
            // Unpinning only drops a row; pinning needs the message text for the banner.
            if (event.pin) {
              if (event.conversationId === selectedId) void refreshPins(event.conversationId);
            } else {
              setPins((prev) => prev.filter((p) => p.message.id !== event.messageId));
            }
            break;
          }
          case "message.delivered": {
            if (event.conversationId !== selectedId) break;
            const ids = new Set(event.messageIds);
            setMessages((prev) =>
              prev.map((m) =>
                ids.has(m.id) && m.deliveryStatus !== "READ" ? { ...m, deliveryStatus: "DELIVERED" } : m,
              ),
            );
            break;
          }
          case "message.read": {
            setConversations((prev) =>
              prev?.map((c) =>
                c.id === event.conversationId ? { ...c, lastReadAt: event.readAt } : c,
              ) ?? prev,
            );
            if (event.conversationId === selectedId && event.userId !== account?.id) {
              const readAt = new Date(event.readAt).getTime();
              setMessages((prev) =>
                prev.map((m) =>
                  m.senderId === account?.id && new Date(m.createdAt).getTime() <= readAt
                    ? { ...m, deliveryStatus: "READ" }
                    : m,
                ),
              );
            }
            break;
          }
          case "message.expired": {
            // Disappearing messages (5C): the row is gone server-side already.
            setMessages((prev) => prev.filter((m) => m.id !== event.messageId));
            break;
          }
          case "conversation.ephemeralChanged": {
            setConversations(
              (prev) =>
                prev?.map((c) =>
                  c.id === event.conversationId ? { ...c, ephemeralSeconds: event.seconds } : c,
                ) ?? prev,
            );
            break;
          }
          case "typing": {
            if (event.conversationId === selectedId && event.isTyping) {
              setTypingUntil(Date.now() + 4000);
            }
            break;
          }
          case "presence": {
            setPeerOnline((prev) => ({ ...prev, [event.userId]: event.online }));
            // lastSeen is privacy-gated and only trusted from REST; refresh on change.
            if (event.userId === selected?.peer?.userId && !event.online) {
              void api.listConversations().then((l) => setConversations(l.conversations)).catch(() => {});
            }
            break;
          }
          case "group.changed":
          case "group.joinRequest.new":
          case "group.joined": {
            // Membership/settings changed: re-pull the list (role, member count, new rows).
            void api.listConversations().then((l) => setConversations(l.conversations)).catch(() => {});
            if (event.conversationId === selectedId) void refreshGroupInfo(event.conversationId);
            break;
          }
        }
      },
      [selectedId, selected?.peer?.userId, account?.id, refreshGroupInfo, refreshPins],
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
    setMentionDismissed(false);
    if (!selectedId || editing) return;
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

  const submitComposer = async () => {
    const body = draft.trim();
    if (!body && staged.length === 0) return;

    if (editing) {
      setEditing(null);
      setDraft("");
      try {
        const updated = await api.editMessage(editing.id, body);
        setMessages((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
      } catch {
        setDraft(body);
      }
      return;
    }

    if (!selectedId) return;
    const media = staged;
    const viewOnce = viewOnceDraft && media.length > 0;
    const sticker = stickerDraft && media.length > 0;
    setDraft("");
    setViewOnceDraft(false);
    setStickerDraft(false);
    setStaged([]);
    setMediaError(null);
    const quoted = replyTo?.id;
    setReplyTo(null);
    const clientMessageId = newClientMessageId();
    setPending((p) => [...p, { clientMessageId, body, attachmentCount: media.length, status: "sending" }]);
    // Only text can be replayed from the outbox: a staged file lives behind an
    // object URL that dies with the page, so a media send is retried from the
    // tray instead.
    const queued = media.length === 0;
    if (queued) setOutbox(addToOutbox({ conversationId: selectedId, clientMessageId, body, queuedAt: Date.now() }));
    try {
      const msg = await api.sendMessage(selectedId, {
        clientMessageId,
        body: body || undefined,
        replyToId: quoted,
        attachments: media.length > 0 ? media.map(toAttachmentInput) : undefined,
        viewOnce: viewOnce || undefined,
        sticker: sticker || undefined,
      });
      if (queued) setOutbox(removeFromOutbox(clientMessageId));
      // The server has the bytes now, so the local previews are free to drop.
      media.forEach((file) => URL.revokeObjectURL(file.previewUrl));
      setPending((p) => p.filter((m) => m.clientMessageId !== clientMessageId));
      setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
      setConversations((prev) =>
        prev?.map((c) =>
          c.id === msg.conversationId ? { ...c, lastMessage: msg, lastMessageAt: msg.createdAt } : c,
        ) ?? prev,
      );
    } catch {
      setPending((p) => p.map((m) => (m.clientMessageId === clientMessageId ? { ...m, status: "failed" } : m)));
      // Keep the upload: the files are already stored, so pressing Send again
      // just re-posts what is back in the tray.
      if (media.length > 0) {
        setStaged(media);
        setViewOnceDraft(viewOnce);
        setStickerDraft(sticker);
        setDraft(body);
      }
    }
  };

  /** Upload picked files and park them in the composer tray. */
  const stageFiles = async (files: File[]) => {
    setUploading(true);
    setMediaError(null);
    let room = MAX_ATTACHMENTS - stagedRef.current.length;
    for (const file of files) {
      if (room <= 0) {
        setMediaError(`A message can hold up to ${MAX_ATTACHMENTS} attachments`);
        break;
      }
      room -= 1;
      try {
        const next = await stageFile(file);
        setStaged((prev) => (prev.some((s) => s.storageKey === next.storageKey) ? prev : [...prev, next]));
      } catch (err) {
        setMediaError(errorMessage(err));
      }
    }
    setUploading(false);
  };

  /** A finished voice note stages like a picked file, carrying its length. */
  const stageRecording = async (file: File, durationMs: number) => {
    setUploading(true);
    setMediaError(null);
    try {
      const next = await stageFile(file);
      setStaged((prev) => [...prev, { ...next, durationMs }]);
    } catch (err) {
      setMediaError(errorMessage(err));
    } finally {
      setUploading(false);
    }
  };

  /** A picked GIF is already server-stored; it only needs tray room. */
  const stageReadyFile = (file: StagedFile) => {
    setMediaError(null);
    setStaged((prev) => {
      if (prev.some((s) => s.storageKey === file.storageKey)) return prev;
      if (prev.length >= MAX_ATTACHMENTS) {
        setMediaError(`A message can hold up to ${MAX_ATTACHMENTS} attachments`);
        return prev;
      }
      return [...prev, file];
    });
  };

  /** Location pins and contact cards are payload messages, not outbox text. */
  const sendShare = async (payload: { location?: MessageLocation; contactCard?: SharedContact }) => {
    if (!selectedId) return;
    const label = payload.location ? "Location" : "Contact card";
    const clientMessageId = newClientMessageId();
    setPending((p) => [...p, { clientMessageId, body: label, status: "sending", attachmentCount: 0 }]);
    try {
      const msg = await api.sendMessage(selectedId, { clientMessageId, ...payload });
      setPending((p) => p.filter((m) => m.clientMessageId !== clientMessageId));
      setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
      setConversations((prev) =>
        prev?.map((c) =>
          c.id === msg.conversationId ? { ...c, lastMessage: msg, lastMessageAt: msg.createdAt } : c,
        ) ?? prev,
      );
    } catch {
      setPending((p) => p.map((m) => (m.clientMessageId === clientMessageId ? { ...m, status: "failed" } : m)));
    }
  };

  const removeStaged = (storageKey: string) => {
    setMediaError(null);
    const hit = stagedRef.current.find((s) => s.storageKey === storageKey);
    if (hit) URL.revokeObjectURL(hit.previewUrl);
    setStaged((prev) => prev.filter((s) => s.storageKey !== storageKey));
  };

  const startEdit = (msg: Message) => {
    setEditing(msg);
    setReplyTo(null);
    setDraft(msg.body ?? "");
  };

  const cancelComposer = () => {
    setEditing(null);
    setReplyTo(null);
    setDraft("");
    setViewOnceDraft(false);
    setStickerDraft(false);
  };

  const toggleReaction = async (msg: Message, emoji: string) => {
    setPickerId(null);
    const reacted = msg.reactions.some((r) => r.emoji === emoji && r.reactedByMe);
    try {
      const updated = reacted
        ? await api.removeReaction(msg.id, emoji)
        : await api.reactMessage(msg.id, emoji);
      setMessages((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
    } catch {
      // Realtime broadcast corrects state on success elsewhere; ignore here.
    }
  };

  const toggleStar = async (msg: Message) => {
    try {
      const updated = await api.starMessage(msg.id, !msg.starredByMe);
      setMessages((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
    } catch {
      // ignore; next load reflects the server
    }
  };

  /**
   * Per-viewer chat controls. Pin/archive/mute apply immediately; clear and
   * delete ask for confirmation because they are destructive.
   */
  const applyChatAction = async (conversation: ConversationSummary, action: ChatAction) => {
    if (action.kind === "clear" || action.kind === "delete") {
      setConfirming({ action, conversation });
      return;
    }
    try {
      if (action.kind === "info") {
        if (conversation.type === "GROUP") setPanelOpen(true);
        else if (conversation.peer) setInfoFor(conversation.peer.userId);
        return;
      }
      if (action.kind === "report") {
        const peerId = conversation.peer?.userId;
        setReportFor({
          type: peerId ? "USER" : "CONVERSATION",
          id: peerId ?? conversation.id,
          label: conversation.peer?.displayName ?? conversation.peer?.phone ?? peerName(conversation),
        });
        return;
      }
      if (action.kind === "ephemeral") {
        const updated = await api.setEphemeral(conversation.id, action.seconds);
        setConversations((prev) => prev?.map((c) => (c.id === updated.id ? updated : c)) ?? prev);
        return;
      }
      if (action.kind === "export") {
        await exportConversation(conversation);
        return;
      }
      const body =
        action.kind === "pin"
          ? { pinned: action.pinned }
          : action.kind === "archive"
            ? { archived: action.archived }
            : { muteHours: action.hours };
      const updated = await api.updateConversation(conversation.id, body);
      setConversations((prev) =>
        prev?.map((c) => {
          if (c.id !== updated.id) return c;
          // Archiving moves the chat out of the active list entirely.
          return action.kind === "archive" && action.archived ? null : c;
        })?.filter((c): c is ConversationSummary => c !== null) ?? prev,
      );
      if (action.kind === "archive" && action.archived && selectedId === updated.id) {
        setSelectedId(null);
      }
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  };

  const runConfirm = async () => {
    const pendingAction = confirming;
    setConfirming(null);
    if (!pendingAction) return;
    try {
      if (pendingAction.action.kind === "clear") {
        const updated = await api.clearConversation(pendingAction.conversation.id);
        setConversations(
          (prev) => prev?.map((c) => (c.id === updated.id ? updated : c)) ?? prev,
        );
        if (selectedId === updated.id) setMessages([]);
      } else if (pendingAction.action.kind === "delete") {
        await api.deleteConversation(pendingAction.conversation.id);
        setConversations((prev) => prev?.filter((c) => c.id !== pendingAction.conversation.id) ?? prev);
        if (selectedId === pendingAction.conversation.id) setSelectedId(null);
      }
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  };

  const confirmDelete = async (scope: "MINE" | "EVERYONE") => {
    const msg = deleteTarget;
    setDeleteTarget(null);
    if (!msg) return;
    try {
      await api.deleteMessage(msg.id, scope);
      if (scope === "MINE") setMessages((prev) => prev.filter((m) => m.id !== msg.id));
      else setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, deletedAt: new Date().toISOString(), body: null, reactions: [] } : m)));
    } catch {
      // ignore; membership errors surface on next load
    }
  };

  /** Pin or unpin for the whole chat (5E); the server fans the change out. */
  const togglePin = async (msg: Message) => {
    setPickerId(null);
    const conversationId = msg.conversationId;
    try {
      const updated = await api.setMessagePinned(msg.id, msg.pinned === null);
      setMessages((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
      setConversations(
        (prev) =>
          prev?.map((c) =>
            c.lastMessage?.id === updated.id ? { ...c, lastMessage: updated } : c,
          ) ?? prev,
      );
      void refreshPins(conversationId);
    } catch {
      // ignore; the next load reflects the server
    }
  };

  /** Scroll the timeline to a message and hold it in view. */
  const jumpToMessage = (messageId: string) => {
    document
      .getElementById(`convo-msg-${messageId}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  /** Multi-select forward (5E): first tap starts a selection, taps then toggle. */
  const toggleSelect = (messageId: string) => {
    setSelectIds((prev) => {
      if (prev === null) return [messageId];
      const next = prev.includes(messageId) ? prev.filter((id) => id !== messageId) : [...prev, messageId];
      return next.length === 0 ? null : next;
    });
  };

  /** Accept a typeahead row: the bare `@token` becomes `@Name `. */
  const applyMention = (member: GroupMember) => {
    setDraft((prev) => prev.replace(/@[^\s@]*$/, `@${memberLabel(member)} `));
    setMentionDismissed(false);
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

  const isTyping = Date.now() < typingUntil;
  const isGroup = selected?.type === "GROUP";
  const callLive = callPhase !== "idle" && callPhase !== "ended";
  const myRole = groupInfo?.myRole ?? selected?.group?.myRole ?? null;
  const adminsOnly =
    selected?.group?.announceOnly === true || selected?.group?.whoCanSend === "ADMINS";
  const canPost = !isGroup || !adminsOnly || myRole === "ADMIN";
  const memberNames = new Map(
    (groupInfo?.members ?? []).map((m) => [m.userId, m.displayName ?? m.phone ?? "Convo user"]),
  );
  const topPin = pins[0] ?? null;

  // @mention typeahead (5E): candidates always come from the group roster.
  const mentionQuery =
    isGroup && canPost && !editing && !mentionDismissed ? mentionTokenAt(draft) : null;
  const mentionCandidates =
    mentionQuery === null
      ? []
      : (groupInfo?.members ?? [])
          .filter((m) => m.userId !== account?.id)
          .filter((m) => memberLabel(m).toLowerCase().startsWith(mentionQuery.toLowerCase()))
          .slice(0, 6);

  const openGroup = async (conversationId: string) => {
    setShowGroups(false);
    const list = await api.listConversations().catch(() => null);
    if (list) setConversations(list.conversations);
    await openConversation(conversationId);
  };

  return (
    <div className="flex h-full min-h-0">
      {/* Conversation list */}
      <div className={cx("w-full shrink-0 flex-col border-r border-ink-200/70 md:flex md:w-80 dark:border-night-border", selectedId ? "hidden md:flex" : "flex")}>
        <div className="relative flex items-center justify-between px-4 py-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">
            {listMode === "archived" ? "Archived" : "Conversations"}
            {wsStatus !== "open" && <span className="ml-2 font-normal normal-case text-amber-500">reconnecting…</span>}
          </p>
          <div className="flex items-center gap-1.5">
            <IconButton label="Search" onClick={() => setSearchOpen(true)}>
              <SearchIcon className="h-4 w-4" />
            </IconButton>
            <IconButton label="Contacts" onClick={() => setShowContacts(true)}>
              <ContactsIcon className="h-4 w-4" />
            </IconButton>
            <IconButton label="Starred messages" onClick={() => setShowStarred(true)}>
              <StarIcon className="h-4 w-4" />
            </IconButton>
            <Button
              variant="secondary"
              className="!px-2.5 !py-1.5 text-xs"
              title="New group"
              onClick={() => setShowGroups(true)}
            >
              <GroupsIcon className="h-3.5 w-3.5" />
            </Button>
            <Button variant="secondary" className="!px-2.5 !py-1.5 text-xs md:hidden" onClick={() => setShowNewChat(true)}>
              <PlusIcon className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
        <div className="flex items-center gap-2 px-4 pb-2">
          <button
            onClick={() => setListMode(listMode === "archived" ? "chats" : "archived")}
            className="rounded-full px-2.5 py-1 text-[11px] font-semibold text-ink-500 hover:bg-ink-100 dark:text-ink-400 dark:hover:bg-night-raised"
          >
            {listMode === "archived" ? "Back to chats" : "Archived chats"}
          </button>
          <button
            onClick={() => setShowBlocked(true)}
            className="rounded-full px-2.5 py-1 text-[11px] font-semibold text-ink-500 hover:bg-ink-100 dark:text-ink-400 dark:hover:bg-night-raised"
          >
            Blocked
          </button>
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
                menuOpen={menuFor === conv.id}
                onToggleMenu={() => setMenuFor((id) => (id === conv.id ? null : conv.id))}
                onAction={(action) => void applyChatAction(conv, action)}
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
              <PeerAvatar
                name={peerName(selected)}
                online={selected.peer ? peerOnline[selected.peer.userId] === true : false}
                group={isGroup}
              />
              <button className="min-w-0 flex-1 text-left" onClick={() => isGroup && setPanelOpen(true)}>
                <p className="truncate text-sm font-bold text-ink-900 dark:text-white">
                  {peerName(selected)}
                  {selected.ephemeralSeconds > 0 && (
                    <span
                      className="ml-2 inline-flex items-center gap-1 align-middle text-[10px] font-semibold text-iris-600 dark:text-iris-400"
                      title="Disappearing messages are on"
                    >
                      <TimerIcon className="h-3 w-3" />
                      {shortEphemeral(selected.ephemeralSeconds)}
                    </span>
                  )}
                </p>
                <p className="truncate text-xs text-ink-400">
                  {isTyping
                    ? "typing…"
                    : isGroup
                      ? `${groupInfo?.memberCount ?? selected.group?.memberCount ?? 0} members${
                          groupInfo && groupInfo.joinRequests.length > 0
                            ? ` · ${groupInfo.joinRequests.length} join request${
                                groupInfo.joinRequests.length > 1 ? "s" : ""
                              }`
                            : ""
                        }`
                      : peerOnline[selected.peer?.userId ?? ""] === true
                        ? "online"
                        : lastSeenLabel(selected.peer?.lastSeenAt ?? null)}
                </p>
              </button>
              {isGroup ? (
                <button
                  onClick={() => setPanelOpen((open) => !open)}
                  title="Group info"
                  aria-label="Group info"
                  className={cx(
                    "rounded-full p-2 transition-colors",
                    panelOpen
                      ? "bg-iris-50 text-iris-600 dark:bg-iris-500/15 dark:text-iris-300"
                      : "text-ink-400 hover:bg-ink-100 dark:hover:bg-night-raised",
                  )}
                >
                  <GroupsIcon className="h-5 w-5" />
                </button>
              ) : (
                <button
                  onClick={() => selected.peer && setInfoFor(selected.peer.userId)}
                  title="Contact info"
                  aria-label="Contact info"
                  className="rounded-full p-2 text-ink-400 transition-colors hover:bg-ink-100 dark:hover:bg-night-raised"
                >
                  <ContactsIcon className="h-5 w-5" />
                </button>
              )}
              {!isGroup && selected.peer && (
                <>
                  <button
                    onClick={() => void startCall(selected.id, "VOICE")}
                    disabled={callLive}
                    title="Voice call"
                    aria-label="Voice call"
                    className="rounded-full p-2 text-ink-400 transition-colors hover:bg-ink-100 disabled:opacity-40 dark:hover:bg-night-raised"
                  >
                    <PhoneIcon className="h-5 w-5" />
                  </button>
                  <button
                    onClick={() => void startCall(selected.id, "VIDEO")}
                    disabled={callLive}
                    title="Video call"
                    aria-label="Video call"
                    className="rounded-full p-2 text-ink-400 transition-colors hover:bg-ink-100 disabled:opacity-40 dark:hover:bg-night-raised"
                  >
                    <VideoIcon className="h-5 w-5" />
                  </button>
                </>
              )}
              <button
                onClick={() => setGalleryOpen(true)}
                title="Media, links and docs"
                aria-label="Media, links and docs"
                className={cx(
                  "rounded-full p-2 transition-colors",
                  galleryOpen
                    ? "bg-iris-50 text-iris-600 dark:bg-iris-500/15 dark:text-iris-300"
                    : "text-ink-400 hover:bg-ink-100 dark:hover:bg-night-raised",
                )}
              >
                <ImageIcon className="h-5 w-5" />
              </button>
              <button
                onClick={() => setChatSearch(chatSearch === null ? "" : null)}
                title="Search this chat"
                aria-label="Search this chat"
                className={cx(
                  "rounded-full p-2 transition-colors",
                  chatSearch !== null
                    ? "bg-iris-50 text-iris-600 dark:bg-iris-500/15 dark:text-iris-300"
                    : "text-ink-400 hover:bg-ink-100 dark:hover:bg-night-raised",
                )}
              >
                <SearchIcon className="h-5 w-5" />
              </button>
            </div>

            {topPin && (
              <div className="flex items-center gap-2 border-b border-ink-200/70 bg-white px-4 py-1.5 dark:border-night-border dark:bg-night-surface">
                <PinIcon className="h-3.5 w-3.5 shrink-0 text-iris-500" filled />
                <button
                  className="min-w-0 flex-1 text-left"
                  onClick={() => jumpToMessage(topPin.message.id)}
                  title="Jump to the pinned message"
                >
                  <p className="truncate text-[11px] text-ink-500 dark:text-ink-400">
                    <span className="font-semibold text-ink-700 dark:text-ink-200">
                      {topPin.pin.displayName ?? "A member"}
                    </span>{" "}
                    pinned “{messageLabel(topPin.message)}”
                  </p>
                </button>
                {pins.length > 1 && (
                  <button
                    onClick={() => setPinsOpen(true)}
                    className="shrink-0 text-[11px] font-semibold text-iris-600 hover:underline"
                  >
                    All {pins.length}
                  </button>
                )}
                <button
                  onClick={() => void togglePin(topPin.message)}
                  aria-label="Unpin message"
                  title="Unpin"
                  className="shrink-0 text-ink-400 hover:text-ink-600"
                >
                  <XIcon className="h-3.5 w-3.5" />
                </button>
              </div>
            )}

            {chatSearch !== null && (
              <div className="flex items-center gap-2 border-b border-ink-200/70 bg-white px-4 py-2 dark:border-night-border dark:bg-night-surface">
                <SearchIcon className="h-4 w-4 shrink-0 text-ink-400" />
                <input
                  value={chatSearch}
                  autoFocus
                  placeholder="Search in this chat"
                  onChange={(e) => {
                    const value = e.target.value;
                    setChatSearch(value);
                    if (selectedId) void runChatSearch(selectedId, value).catch(() => {});
                  }}
                  className="w-full bg-transparent text-sm text-ink-900 placeholder:text-ink-400 focus:outline-none dark:text-white"
                />
                <span className="shrink-0 text-[11px] text-ink-400">{messages.length} match{messages.length === 1 ? "" : "es"}</span>
                <button className="text-ink-400 hover:text-ink-600" onClick={() => { setChatSearch(null); if (selectedId) void runChatSearch(selectedId, ""); }} aria-label="Close search">
                  <XIcon className="h-4 w-4" />
                </button>
              </div>
            )}

            <div
              className="flex-1 overflow-y-auto bg-ink-50/60 px-4 py-4 dark:bg-night-raised/40"
              onClick={() => pickerId && setPickerId(null)}
            >
              {messages.map((msg) => {
                if (msg.type === "SYSTEM") {
                  return (
                    <div key={msg.id} className="mb-2 flex justify-center">
                      <p className="rounded-full bg-ink-200/70 px-3 py-1 text-[11px] font-medium text-ink-500 dark:bg-night-border dark:text-ink-300">
                        {msg.body}
                      </p>
                    </div>
                  );
                }
                const quoted = msg.replyToId ? messages.find((m) => m.id === msg.replyToId) ?? null : null;
                const mine = msg.senderId === account?.id;
                return (
                  <MessageBubble
                    key={msg.id}
                    message={msg}
                    mine={mine}
                    senderLabel={isGroup && !mine ? memberNames.get(msg.senderId ?? "") ?? null : null}
                    quotedText={replyQuoteLabel(msg, quoted)}
                    mentionNames={mentionNamesOf(msg, memberNames)}
                    selected={selectIds?.includes(msg.id) ?? false}
                    selecting={selectIds !== null}
                    onToggleSelect={() => toggleSelect(msg.id)}
                    pickerOpen={pickerId === msg.id}
                    onTogglePicker={() => setPickerId((id) => (id === msg.id ? null : msg.id))}
                    onReact={(emoji) => void toggleReaction(msg, emoji)}
                    onReply={() => {
                      setReplyTo(msg);
                      setEditing(null);
                      setDraft("");
                    }}
                    onForward={() => setForwardFor([msg.id])}
                    onSelect={() => toggleSelect(msg.id)}
                    onPin={() => void togglePin(msg)}
                    onViewOnce={() => setViewOnceFor(msg)}
                    onEdit={() => startEdit(msg)}
                    onDelete={() => setDeleteTarget(msg)}
                    onStar={() => void toggleStar(msg)}
                    onReport={() =>
                      setReportFor({
                        type: "MESSAGE",
                        id: msg.id,
                        label: `"${messageLabel(msg).slice(0, 24)}…"`,
                      })
                    }
                  />
                );
              })}
              {pending.map((p) => (
                <div key={p.clientMessageId} className="mb-2 flex justify-end">
                  <div className="max-w-[75%] rounded-bubble rounded-br-md bg-iris-500/60 px-3.5 py-2 text-sm text-white">
                    <p className="whitespace-pre-wrap break-words">{pendingLabel(p.body, p.attachmentCount)}</p>
                    <p className="mt-0.5 text-right text-[10px] text-white/80">
                      {p.status === "failed"
                        ? p.attachmentCount > 0
                          ? "Not sent — press Send to retry"
                          : "Not sent — will retry"
                        : "Sending…"}
                    </p>
                  </div>
                </div>
              ))}
              {isTyping && (
                <div className="mb-2 flex justify-start">
                  <div className="rounded-bubble rounded-bl-md bg-white px-4 py-2.5 text-sm text-ink-400 shadow-sm dark:bg-night-surface">
                    typing<span className="animate-pulse">…</span>
                  </div>
                </div>
              )}
              <div ref={bottomRef} />
            </div>

            <div className="border-t border-ink-200/70 bg-white p-3 dark:border-night-border dark:bg-night-surface">
              {selectIds && (
                <div className="mb-2 flex items-center justify-between rounded-lg border border-iris-200 bg-iris-50 px-3 py-1.5 text-xs dark:border-iris-500/40 dark:bg-iris-500/10">
                  <span className="font-semibold text-iris-700 dark:text-iris-200">
                    {selectIds.length} message{selectIds.length === 1 ? "" : "s"} selected
                  </span>
                  <span className="flex items-center gap-3">
                    <button
                      onClick={() => setForwardFor(selectIds)}
                      className="font-semibold text-iris-600 hover:underline dark:text-iris-300"
                    >
                      Forward
                    </button>
                    <button
                      onClick={() => setSelectIds(null)}
                      aria-label="Cancel selection"
                      className="text-ink-400 hover:text-ink-600"
                    >
                      <XIcon className="h-3.5 w-3.5" />
                    </button>
                  </span>
                </div>
              )}
              {(replyTo || editing) && (
                <div className="mb-2 flex items-center justify-between rounded-lg border border-ink-200 bg-ink-50 px-3 py-1.5 text-xs dark:border-night-border dark:bg-night-raised">
                  <span className="truncate text-ink-500 dark:text-ink-400">
                    {editing ? "Editing message" : `Replying to ${replyTo ? messageLabel(replyTo) : ""}`}
                  </span>
                  <button className="text-ink-400 hover:text-ink-600" onClick={cancelComposer} aria-label="Cancel">
                    <XIcon className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
              {!canPost && (
                <p className="mb-2 rounded-lg bg-ink-100 px-3 py-1.5 text-center text-[11px] font-medium text-ink-500 dark:bg-night-raised dark:text-ink-400">
                  Only admins can send messages in this group
                </p>
              )}
              <AttachmentTray files={staged} busy={uploading} onRemove={removeStaged} />
              {mediaError && (
                <p className="mb-2 rounded-lg bg-rose-50 px-3 py-1.5 text-[11px] font-medium text-rose-600 dark:bg-rose-500/10 dark:text-rose-300">
                  {mediaError}
                </p>
              )}
              {staged.length > 0 && (
                <button
                  type="button"
                  onClick={() => setViewOnceDraft((on) => !on)}
                  className={cx(
                    "mb-2 flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors",
                    viewOnceDraft
                      ? "border-iris-400 bg-iris-50 text-iris-600 dark:border-iris-500/50 dark:bg-iris-500/15 dark:text-iris-300"
                      : "border-ink-200 text-ink-500 hover:bg-ink-50 dark:border-night-border dark:text-ink-400 dark:hover:bg-night-raised",
                  )}
                >
                  <ViewOnceIcon className="h-3.5 w-3.5" />
                  {viewOnceDraft ? "View once · on" : "View once"}
                </button>
              )}
              {staged.length > 0 && staged.every((f) => f.kind === "IMAGE") && (
                <button
                  type="button"
                  onClick={() => setStickerDraft((on) => !on)}
                  className={cx(
                    "mb-2 ml-1.5 flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors",
                    stickerDraft
                      ? "border-iris-400 bg-iris-50 text-iris-600 dark:border-iris-500/50 dark:bg-iris-500/15 dark:text-iris-300"
                      : "border-ink-200 text-ink-500 hover:bg-ink-50 dark:border-night-border dark:text-ink-400 dark:hover:bg-night-raised",
                  )}
                >
                  <GifIcon className="h-3.5 w-3.5" />
                  {stickerDraft ? "Sticker · on" : "Send as sticker"}
                </button>
              )}
              {mentionCandidates.length > 0 && (
                <div className="mb-2 overflow-hidden rounded-xl border border-ink-200 bg-white shadow-sm dark:border-night-border dark:bg-night-raised">
                  {mentionCandidates.map((member, index) => (
                    <button
                      key={member.userId}
                      type="button"
                      // mousedown keeps focus in the textarea so typing can continue.
                      onMouseDown={(e) => {
                        e.preventDefault();
                        applyMention(member);
                      }}
                      className={cx(
                        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs",
                        index === mentionIdx
                          ? "bg-iris-50 dark:bg-iris-500/15"
                          : "hover:bg-ink-50 dark:hover:bg-night-surface",
                      )}
                    >
                      <span className="font-bold text-iris-600 dark:text-iris-300">@</span>
                      <span className="min-w-0 flex-1 truncate text-ink-700 dark:text-ink-200">
                        {memberLabel(member)}
                      </span>
                      {member.role === "ADMIN" && <span className="text-[10px] text-ink-400">admin</span>}
                    </button>
                  ))}
                  <p className="border-t border-ink-100 px-3 py-1 text-[10px] text-ink-400 dark:border-night-border">
                    ↑↓ to browse · Enter to insert · Esc to close
                  </p>
                </div>
              )}
              <div className="flex items-end gap-1.5">
                <AttachButton
                  disabled={!canPost || uploading || staged.length >= MAX_ATTACHMENTS}
                  onPicked={(files) => void stageFiles(files)}
                />
                <IconButton label="Send a GIF" onClick={() => setGifOpen(true)}>
                  <GifIcon className="h-5 w-5" />
                </IconButton>
                <IconButton label="Share your location" onClick={() => setLocationOpen(true)}>
                  <MapPinIcon className="h-5 w-5" />
                </IconButton>
                <IconButton label="Share a contact" onClick={() => setContactShareOpen(true)}>
                  <ContactsIcon className="h-5 w-5" />
                </IconButton>
                <textarea
                  value={draft}
                  onChange={(e) => onDraftChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (mentionCandidates.length > 0) {
                      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                        e.preventDefault();
                        setMentionIdx(
                          (i) =>
                            (i + (e.key === "ArrowDown" ? 1 : mentionCandidates.length - 1)) %
                            mentionCandidates.length,
                        );
                        return;
                      }
                      if (e.key === "Enter" || e.key === "Tab") {
                        e.preventDefault();
                        const pick = mentionCandidates[Math.min(mentionIdx, mentionCandidates.length - 1)];
                        if (pick) applyMention(pick);
                        return;
                      }
                      if (e.key === "Escape") {
                        e.preventDefault();
                        setMentionDismissed(true);
                        return;
                      }
                    }
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void submitComposer();
                    }
                    if (e.key === "Escape") cancelComposer();
                  }}
                  rows={1}
                  disabled={!canPost}
                  placeholder={editing ? "Edit your message" : canPost ? "Type a message" : "Admins only"}
                  className="max-h-32 min-h-[42px] flex-1 resize-none rounded-xl border border-ink-200 bg-ink-50 px-3.5 py-2.5 text-sm placeholder:text-ink-400 focus:border-iris-400 focus:outline-none disabled:opacity-60 dark:border-night-border dark:bg-night-raised dark:text-ink-100"
                />
                {!editing && draft.trim() === "" && staged.length === 0 && (
                  <VoiceRecorder onRecorded={(file, durationMs) => void stageRecording(file, durationMs)} />
                )}
                <Button
                  className="!px-4"
                  onClick={() => void submitComposer()}
                  disabled={!canPost || uploading || (draft.trim().length === 0 && staged.length === 0)}
                >
                  {editing ? "Save" : uploading ? "Uploading…" : "Send"}
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
      {panelOpen && isGroup && selectedId && (
        <GroupPanel
          conversationId={selectedId}
          selfUserId={account?.id ?? ""}
          onClose={() => setPanelOpen(false)}
          onLeft={() => {
            setPanelOpen(false);
            setSelectedId(null);
            void api.listConversations().then((l) => setConversations(l.conversations)).catch(() => {});
          }}
        />
      )}
      {showGroups && <GroupDirectoryDialog onClose={() => setShowGroups(false)} onOpen={(id) => void openGroup(id)} />}
      {confirming && (
        <ConfirmDialog
          title={confirming.action.kind === "clear" ? "Clear this chat?" : "Delete this chat?"}
          body={
            confirming.action.kind === "clear"
              ? "The messages disappear from your view. Anything not yet cleared by the other side still exists there."
              : `"${peerName(confirming.conversation)}" is removed from your list for good. The other person keeps the full history and your chat reappears when they message you again.`
          }
          confirmLabel={confirming.action.kind === "clear" ? "Clear chat" : "Delete chat"}
          onClose={() => setConfirming(null)}
          onConfirm={() => void runConfirm()}
        />
      )}
      {showStarred && (
        <StarredDialog
          onClose={() => setShowStarred(false)}
          onOpen={(conversationId) => {
            setShowStarred(false);
            void openConversation(conversationId);
          }}
        />
      )}
      {searchOpen && (
        <SearchDialog
          initial=""
          onClose={() => setSearchOpen(false)}
          onOpenConversation={(conversationId) => {
            setSearchOpen(false);
            void openConversation(conversationId);
          }}
        />
      )}
      {showContacts && (
        <ContactsDialog
          onClose={() => setShowContacts(false)}
          onOpenChat={(conversationId) => {
            setShowContacts(false);
            void openConversation(conversationId);
          }}
        />
      )}
      {showBlocked && <BlockedList onClose={() => setShowBlocked(false)} />}
      {infoFor && (
        <ContactInfoDialog
          userId={infoFor}
          onClose={() => setInfoFor(null)}
          onOpenChat={(conversationId) => {
            setInfoFor(null);
            void openConversation(conversationId);
          }}
        />
      )}
      {reportFor && (
        <ReportDialog
          targetType={reportFor.type}
          targetId={reportFor.id}
          targetLabel={reportFor.label}
          onClose={() => setReportFor(null)}
          onDone={() => setReportFor(null)}
        />
      )}
      {deleteTarget && (
        <DeleteDialog mine={deleteTarget.senderId === account?.id} onClose={() => setDeleteTarget(null)} onConfirm={confirmDelete} />
      )}
      {viewOnceFor && (
        <ViewOnceViewer
          message={viewOnceFor}
          onClose={(opened) => {
            if (opened) {
              setMessages((prev) =>
                prev.map((m) => (m.id === viewOnceFor.id ? { ...m, viewOnceOpened: true } : m)),
              );
            }
            setViewOnceFor(null);
          }}
        />
      )}
      {galleryOpen && selectedId && (
        <MediaGalleryDialog
          conversationId={selectedId}
          onClose={() => setGalleryOpen(false)}
          onOpenMessage={(message) => {
            // A view-once tile opens the burn-once overlay; everything else gets a lightbox.
            if (message.viewOnce) setViewOnceFor(message);
            else if (message.attachments.some((a) => a.kind === "IMAGE" || a.kind === "VIDEO")) {
              setGalleryPreview({ attachments: message.attachments, index: 0 });
            }
          }}
        />
      )}
      {galleryPreview && (
        <Lightbox
          attachments={galleryPreview.attachments}
          index={galleryPreview.index}
          onIndex={(index) => setGalleryPreview({ ...galleryPreview, index })}
          onClose={() => setGalleryPreview(null)}
        />
      )}
      {forwardFor && conversations && (
        <ForwardDialog
          messageIds={forwardFor}
          conversations={conversations.filter((c) => c.id !== selectedId)}
          onClose={() => setForwardFor(null)}
          onSent={() => {
            setForwardFor(null);
            setSelectIds(null);
            void api.listConversations().then((l) => setConversations(l.conversations)).catch(() => {});
          }}
        />
      )}
      {pinsOpen && (
        <PinsDialog
          pins={pins}
          onClose={() => setPinsOpen(false)}
          onJump={(messageId) => {
            setPinsOpen(false);
            jumpToMessage(messageId);
          }}
          onUnpin={(message) => void togglePin(message)}
        />
      )}
      {gifOpen && (
        <GifPickerDialog
          onClose={() => setGifOpen(false)}
          onStaged={(file) => stageReadyFile(file)}
        />
      )}
      {locationOpen && (
        <LocationShareDialog
          onClose={() => setLocationOpen(false)}
          onSend={(location) => void sendShare({ location })}
        />
      )}
      {contactShareOpen && (
        <ContactShareDialog
          onClose={() => setContactShareOpen(false)}
          onSend={(contactCard) => void sendShare({ contactCard })}
        />
      )}
    </div>
  );
}

function clientMsg(item: OutboxItem): string {
  return item.clientMessageId;
}

function memberLabel(member: GroupMember): string {
  return member.displayName ?? member.phone ?? "Convo user";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The `@token` the composer is currently typing, or null when the caret is not
 * inside a mention. The `@` must start the text or follow whitespace, so an
 * email address never opens the typeahead.
 */
function mentionTokenAt(text: string): string | null {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(text);
  return match?.[1] ?? null;
}

/** Display names of the members a message mentions, for pill rendering. */
function mentionNamesOf(message: Message, names: Map<string, string>): string[] {
  return message.mentions
    .map((userId) => names.get(userId))
    .filter((name): name is string => Boolean(name));
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className="rounded-full p-2 text-ink-400 transition-colors hover:bg-ink-100 hover:text-ink-700 dark:hover:bg-night-raised dark:hover:text-ink-200"
    >
      {children}
    </button>
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
  return last.body ?? attachmentKindLabel(last.type, last.attachments[0]?.fileName ?? null) ?? "";
}

function lastSeenLabel(lastSeenAt: string | null): string {
  if (!lastSeenAt) return "";
  const diff = Date.now() - new Date(lastSeenAt).getTime();
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return "last seen just now";
  if (mins < 60) return `last seen ${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `last seen ${hours}h ago`;
  return `last seen ${relativeTime(lastSeenAt)} ago`;
}

/**
 * Chat export (Phase 5C): hand the JSON document the API built straight to the
 * browser as a download.
 */
async function exportConversation(conversation: ConversationSummary): Promise<void> {
  const doc = await api.exportChat(conversation.id, false);
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `convo-chat-${doc.messageCount}-messages.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong";
}

/**
 * The quote line inside a reply bubble. The server snapshots the quoted message
 * (`replyPreview`), so a reply still shows its quote even when the original is
 * outside the loaded page — or was cleared for this viewer.
 */
function replyQuoteLabel(message: Message, quoted: Message | null): string | null {
  const preview = message.replyPreview;
  if (message.statusReply) {
    const line =
      preview?.body ?? attachmentKindLabel(preview?.kind ?? null, preview?.fileName ?? null);
    return line ? `Status reply · ${line}` : "Status reply";
  }
  if (preview) {
    if (preview.type === "LOCATION") return "Location";
    if (preview.type === "CONTACT") return "Contact card";
    return preview.body ?? attachmentKindLabel(preview.kind, preview.fileName) ?? "Message";
  }
  if (!message.replyToId) return null;
  if (!quoted) return "Message";
  if (quoted.deletedAt) return "Deleted message";
  return quoted.body ?? attachmentKindLabel(quoted.attachments[0]?.kind ?? null, quoted.attachments[0]?.fileName ?? null) ?? "Message";
}

function ConversationRow({
  conversation,
  active,
  online,
  menuOpen,
  onToggleMenu,
  onAction,
  onClick,
}: {
  conversation: ConversationSummary;
  active: boolean;
  online: boolean;
  menuOpen: boolean;
  onToggleMenu: () => void;
  onAction: (action: ChatAction) => void;
  onClick: () => void;
}) {
  const flags = chatFlags(conversation);
  return (
    <div className={cx("group/row relative", active && "bg-iris-50 dark:bg-iris-500/10")}>
      <button
        onClick={onClick}
        className={cx(
          "flex w-full items-center gap-3 px-4 py-3 text-left transition-colors",
          active ? "" : "hover:bg-ink-50 dark:hover:bg-night-raised/60",
        )}
      >
        <PeerAvatar name={peerName(conversation)} online={online} small group={conversation.type === "GROUP"} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <p className="flex items-center gap-1 truncate text-sm font-semibold text-ink-900 dark:text-white">
              {flags.pinned && <PinIcon className="h-3 w-3 shrink-0 text-iris-500" filled />}
              {peerName(conversation)}
            </p>
            {conversation.lastMessage && (
              <span className="shrink-0 text-[11px] text-ink-400">{relativeTime(conversation.lastMessage.createdAt)}</span>
            )}
          </div>
          <div className="mt-0.5 flex items-center justify-between gap-2">
            <p className="truncate text-xs text-ink-500 dark:text-ink-400">
              {conversation.group
                ? `${conversation.group.memberCount} members · ${previewText(conversation)}`
                : previewText(conversation)}
            </p>
            <span className="flex shrink-0 items-center gap-1">
              {flags.muted && <BellOffIcon className="h-3.5 w-3.5 text-ink-400" />}
              {conversation.unreadMentions > 0 && (
                <span
                  className="flex h-5 min-w-5 items-center justify-center rounded-full bg-signal-500 px-1.5 text-[11px] font-bold text-white"
                  title={`${conversation.unreadMentions} unread mention${conversation.unreadMentions === 1 ? "" : "s"}`}
                >
                  @
                </span>
              )}
              {conversation.unreadCount > 0 && (
                <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-iris-500 px-1.5 text-[11px] font-bold text-white">
                  {conversation.unreadCount > 99 ? "99+" : conversation.unreadCount}
                </span>
              )}
            </span>
          </div>
        </div>
      </button>
      <button
        onClick={onToggleMenu}
        aria-label="Chat options"
        className={cx(
          "absolute right-1 top-2 rounded-full p-1 text-ink-400 transition-opacity hover:bg-ink-100 hover:text-ink-700 dark:hover:bg-night-raised",
          menuOpen ? "opacity-100" : "opacity-0 group-hover/row:opacity-100",
        )}
      >
        <DotsIcon className="h-4 w-4" />
      </button>
      {menuOpen && (
        <ChatMenu conversation={conversation} onClose={onToggleMenu} onAction={onAction} />
      )}
    </div>
  );
}

function MessageBubble({
  message,
  mine,
  senderLabel,
  quotedText,
  mentionNames,
  selected,
  selecting,
  onToggleSelect,
  pickerOpen,
  onTogglePicker,
  onReact,
  onReply,
  onForward,
  onSelect,
  onPin,
  onViewOnce,
  onEdit,
  onDelete,
  onStar,
  onReport,
}: {
  message: Message;
  mine: boolean;
  senderLabel: string | null;
  quotedText: string | null;
  /** Roster members this message @-mentions (5E). */
  mentionNames: string[];
  selected: boolean;
  selecting: boolean;
  onToggleSelect: () => void;
  pickerOpen: boolean;
  onTogglePicker: () => void;
  onReact: (emoji: string) => void;
  onReply: () => void;
  onForward: () => void;
  onSelect: () => void;
  onPin: () => void;
  onViewOnce: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onStar: () => void;
  onReport: () => void;
}) {
  if (message.deletedAt) {
    return (
      <div id={`convo-msg-${message.id}`} className={cx("mb-2 flex", mine ? "justify-end" : "justify-start")}>
        <p className="rounded-bubble bg-ink-100 px-3.5 py-2 text-xs italic text-ink-400 dark:bg-night-raised">
          Message deleted
        </p>
      </div>
    );
  }

  const sticker = message.type === "STICKER";
  return (
    <div
      id={`convo-msg-${message.id}`}
      className={cx("group mb-2 flex items-end gap-1", mine ? "flex-row-reverse" : "flex-row")}
    >
      {selecting && (
        <button
          onClick={onToggleSelect}
          aria-label={selected ? "Deselect message" : "Select message"}
          className={cx(
            "mb-2 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors",
            selected
              ? "border-iris-500 bg-iris-500 text-white"
              : "border-ink-300 bg-white dark:border-night-border dark:bg-night-surface",
          )}
        >
          {selected && <CheckIcon className="h-3 w-3" />}
        </button>
      )}
      <div
        className={cx(
          "relative max-w-[75%]",
          selecting && "cursor-pointer",
          selected && "rounded-bubble ring-2 ring-iris-400",
        )}
        onClick={selecting ? onToggleSelect : undefined}
      >
        <div
          className={cx(
            "rounded-bubble text-sm shadow-sm",
            sticker
              ? "px-1 py-1"
              : "px-3.5 py-2",
            mine
              ? sticker
                ? "bg-transparent shadow-none"
                : "rounded-br-md bg-iris-500 text-white"
              : "rounded-bl-md bg-white text-ink-800 dark:bg-night-surface dark:text-ink-100",
          )}
        >
          {quotedText !== null && (
            <p
              className={cx(
                "mb-1 border-l-2 pl-2 text-xs",
                mine ? "border-white/50 text-white/80" : "border-ink-300 text-ink-500 dark:border-night-border dark:text-ink-400",
              )}
            >
              {quotedText || "Message"}
            </p>
          )}
          {senderLabel && (
            <p className="mb-0.5 text-[11px] font-bold text-signal-500 dark:text-signal-400">{senderLabel}</p>
          )}
          {message.forwardedFrom && (
            <p
              className={cx(
                "mb-0.5 flex items-center gap-1 text-[10px] font-medium",
                mine ? "text-white/75" : "text-ink-400",
              )}
            >
              <ForwardIcon className="h-3 w-3 shrink-0" />
              <span className="truncate">
                Forwarded{message.forwardedFrom.displayName ? ` from ${message.forwardedFrom.displayName}` : ""}
              </span>
            </p>
          )}
          {message.location && <LocationCard location={message.location} />}
          {message.contactCard && <SharedContactCard card={message.contactCard} />}
          <MessageAttachments message={message} onViewOnce={onViewOnce} />
          {message.body &&
            (mentionNames.length > 0 ? (
              <MentionBody body={message.body} names={mentionNames} mine={mine} />
            ) : (
              <p className="whitespace-pre-wrap break-words">{message.body}</p>
            ))}
          {message.linkPreview && <LinkPreviewCard preview={message.linkPreview} />}
          <p className={cx("mt-0.5 text-right text-[10px]", mine && !sticker ? "text-white/75" : "text-ink-400")}>
            {message.pinned && (
              <span className={cx("mr-1 inline-flex items-center gap-0.5", mine ? "text-white/80" : "text-iris-500")} title="Pinned in this chat">
                <PinIcon className="h-3 w-3" filled />
                pinned
              </span>
            )}
            {message.viewOnce && (
              <span className={cx("mr-1 inline-flex items-center gap-0.5 italic", mine ? "text-white/75" : "text-ink-400")}>
                <ViewOnceIcon className="h-3 w-3" />view once
              </span>
            )}
            {message.starredByMe && (
              <StarIcon className={cx("mr-1 inline h-3 w-3", mine ? "text-signal-300" : "text-amber-500")} filled />
            )}
            {message.editedAt && <span className="mr-1 italic">edited</span>}
            {new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            {mine && <DeliveryTick status={message.deliveryStatus} />}
          </p>
        </div>

        {message.reactions.length > 0 && (
          <div className={cx("mt-1 flex flex-wrap gap-1", mine ? "justify-end" : "justify-start")}>
            {message.reactions.map((r) => (
              <button
                key={r.emoji}
                onClick={() => onReact(r.emoji)}
                className={cx(
                  "rounded-full border px-1.5 py-0.5 text-xs transition-colors",
                  r.reactedByMe
                    ? "border-iris-300 bg-iris-100 dark:border-iris-500/40 dark:bg-iris-500/20"
                    : "border-ink-200 bg-white dark:border-night-border dark:bg-night-surface",
                )}
              >
                {r.emoji} <span className="text-ink-500 dark:text-ink-400">{r.count}</span>
              </button>
            ))}
          </div>
        )}

        {pickerOpen && (
          <div
            className={cx(
              "absolute bottom-full z-10 mb-1 flex gap-1 rounded-full border border-ink-200 bg-white px-1.5 py-1 shadow-lg dark:border-night-border dark:bg-night-surface",
              mine ? "right-0" : "left-0",
            )}
            onClick={(e) => e.stopPropagation()}
          >
            {QUICK_REACTIONS.map((emoji) => (
              <button
                key={emoji}
                onClick={() => onReact(emoji)}
                className="rounded-full px-1 text-lg transition-transform hover:scale-125"
              >
                {emoji}
              </button>
            ))}
          </div>
        )}
      </div>

      <div
        className={cx(
          "flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100",
          selecting && "hidden",
        )}
      >
        <BubbleAction label="React" onClick={onTogglePicker}>
          <SmileIcon className="h-4 w-4" />
        </BubbleAction>
        <BubbleAction label="Reply" onClick={onReply}>
          <ReplyIcon className="h-4 w-4" />
        </BubbleAction>
        {!message.viewOnce && (
          <BubbleAction label="Forward" onClick={onForward}>
            <ForwardIcon className="h-4 w-4" />
          </BubbleAction>
        )}
        <BubbleAction label="Select messages" onClick={onSelect}>
          <CheckIcon className="h-4 w-4" />
        </BubbleAction>
        <BubbleAction label={message.pinned ? "Unpin for everyone" : "Pin in chat"} onClick={onPin}>
          <PinIcon className="h-4 w-4" filled={Boolean(message.pinned)} />
        </BubbleAction>
        <BubbleAction label={message.starredByMe ? "Unstar" : "Star"} onClick={onStar}>
          <StarIcon className="h-4 w-4" filled={message.starredByMe} />
        </BubbleAction>
        {mine ? (
          <>
            <BubbleAction label="Edit" onClick={onEdit}>
              <PencilIcon className="h-4 w-4" />
            </BubbleAction>
            <BubbleAction label="Delete" onClick={onDelete}>
              <TrashIcon className="h-4 w-4" />
            </BubbleAction>
          </>
        ) : (
          <BubbleAction label="Report" onClick={onReport}>
            <FlagIcon className="h-4 w-4" />
          </BubbleAction>
        )}
      </div>
    </div>
  );
}

function BubbleAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className="rounded-full p-1 text-ink-400 transition-colors hover:bg-ink-100 hover:text-ink-600 dark:hover:bg-night-raised dark:hover:text-ink-200"
    >
      {children}
    </button>
  );
}

function DeliveryTick({ status }: { status: Message["deliveryStatus"] }) {
  if (status === "READ") return <DoubleCheckIcon className="ml-1 inline h-3.5 w-3.5 text-sky-200" />;
  if (status === "DELIVERED") return <DoubleCheckIcon className="ml-1 inline h-3.5 w-3.5 text-white/80" />;
  return <CheckIcon className="ml-1 inline h-3 w-3 text-white/60" />;
}

/**
 * Body text with the mentioned members rendered as pills (5E). The names come
 * from the server-resolved mention ids, so only real roster members light up.
 */
function MentionBody({ body, names, mine }: { body: string; names: string[]; mine: boolean }) {
  const alternation = [...names]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|");
  const splitter = new RegExp(`(@(?:${alternation})(?![\\p{L}\\p{N}]))`, "gi");
  const isMention = new RegExp(`^@(?:${alternation})(?![\\p{L}\\p{N}])$`, "i");
  return (
    <p className="whitespace-pre-wrap break-words">
      {body.split(splitter).map((part, index) =>
        isMention.test(part) ? (
          <span
            key={index}
            className={cx(
              "rounded px-1 font-semibold",
              mine
                ? "bg-white/20 text-white"
                : "bg-iris-100 text-iris-700 dark:bg-iris-500/20 dark:text-iris-200",
            )}
          >
            {part}
          </span>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </p>
  );
}

/** Every pinned message in the chat, newest pin first. */
function PinsDialog({
  pins,
  onClose,
  onJump,
  onUnpin,
}: {
  pins: ChatPin[];
  onClose: () => void;
  onJump: (messageId: string) => void;
  onUnpin: (message: Message) => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md animate-rise rounded-card border border-ink-200/70 bg-white p-4 shadow-xl dark:border-night-border dark:bg-night-surface"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">
            Pinned messages ({pins.length})
          </p>
          <button onClick={onClose} aria-label="Close" className="text-ink-400 hover:text-ink-600">
            <XIcon className="h-4 w-4" />
          </button>
        </div>
        <ul className="mt-3 max-h-80 space-y-2 overflow-y-auto">
          {pins.map(({ message, pin }) => (
            <li
              key={message.id}
              className="flex items-start gap-2 rounded-xl border border-ink-200 px-3 py-2 dark:border-night-border"
            >
              <button className="min-w-0 flex-1 text-left" onClick={() => onJump(message.id)}>
                <p className="truncate text-sm text-ink-800 dark:text-ink-100">{messageLabel(message)}</p>
                <p className="mt-0.5 text-[11px] text-ink-400">
                  {pin.displayName ?? "A member"} · {relativeTime(pin.pinnedAt)} ago
                </p>
              </button>
              <button
                onClick={() => onUnpin(message)}
                aria-label="Unpin message"
                className="shrink-0 text-ink-400 hover:text-rose-600"
              >
                <TrashIcon className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function PeerAvatar({
  name,
  online,
  small,
  group,
}: {
  name: string;
  online?: boolean;
  small?: boolean;
  group?: boolean;
}) {
  const initial = name.replace(/[^\p{L}\p{N}]/gu, "").charAt(0).toUpperCase() || "?";
  const size = small ? "h-10 w-10 text-sm" : "h-9 w-9 text-xs";
  return (
    <span className="relative shrink-0">
      <span
        className={cx(
          "flex items-center justify-center rounded-full bg-gradient-to-br from-iris-500 to-signal-400 font-bold text-white",
          size,
        )}
      >
        {group ? <GroupsIcon className={small ? "h-5 w-5" : "h-4 w-4"} /> : initial}
      </span>
      {online && (
        <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-white bg-emerald-400 dark:border-night-surface" />
      )}
    </span>
  );
}

function DeleteDialog({
  mine,
  onClose,
  onConfirm,
}: {
  mine: boolean;
  onClose: () => void;
  onConfirm: (scope: "MINE" | "EVERYONE") => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-xs animate-rise rounded-card border border-ink-200/70 bg-white p-2 shadow-xl dark:border-night-border dark:bg-night-surface"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="px-4 py-3 text-sm font-semibold text-ink-900 dark:text-white">Delete message?</p>
        <button
          onClick={() => onConfirm("MINE")}
          className="w-full rounded-lg px-4 py-2.5 text-left text-sm text-ink-700 hover:bg-ink-50 dark:text-ink-200 dark:hover:bg-night-raised"
        >
          Delete for me
        </button>
        {mine && (
          <button
            onClick={() => onConfirm("EVERYONE")}
            className="w-full rounded-lg px-4 py-2.5 text-left text-sm text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-500/10"
          >
            Delete for everyone
          </button>
        )}
        <button
          onClick={onClose}
          className="mt-1 w-full rounded-lg px-4 py-2.5 text-left text-sm font-medium text-ink-400 hover:bg-ink-50 dark:hover:bg-night-raised"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Suggestion row for the new-chat dialog (recents merged with saved contacts). */
interface ChatSuggestion {
  phone: string;
  name: string;
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
  const [people, setPeople] = useState<ChatSuggestion[]>([]);

  // WhatsApp-style "who can you message" list: recent chats first, then contacts.
  useEffect(() => {
    let cancelled = false;
    Promise.all([api.recentRecipients(), api.listContacts()])
      .then(([recents, contacts]) => {
        if (cancelled) return;
        const seen = new Set<string>();
        const rows: ChatSuggestion[] = [];
        for (const r of [...recents.recipients, ...contacts.contacts]) {
          if (!r.phone || seen.has(r.phone)) continue;
          seen.add(r.phone);
          rows.push({ phone: r.phone, name: r.displayName ?? r.phone });
        }
        setPeople(rows);
      })
      .catch(() => {
        if (!cancelled) setPeople([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const start = async (value: string) => {
    setBusy(true);
    const err = await onStart(value);
    setBusy(false);
    if (err) setError(err);
  };

  const submit = () => start(phone.trim());

  const term = phone.trim().toLowerCase();
  const suggestions = (term
    ? people.filter((p) => p.phone.toLowerCase().includes(term) || p.name.toLowerCase().includes(term))
    : people
  ).slice(0, 6);

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
        {suggestions.length > 0 && (
          <div className="mt-4 max-h-44 overflow-y-auto rounded-xl border border-ink-200/70 dark:border-night-border">
            <p className="border-b border-ink-200/70 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-400 dark:border-night-border">
              {term ? "Matches" : "Recent and contacts"}
            </p>
            {suggestions.map((s) => (
              <button
                key={s.phone}
                onClick={() => void start(s.phone)}
                disabled={busy}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-ink-50 disabled:opacity-50 dark:hover:bg-night-raised"
              >
                <PeerAvatar name={s.name} small={false} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-ink-800 dark:text-ink-100">{s.name}</span>
                  <span className="block truncate text-xs text-ink-400">{s.phone}</span>
                </span>
              </button>
            ))}
          </div>
        )}
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
