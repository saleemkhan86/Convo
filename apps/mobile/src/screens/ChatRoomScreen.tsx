import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";import { File, Paths } from "expo-file-system";
import type {
  Account,
  ChatPin,
  ConversationSummary,
  GroupDetail,
  GroupMember,
  Message,
  MessageLocation,
  ReportTargetType,
  SharedContact,
  WsServerEvent,
} from "@convo/shared";
import { api } from "../api";
import { useRealtimeEvents, useRealtimeStatus, sendRealtime } from "../realtime";
import { startCall, useCallState } from "../calls";
import { newClientMessageId, outboxAdd, outboxRemove } from "../outbox";
import {
  attachmentKindLabel,
  avatarInitial,
  clockTime,
  errorMessage,
  lastSeenLabel,
  memberLabel,
  mentionNamesOf,
  mentionTokenAt,
  messageLabel,
  peerName,
  relativeTime,
  replyQuoteLabel,
  splitMentions,
} from "../chatUtils";
import { Avatar, usePalette } from "../components/ui";
import {
  AttachmentTray,
  AttachSheet,
  ContactShareSheet,
  ForwardSheet,
  GifSheet,
  LinkPreviewCard,
  LocationCard,
  LocationSheet,
  MAX_ATTACHMENTS,
  MediaGallerySheet,
  MessageMedia,
  SharedContactCard,
  ViewOnceSheet,
  toAttachmentInput,
  useMediaAutoAllowed,
  type StagedFile,
} from "../components/ChatMedia";
import {
  ChatActionSheet,
  ConfirmSheet,
  ReportSheet,
  SheetButton,
  applyQuietAction,
  shortEphemeral,
  type ChatAction,
} from "../components/ChatControls";
import { colors, radius, spacing } from "../theme";

interface PendingMessage {
  clientMessageId: string;
  body: string;
  status: "sending" | "failed";
  attachmentCount: number;
  /** Location/contact shares show a fixed line instead of a body. */
  label?: string;
}

function pendingLabel(body: string, attachmentCount: number, label?: string): string {
  if (label) return label;
  if (body) return body;
  if (attachmentCount === 1) return "1 attachment";
  return `${attachmentCount} attachments`;
}

const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

export function ChatRoomScreen({
  conversation,
  account,
  onBack,
  onOpenGroup,
  onOpenUser,
}: {
  conversation: ConversationSummary;
  account: Account;
  onBack: () => void;
  onOpenGroup: () => void;
  onOpenUser: (userId: string) => void;
}) {
  const palette = usePalette();
  const wsStatus = useRealtimeStatus();
  const callState = useCallState();
  const conversationId = conversation.id;
  const peer = conversation.peer;
  const name = peerName(conversation);
  const isGroup = conversation.type === "GROUP";

  const [messages, setMessages] = useState<Message[]>([]);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [typingUntil, setTypingUntil] = useState(0);
  const [peerOnline, setPeerOnline] = useState(false);
  const [peerLastSeen, setPeerLastSeen] = useState<string | null>(peer?.lastSeenAt ?? null);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [menuFor, setMenuFor] = useState<Message | null>(null);
  const [confirmDeleteFor, setConfirmDeleteFor] = useState<Message | null>(null);
  const [group, setGroup] = useState<GroupDetail | null>(null);
  const [chatMenu, setChatMenu] = useState(false);
  const [chatState, setChatState] = useState(conversation);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<ChatAction | null>(null);
  const [reportFor, setReportFor] = useState<{ type: ReportTargetType; id: string; label: string } | null>(null);
  const [searchTerm, setSearchTerm] = useState<string | null>(null);

  // Phase 5B media
  const [staged, setStaged] = useState<StagedFile[]>([]);
  const [attachSheet, setAttachSheet] = useState(false);
  const [viewOnceDraft, setViewOnceDraft] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [viewOnceFor, setViewOnceFor] = useState<Message | null>(null);
  const [galleryMenu, setGalleryMenu] = useState(false);
  const [forwardFor, setForwardFor] = useState<string[] | null>(null);
  const [forwardChats, setForwardChats] = useState<ConversationSummary[]>([]);
  // Phase 5B extras
  const [gifSheet, setGifSheet] = useState(false);
  const [locationSheet, setLocationSheet] = useState(false);
  const [contactSheet, setContactSheet] = useState(false);
  const [stickerDraft, setStickerDraft] = useState(false);
  // Phase 5E group parity: pins, @mentions, multi-select forward.
  const [pins, setPins] = useState<ChatPin[]>([]);
  const [pinsSheet, setPinsSheet] = useState(false);
  const [selectIds, setSelectIds] = useState<string[] | null>(null);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const allowAuto = useMediaAutoAllowed(account);

  const scrollRef = useRef<ScrollView>(null);
  /** Bubble nodes, so a pin banner can scroll to its message. */
  const bubbleRefs = useRef(new Map<string, View>());
  const typingSentAt = useRef(0);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadTimeline = useCallback(async (q?: string) => {
    const page = await api.listMessages(conversationId, undefined, 50, q ? { q } : {});
    return page.messages;
  }, [conversationId]);

  const clearStaged = useCallback(() => {
    setStaged([]);
    setViewOnceDraft(false);
    setStickerDraft(false);
    setMediaError(null);
  }, []);

  /** Forwarding posts by reference into other chats, so it needs their list. */
  const openForward = useCallback((messageIds: string[]) => {
    setMenuFor(null);
    setForwardFor(messageIds);
    api
      .listConversations()
      .then((l) => setForwardChats(l.conversations.filter((c) => c.id !== conversationId)))
      .catch(() => setForwardChats([]));
  }, [conversationId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const page = await api.listMessages(conversationId);
        if (cancelled) return;
        setMessages(page.messages);
        setLoading(false);
        await api.markRead(conversationId).catch(() => {});
      } catch (err) {
        if (!cancelled) {
          setLoadError(errorMessage(err));
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  // In-chat search is server-side, so matches outside the loaded window count too.
  useEffect(() => {
    if (searchTerm === null || loading) return;
    const value = searchTerm.trim();
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!value) {
      void loadTimeline().then((rows) => setMessages(rows));
      return;
    }
    searchTimer.current = setTimeout(() => {
      void loadTimeline(value)
        .then((rows) => setMessages(rows))
        .catch(() => {});
    }, 300);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [searchTerm, loading, loadTimeline]);

  // Watch the peer's presence while the socket is open.
  useEffect(() => {
    if (wsStatus === "open" && peer) {
      sendRealtime({ type: "watch", userIds: [peer.userId] });
    }
  }, [wsStatus, peer]);

  // Group chats need the roster (sender labels) and the live settings.
  const loadGroup = useCallback(async () => {
    if (!isGroup) return;
    try {
      setGroup(await api.group(conversationId));
    } catch {
      // Left/deleted between navigation and load: the chat becomes read-only.
      setGroup(null);
    }
  }, [conversationId, isGroup]);

  useEffect(() => {
    void loadGroup();
  }, [loadGroup]);

  /** Pinned messages feed the banner; the newest pin is the first row. */
  const loadPins = useCallback(async () => {
    try {
      setPins((await api.pinnedMessages(conversationId)).pins);
    } catch {
      setPins([]);
    }
  }, [conversationId]);

  useEffect(() => {
    void loadPins();
  }, [loadPins]);

  /**
   * Scroll to a message. `measure` reports the node's offset inside the scroll
   * content, which is exactly what scrollTo needs.
   */
  const jumpToMessage = useCallback((messageId: string) => {
    const target = bubbleRefs.current.get(messageId);
    if (!target) {
      setNotice("That message isn't loaded in this view.");
      return;
    }
    target.measure((_x, _y, _w, _h, _pageX, pageY) => {
      scrollRef.current?.scrollTo({ y: Math.max(0, pageY - 80), animated: true });
    });
  }, []);

  /** Pin or unpin for the whole chat (5E). */
  const togglePin = useCallback(async (msg: Message) => {
    setMenuFor(null);
    try {
      const updated = await api.setMessagePinned(msg.id, msg.pinned === null);
      setMessages((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
      void api.pinnedMessages(msg.conversationId).then((l) => setPins(l.pins)).catch(() => {});
    } catch {
      // ignore; the broadcast corrects other members
    }
  }, []);

  /** Multi-select forward (5E): the first id starts a selection, later taps toggle. */
  const toggleSelect = useCallback((messageId: string) => {
    setSelectIds((prev) => {
      if (prev === null) return [messageId];
      const next = prev.includes(messageId) ? prev.filter((id) => id !== messageId) : [...prev, messageId];
      return next.length === 0 ? null : next;
    });
  }, []);

  // Typing indicator expiry.
  useEffect(() => {
    if (typingUntil === 0) return;
    const t = setTimeout(() => setTypingUntil(0), Math.max(0, typingUntil - Date.now()) + 50);
    return () => clearTimeout(t);
  }, [typingUntil]);

  // The export confirmation is a transient banner.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 8000);
    return () => clearTimeout(t);
  }, [notice]);

  useRealtimeEvents(
    useCallback(
      (event: WsServerEvent) => {
        switch (event.type) {
          case "message.new":
            if (event.message.conversationId !== conversationId) break;
            setMessages((prev) => (prev.some((m) => m.id === event.message.id) ? prev : [...prev, event.message]));
            void api.markRead(conversationId, event.message.id).catch(() => {});
            break;
          case "message.edited":
            if (event.conversationId !== conversationId) break;
            setMessages((prev) =>
              prev.map((m) => (m.id === event.messageId ? { ...m, body: event.body, editedAt: event.editedAt } : m)),
            );
            break;
          case "message.deleted":
            if (event.conversationId !== conversationId) break;
            if (event.scope === "MINE") {
              if (event.userId === account.id) setMessages((prev) => prev.filter((m) => m.id !== event.messageId));
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
          case "message.reacted":
            if (event.conversationId !== conversationId) break;
            setMessages((prev) =>
              prev.map((m) => {
                if (m.id !== event.messageId) return m;
                const flags = new Map(m.reactions.map((r) => [r.emoji, r.reactedByMe]));
                return {
                  ...m,
                  reactions: event.reactions.map((t) => ({
                    emoji: t.emoji,
                    count: t.count,
                    reactedByMe: flags.get(t.emoji) ?? false,
                  })),
                };
              }),
            );
            break;
          case "message.delivered":
            if (event.conversationId !== conversationId) break;
            setMessages((prev) =>
              prev.map((m) =>
                event.messageIds.includes(m.id) && m.deliveryStatus !== "READ"
                  ? { ...m, deliveryStatus: "DELIVERED" }
                  : m,
              ),
            );
            break;
          case "message.read":
            if (event.conversationId !== conversationId || event.userId === account.id) break;
            setMessages((prev) => {
              const readAt = new Date(event.readAt).getTime();
              return prev.map((m) =>
                m.senderId === account.id && new Date(m.createdAt).getTime() <= readAt
                  ? { ...m, deliveryStatus: "READ" }
                  : m,
              );
            });
            break;
          case "message.viewOnceOpened":
            if (event.conversationId !== conversationId) break;
            // The viewer's own burn arrives here too; the sheet marks it locally.
            setMessages((prev) =>
              prev.map((m) => (m.id === event.messageId ? { ...m, viewOnceOpened: true } : m)),
            );
            break;
          case "message.linkPreview":
            if (event.conversationId !== conversationId) break;
            // Unfurl runs after the send, so the card lands on its own event.
            setMessages((prev) =>
              prev.map((m) => (m.id === event.messageId ? { ...m, linkPreview: event.preview } : m)),
            );
            break;
          case "message.pin":
            if (event.conversationId !== conversationId) break;
            setMessages((prev) =>
              prev.map((m) => (m.id === event.messageId ? { ...m, pinned: event.pin } : m)),
            );
            if (event.pin) void loadPins();
            else setPins((prev) => prev.filter((p) => p.message.id !== event.messageId));
            break;
          case "message.expired":
            if (event.conversationId !== conversationId) break;
            setMessages((prev) => prev.filter((m) => m.id !== event.messageId));
            break;
          case "conversation.ephemeralChanged":
            if (event.conversationId === conversationId) {
              setChatState((prev) => ({ ...prev, ephemeralSeconds: event.seconds }));
            }
            break;
          case "typing":
            if (event.conversationId === conversationId && event.isTyping) setTypingUntil(Date.now() + 4000);
            break;
          case "presence":
            if (peer && event.userId === peer.userId) {
              setPeerOnline(event.online);
              if (!event.online) {
                // lastSeen is privacy-gated; trust only the REST value.
                void api
                  .listConversations()
                  .then((l) => {
                    const found = l.conversations.find((c) => c.id === conversationId);
                    if (found?.peer) setPeerLastSeen(found.peer.lastSeenAt);
                  })
                  .catch(() => {});
              }
            }
            break;
          case "group.changed":
          case "group.joined":
          case "group.joinRequest.new":
            if (isGroup && event.conversationId === conversationId) void loadGroup();
            break;
        }
      },
      [conversationId, peer, account.id, isGroup, loadGroup, loadPins],
    ),
  );

  useEffect(() => {
    if (!loading) {
      const t = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: false }), 50);
      return () => clearTimeout(t);
    }
  }, [messages.length, pending.length, loading]);

  const onDraftChange = (value: string) => {
    setDraft(value);
    setMentionDismissed(false);
    if (editing) return;
    const now = Date.now();
    if (value.length > 0 && now - typingSentAt.current > 3000) {
      typingSentAt.current = now;
      sendRealtime({ type: "typing", conversationId, isTyping: true });
      if (typingTimer.current) clearTimeout(typingTimer.current);
      typingTimer.current = setTimeout(() => {
        sendRealtime({ type: "typing", conversationId, isTyping: false });
      }, 2500);
    }
  };

  const submitComposer = async () => {
    const body = draft.trim();
    if (!body && staged.length === 0) return;

    if (editing) {
      const target = editing;
      setEditing(null);
      setDraft("");
      try {
        const updated = await api.editMessage(target.id, body);
        setMessages((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
      } catch {
        setDraft(body);
      }
      return;
    }

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
    setPending((p) => [...p, { clientMessageId, body, status: "sending", attachmentCount: media.length }]);
    // Media lives at a temporary object URL, so it can't survive an offline
    // reload; only text messages enter the outbox.
    const queued = media.length === 0;
    if (queued) outboxAdd({ conversationId, clientMessageId, body, queuedAt: Date.now() });
    try {
      const msg = await api.sendMessage(conversationId, {
        clientMessageId,
        body: body || undefined,
        replyToId: quoted,
        attachments: media.length > 0 ? media.map(toAttachmentInput) : undefined,
        viewOnce: viewOnce || undefined,
        sticker: sticker || undefined,
      });
      if (queued) outboxRemove(clientMessageId);
      setPending((p) => p.filter((m) => m.clientMessageId !== clientMessageId));
      setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
    } catch {
      setPending((p) => p.map((m) => (m.clientMessageId === clientMessageId ? { ...m, status: "failed" } : m)));
      if (media.length > 0) {
        setStaged(media);
        setViewOnceDraft(viewOnce);
        setStickerDraft(sticker);
        setDraft(body);
      }
    }
  };

  /** Location/contact shares: no media, a JSON payload, and a fixed pending label. */
  const sendShare = async (payload: { location?: MessageLocation; contactCard?: SharedContact }) => {
    const label = payload.location ? "Location" : "Contact card";
    const clientMessageId = newClientMessageId();
    setPending((p) => [...p, { clientMessageId, body: "", status: "sending", attachmentCount: 0, label }]);
    try {
      const msg = await api.sendMessage(conversationId, { clientMessageId, ...payload });
      setPending((p) => p.filter((m) => m.clientMessageId !== clientMessageId));
      setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
    } catch {
      setPending((p) => p.map((m) => (m.clientMessageId === clientMessageId ? { ...m, status: "failed" } : m)));
    }
  };

  /** Files picked from the attach sheet land here once uploaded. */
  const stageFiles = (files: StagedFile[]) => {
    setMediaError(null);
    setStaged((prev) => {
      const room = MAX_ATTACHMENTS - prev.length;
      if (room <= 0) {
        setMediaError(`A message can carry up to ${MAX_ATTACHMENTS} attachments.`);
        return prev;
      }
      return [...prev, ...files.slice(0, room)];
    });
  };

  const toggleReaction = async (msg: Message, emoji: string) => {
    setMenuFor(null);
    const reacted = msg.reactions.some((r) => r.emoji === emoji && r.reactedByMe);
    try {
      const updated = reacted ? await api.removeReaction(msg.id, emoji) : await api.reactMessage(msg.id, emoji);
      setMessages((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
    } catch {
      // ignore; broadcast corrects other members
    }
  };

  const runDelete = async (scope: "MINE" | "EVERYONE") => {
    const msg = confirmDeleteFor;
    setConfirmDeleteFor(null);
    setMenuFor(null);
    if (!msg) return;
    try {
      await api.deleteMessage(msg.id, scope);
      if (scope === "MINE") setMessages((prev) => prev.filter((m) => m.id !== msg.id));
      else
        setMessages((prev) =>
          prev.map((m) => (m.id === msg.id ? { ...m, deletedAt: new Date().toISOString(), body: null, reactions: [] } : m)),
        );
    } catch {
      // ignore
    }
  };

  const toggleStar = async (msg: Message) => {
    setMenuFor(null);
    try {
      const updated = await api.starMessage(msg.id, !msg.starredByMe);
      setMessages((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
    } catch {
      // ignore; the next load reflects the server
    }
  };

  /**
   * Chat-level controls from the header sheet. Clear and delete need a
   * confirmation, so they are parked in state instead of run here.
   */
  const runChatAction = async (action: ChatAction) => {
    setChatMenu(false);
    if (action.kind === "clear" || action.kind === "delete") {
      setConfirming(action);
      return;
    }
    if (action.kind === "info") {
      if (peer) onOpenUser(peer.userId);
      return;
    }
    if (action.kind === "report") {
      setReportFor(
        peer
          ? { type: "USER", id: peer.userId, label: name }
          : { type: "CONVERSATION", id: conversationId, label: name },
      );
      return;
    }
    if (action.kind === "ephemeral") {
      try {
        const updated = await api.setEphemeral(conversationId, action.seconds);
        setChatState(updated);
      } catch (err) {
        setLoadError(errorMessage(err));
      }
      return;
    }
    if (action.kind === "export") {
      try {
        const doc = await api.exportChat(conversationId, false);
        const fileName = `convo-${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-messages.json`;
        const file = new File(Paths.document, fileName);
        file.create({ overwrite: true });
        file.write(JSON.stringify(doc, null, 2));
        setNotice(`Exported ${doc.messages.length} messages to ${fileName}`);
      } catch (err) {
        setLoadError(errorMessage(err));
      }
      return;
    }
    try {
      const updated = await applyQuietAction(chatState, action);
      if (updated) setChatState(updated);
      // The list re-reads these flags when we land back on it.
      if (action.kind === "archive" && action.archived) onBack();
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  };

  const runChatConfirm = async () => {
    const action = confirming;
    setConfirming(null);
    if (!action) return;
    try {
      if (action.kind === "clear") {
        await api.clearConversation(conversationId);
        setMessages([]);
      } else if (action.kind === "delete") {
        await api.deleteConversation(conversationId);
        onBack();
      }
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  };

  const presenceLine = isGroup
    ? [
        `${group?.memberCount ?? conversation.group?.memberCount ?? 0} members`,
        group && group.myRole === "ADMIN" && group.joinRequests.length > 0
          ? `${group.joinRequests.length} join request${group.joinRequests.length === 1 ? "" : "s"}`
          : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : peerOnline
      ? "online"
      : lastSeenLabel(peerLastSeen) || peer?.phone || "";
  const ephemeralBadge =
    !isGroup && chatState.ephemeralSeconds > 0
      ? `⏳ Disappearing · ${shortEphemeral(chatState.ephemeralSeconds)}`
      : null;
  const subtitle =
    Date.now() < typingUntil
      ? "typing…"
      : ephemeralBadge
        ? `${presenceLine} · ${ephemeralBadge}`
        : presenceLine;

  const memberNames = new Map((group?.members ?? []).map((m) => [m.userId, m.displayName ?? m.phone ?? "Convo user"]));
  const callBusy = callState.phase === "outgoing" || callState.phase === "incoming" || callState.phase === "connecting" || callState.phase === "active";
  const myRole = group?.myRole ?? conversation.group?.myRole ?? null;
  const adminsOnly =
    (group?.settings.announceOnly ?? conversation.group?.announceOnly) === true ||
    (group?.settings.whoCanSend ?? conversation.group?.whoCanSend) === "ADMINS";
  const canPost = !isGroup || !adminsOnly || myRole === "ADMIN";
  const topPin = pins[0] ?? null;

  // @mention typeahead (5E): candidates come from the roster, never the client.
  const mentionQuery =
    isGroup && canPost && !editing && !mentionDismissed ? mentionTokenAt(draft) : null;
  const mentionCandidates =
    mentionQuery === null
      ? []
      : (group?.members ?? [])
          .filter((m) => m.userId !== account.id)
          .filter((m) => memberLabel(m).toLowerCase().startsWith(mentionQuery.toLowerCase()))
          .slice(0, 5);

  /** Accept a typeahead row: the bare `@token` becomes `@Name `. */
  const applyMention = (member: GroupMember) => {
    setDraft((prev) => prev.replace(/@[^\s@]*$/, `@${memberLabel(member)} `));
    setMentionDismissed(false);
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: palette.bg }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={spacing.xl}
    >
      {/* Header */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: spacing.md,
          paddingHorizontal: spacing.lg,
          paddingTop: spacing.xl,
          paddingBottom: spacing.md,
          backgroundColor: palette.surface,
          borderBottomWidth: 1,
          borderBottomColor: palette.border,
        }}
      >
        <Pressable onPress={onBack} hitSlop={8}>
          <Text style={{ fontSize: 22, color: palette.textMuted }}>‹</Text>
        </Pressable>
        <Avatar initial={avatarInitial(name)} online={peerOnline} size={38} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: "800", color: palette.text }}>{name}</Text>
          <Text numberOfLines={1} style={{ fontSize: 12, color: palette.textFaint }}>{subtitle}</Text>
        </View>
        {isGroup && (
          <Pressable
            onPress={onOpenGroup}
            hitSlop={8}
            style={{ width: 34, height: 34, borderRadius: radius.pill, alignItems: "center", justifyContent: "center", backgroundColor: palette.raised }}
          >
            <Text style={{ fontSize: 16, color: palette.textMuted }}>ⓘ</Text>
          </Pressable>
        )}
        {!isGroup && peer && (
          <>
            <Pressable
              onPress={() => void startCall(conversationId, "VOICE")}
              hitSlop={8}
              disabled={callBusy}
              style={({ pressed }) => ({ width: 34, height: 34, borderRadius: radius.pill, alignItems: "center", justifyContent: "center", backgroundColor: palette.raised, opacity: callBusy || pressed ? 0.5 : 1 })}
            >
              <Text style={{ fontSize: 15, color: palette.textMuted }}>📞</Text>
            </Pressable>
            <Pressable
              onPress={() => void startCall(conversationId, "VIDEO")}
              hitSlop={8}
              disabled={callBusy}
              style={({ pressed }) => ({ width: 34, height: 34, borderRadius: radius.pill, alignItems: "center", justifyContent: "center", backgroundColor: palette.raised, opacity: callBusy || pressed ? 0.5 : 1 })}
            >
              <Text style={{ fontSize: 15, color: palette.textMuted }}>📹</Text>
            </Pressable>
          </>
        )}
        <Pressable
          onPress={() => setGalleryMenu(true)}
          hitSlop={8}
          style={{ width: 34, height: 34, borderRadius: radius.pill, alignItems: "center", justifyContent: "center", backgroundColor: palette.raised }}
        >
          <Text style={{ fontSize: 15, color: palette.textMuted }}>🖼️</Text>
        </Pressable>
        <Pressable
          onPress={() => setSearchTerm(searchTerm === null ? "" : null)}
          hitSlop={8}
          style={{ width: 34, height: 34, borderRadius: radius.pill, alignItems: "center", justifyContent: "center", backgroundColor: searchTerm === null ? palette.raised : colors.iris100 }}
        >
          <Text style={{ fontSize: 15, color: searchTerm === null ? palette.textMuted : colors.iris700 }}>🔍</Text>
        </Pressable>
        <Pressable
          onPress={() => setChatMenu(true)}
          hitSlop={8}
          style={{ width: 34, height: 34, borderRadius: radius.pill, alignItems: "center", justifyContent: "center", backgroundColor: palette.raised }}
        >
          <Text style={{ fontSize: 16, fontWeight: "900", color: palette.textMuted }}>⋮</Text>
        </Pressable>
      </View>

      {topPin && (
        <Pressable
          onPress={() => jumpToMessage(topPin.message.id)}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: spacing.sm,
            paddingHorizontal: spacing.lg,
            paddingVertical: spacing.sm,
            backgroundColor: colors.iris100,
            borderBottomWidth: 1,
            borderBottomColor: palette.border,
          }}
        >
          <Text style={{ fontSize: 13, color: colors.iris700 }}>📌</Text>
          <Text numberOfLines={1} style={{ flex: 1, fontSize: 12, color: colors.iris700 }}>
            <Text style={{ fontWeight: "800" }}>{topPin.pin.displayName ?? "A member"} </Text>
            pinned “{messageLabel(topPin.message)}”
          </Text>
          {pins.length > 1 && (
            <Pressable
              onPress={() => setPinsSheet(true)}
              hitSlop={8}
              style={{ borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 3, backgroundColor: colors.iris600 }}
            >
              <Text style={{ fontSize: 11, fontWeight: "800", color: colors.white }}>All {pins.length}</Text>
            </Pressable>
          )}
          <Pressable
            onPress={() => void togglePin(topPin.message)}
            hitSlop={8}
            style={{ borderRadius: radius.pill, paddingHorizontal: 9, paddingVertical: 3, backgroundColor: palette.surface }}
          >
            <Text style={{ fontSize: 12, fontWeight: "800", color: palette.textMuted }}>Unpin</Text>
          </Pressable>
        </Pressable>
      )}

      {searchTerm !== null && (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: spacing.sm,
            paddingHorizontal: spacing.lg,
            paddingVertical: spacing.sm,
            backgroundColor: palette.surface,
            borderBottomWidth: 1,
            borderBottomColor: palette.border,
          }}
        >
          <TextInput
            value={searchTerm}
            onChangeText={setSearchTerm}
            placeholder="Search in this chat"
            placeholderTextColor={palette.textFaint}
            autoFocus
            style={{
              flex: 1,
              backgroundColor: palette.bg,
              borderColor: palette.border,
              borderWidth: 1,
              borderRadius: radius.field,
              paddingHorizontal: spacing.md,
              paddingVertical: 9,
              fontSize: 14,
              color: palette.text,
            }}
          />
          <Text style={{ fontSize: 12, color: palette.textFaint }}>
            {messages.length} match{messages.length === 1 ? "" : "es"}
          </Text>
          <Pressable
            onPress={() => {
              setSearchTerm(null);
              if (!loading) void loadTimeline().then((rows) => setMessages(rows));
            }}
            hitSlop={8}
          >
            <Text style={{ fontSize: 18, color: palette.textFaint }}>×</Text>
          </Pressable>
        </View>
      )}

      {notice && (
        <Pressable
          onPress={() => setNotice(null)}
          style={{
            paddingHorizontal: spacing.lg,
            paddingVertical: spacing.sm,
            backgroundColor: colors.amberBg,
          }}
        >
          <Text style={{ fontSize: 12, fontWeight: "700", color: colors.amberText }}>{notice}</Text>
        </Pressable>
      )}

      {/* Messages */}
      {loading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator color={colors.iris600} />
        </View>
      ) : loadError ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.lg }}>
          <Text style={{ color: colors.danger, textAlign: "center" }}>{loadError}</Text>
        </View>
      ) : (
        <ScrollView
          ref={scrollRef}
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: spacing.md, gap: spacing.sm }}
        >
          {messages.map((msg) =>
            msg.type === "SYSTEM" ? (
              <View key={msg.id} style={{ alignItems: "center", marginVertical: 2 }}>
                <View style={{ borderRadius: radius.pill, backgroundColor: palette.raised, paddingHorizontal: 12, paddingVertical: 5 }}>
                  <Text style={{ fontSize: 12, color: palette.textMuted, textAlign: "center" }}>{msg.body}</Text>
                </View>
              </View>
            ) : (
              <Bubble
                key={msg.id}
                message={msg}
                mine={msg.senderId === account.id}
                senderLabel={isGroup && msg.senderId !== account.id ? memberNames.get(msg.senderId ?? "") ?? null : null}
                quotedText={replyQuoteLabel(msg, messages.find((m) => m.id === msg.replyToId) ?? null)}
                mentionNames={mentionNamesOf(msg, memberNames)}
                selecting={selectIds !== null}
                selected={selectIds?.includes(msg.id) ?? false}
                onToggleSelect={() => toggleSelect(msg.id)}
                registerRef={(node) => {
                  if (node) bubbleRefs.current.set(msg.id, node);
                  else bubbleRefs.current.delete(msg.id);
                }}
                palette={palette}
                allowAuto={allowAuto}
                onLongPress={() => setMenuFor(msg)}
                onReact={(emoji) => void toggleReaction(msg, emoji)}
                onViewOnce={() => setViewOnceFor(msg)}
              />
            )
          )}
          {pending.map((p) => (
            <View key={p.clientMessageId} style={{ flexDirection: "row", justifyContent: "flex-end" }}>
              <View
                style={{
                  maxWidth: "76%",
                  borderRadius: radius.card,
                  borderBottomRightRadius: 4,
                  backgroundColor: colors.iris100,
                  paddingHorizontal: 14,
                  paddingVertical: 9,
                }}
              >
                <Text style={{ fontSize: 15, color: colors.iris700 }}>{pendingLabel(p.body, p.attachmentCount, p.label)}</Text>
                <Text style={{ fontSize: 10, color: colors.iris700, textAlign: "right", marginTop: 2 }}>
                  {p.status === "failed"
                    ? p.attachmentCount > 0
                      ? "Not sent — press Send to retry"
                      : "Not sent — will retry"
                    : "Sending…"}
                </Text>
              </View>
            </View>
          ))}
          {Date.now() < typingUntil && (
            <View style={{ flexDirection: "row", justifyContent: "flex-start" }}>
              <View style={{ borderRadius: radius.card, backgroundColor: palette.surface, paddingHorizontal: 14, paddingVertical: 9 }}>
                <Text style={{ fontSize: 13, color: palette.textFaint }}>typing…</Text>
              </View>
            </View>
          )}
        </ScrollView>
      )}

      {/* Composer */}
      <View
        style={{
          padding: spacing.md,
          backgroundColor: palette.surface,
          borderTopWidth: 1,
          borderTopColor: palette.border,
        }}
      >
        {selectIds && (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              borderRadius: radius.field,
              backgroundColor: colors.iris100,
              paddingHorizontal: 12,
              paddingVertical: 8,
              marginBottom: spacing.sm,
            }}
          >
            <Text style={{ flex: 1, fontSize: 12, fontWeight: "800", color: colors.iris700 }}>
              {selectIds.length} selected
            </Text>
            <Pressable
              onPress={() => {
                openForward(selectIds);
                setSelectIds(null);
              }}
              style={{ borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 5, backgroundColor: colors.iris600 }}
            >
              <Text style={{ fontSize: 12, fontWeight: "800", color: colors.white }}>Forward</Text>
            </Pressable>
            <Pressable onPress={() => setSelectIds(null)} hitSlop={8} style={{ marginLeft: spacing.md }}>
              <Text style={{ fontSize: 16, color: colors.iris700 }}>×</Text>
            </Pressable>
          </View>
        )}
        {(replyTo || editing) && (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              borderRadius: radius.field,
              backgroundColor: palette.raised,
              paddingHorizontal: 12,
              paddingVertical: 8,
              marginBottom: spacing.sm,
            }}
          >
            <Text numberOfLines={1} style={{ flex: 1, fontSize: 12, color: palette.textMuted }}>
              {editing ? "Editing message" : `Replying to ${replyTo ? messageLabel(replyTo) : ""}`}
            </Text>
            <Pressable
              onPress={() => {
                setReplyTo(null);
                setEditing(null);
                setDraft("");
              }}
              hitSlop={8}
            >
              <Text style={{ fontSize: 16, color: palette.textFaint }}>×</Text>
            </Pressable>
          </View>
        )}
        {!canPost && (
          <Text style={{ fontSize: 12, color: palette.textFaint, textAlign: "center", marginBottom: spacing.sm }}>
            Only admins can send messages in this group
          </Text>
        )}
        <AttachmentTray files={staged} busy={false} onRemove={(key) => setStaged((prev) => prev.filter((f) => f.storageKey !== key))} />
        {mediaError && (
          <Text style={{ fontSize: 12, color: colors.danger, marginBottom: spacing.xs }}>{mediaError}</Text>
        )}
        {staged.length > 0 && (
          <View style={{ flexDirection: "row", gap: spacing.sm, marginBottom: spacing.sm }}>
            <Pressable
              onPress={() => setViewOnceDraft((on) => !on)}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                borderRadius: radius.pill,
                paddingHorizontal: 12,
                paddingVertical: 6,
                backgroundColor: viewOnceDraft ? colors.iris100 : palette.raised,
              }}
            >
              <Text style={{ fontSize: 12, fontWeight: "800", color: viewOnceDraft ? colors.iris700 : palette.textMuted }}>
                {viewOnceDraft ? "🔒 View once: on" : "🔒 View once"}
              </Text>
            </Pressable>
            {staged.every((f) => f.kind === "IMAGE") && (
              <Pressable
                onPress={() => setStickerDraft((on) => !on)}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 6,
                  borderRadius: radius.pill,
                  paddingHorizontal: 12,
                  paddingVertical: 6,
                  backgroundColor: stickerDraft ? colors.iris100 : palette.raised,
                }}
              >
                <Text style={{ fontSize: 12, fontWeight: "800", color: stickerDraft ? colors.iris700 : palette.textMuted }}>
                  {stickerDraft ? "🌟 Sticker: on" : "🌟 Sticker"}
                </Text>
              </Pressable>
            )}
          </View>
        )}
        {mentionCandidates.length > 0 && (
          <View
            style={{
              borderRadius: radius.field,
              borderWidth: 1,
              borderColor: palette.border,
              backgroundColor: palette.surface,
              marginBottom: spacing.sm,
              overflow: "hidden",
            }}
          >
            {mentionCandidates.map((member) => (
              <Pressable
                key={member.userId}
                onPress={() => applyMention(member)}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: spacing.sm,
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                  borderBottomWidth: 1,
                  borderBottomColor: palette.border,
                }}
              >
                <Text style={{ fontSize: 14, fontWeight: "900", color: colors.iris600 }}>@</Text>
                <Text numberOfLines={1} style={{ flex: 1, fontSize: 14, color: palette.text }}>
                  {memberLabel(member)}
                </Text>
                {member.role === "ADMIN" && (
                  <Text style={{ fontSize: 11, color: palette.textFaint }}>admin</Text>
                )}
              </Pressable>
            ))}
          </View>
        )}
        <View style={{ flexDirection: "row", alignItems: "flex-end", gap: spacing.sm }}>
          <Pressable
            onPress={() => {
              setMediaError(null);
              setAttachSheet(true);
            }}
            disabled={!canPost || staged.length >= MAX_ATTACHMENTS}
            style={{
              width: 42,
              height: 42,
              borderRadius: radius.pill,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: palette.raised,
              opacity: !canPost || staged.length >= MAX_ATTACHMENTS ? 0.5 : 1,
            }}
          >
            <Text style={{ fontSize: 19, color: palette.textMuted }}>+</Text>
          </Pressable>
          {([
            { key: "gif", glyph: "GIF", open: () => setGifSheet(true), active: gifSheet, wide: true },
            { key: "pin", glyph: "📍", open: () => setLocationSheet(true), active: locationSheet, wide: false },
            { key: "card", glyph: "👤", open: () => setContactSheet(true), active: contactSheet, wide: false },
          ] as const).map((btn) => (
            <Pressable
              key={btn.key}
              onPress={btn.open}
              disabled={!canPost}
              style={{
                minWidth: 42,
                height: 42,
                paddingHorizontal: btn.wide ? 8 : 0,
                borderRadius: radius.pill,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: btn.active ? colors.iris100 : palette.raised,
                opacity: !canPost ? 0.5 : 1,
              }}
            >
              <Text
                style={{
                  fontSize: btn.wide ? 11 : 17,
                  fontWeight: "900",
                  color: btn.active ? colors.iris700 : palette.textMuted,
                }}
              >
                {btn.glyph}
              </Text>
            </Pressable>
          ))}
          <TextInput
            value={draft}
            onChangeText={onDraftChange}
            editable={canPost}
            placeholder={editing ? "Edit your message" : canPost ? "Type a message" : "Admins only"}
            placeholderTextColor={palette.textFaint}
            multiline
            style={{
              flex: 1,
              maxHeight: 100,
              minHeight: 42,
              backgroundColor: palette.raised,
              borderColor: palette.border,
              borderWidth: 1,
              borderRadius: radius.field,
              paddingHorizontal: 14,
              paddingVertical: 10,
              fontSize: 15,
              color: palette.text,
            }}
          />
          <Pressable
            onPress={() => void submitComposer()}
            disabled={!canPost || (draft.trim().length === 0 && staged.length === 0)}
            style={({ pressed }) => ({
              backgroundColor: colors.iris600,
              borderRadius: radius.pill,
              paddingHorizontal: 18,
              paddingVertical: 12,
              opacity: !canPost || (draft.trim().length === 0 && staged.length === 0) || pressed ? 0.5 : 1,
            })}
          >
            <Text style={{ color: colors.white, fontWeight: "800", fontSize: 14 }}>
              {editing ? "Save" : "Send"}
            </Text>
          </Pressable>
        </View>
      </View>

      {/* Long-press action sheet */}
      <Modal visible={menuFor !== null} transparent animationType="fade" onRequestClose={() => setMenuFor(null)}>
        <Pressable style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.4)" }} onPress={() => setMenuFor(null)}>
          <View style={{ flex: 1, justifyContent: "flex-end" }}>
            <Pressable
              onPress={(e) => e.stopPropagation()}
              style={{
                backgroundColor: palette.surface,
                borderTopLeftRadius: radius.card,
                borderTopRightRadius: radius.card,
                padding: spacing.lg,
                gap: spacing.md,
              }}
            >
              <View style={{ flexDirection: "row", justifyContent: "space-between", flexWrap: "wrap", gap: spacing.sm }}>
                {QUICK_REACTIONS.map((emoji) => (
                  <Pressable
                    key={emoji}
                    onPress={() => menuFor && void toggleReaction(menuFor, emoji)}
                    style={{ padding: spacing.xs }}
                  >
                    <Text style={{ fontSize: 26 }}>{emoji}</Text>
                  </Pressable>
                ))}
              </View>
              <SheetButton
                label="Reply"
                onPress={() => {
                  if (menuFor) setReplyTo(menuFor);
                  setEditing(null);
                  setMenuFor(null);
                }}
                palette={palette}
              />
              <SheetButton
                label={menuFor?.starredByMe ? "Unstar" : "Star"}
                onPress={() => menuFor && void toggleStar(menuFor)}
                palette={palette}
              />
              {menuFor && !menuFor.viewOnce ? (
                <SheetButton label="Forward" onPress={() => openForward([menuFor.id])} palette={palette} />
              ) : null}
              <SheetButton
                label={menuFor?.pinned ? "Unpin for everyone" : "Pin in chat"}
                onPress={() => menuFor && void togglePin(menuFor)}
                palette={palette}
              />
              {menuFor && !menuFor.viewOnce ? (
                <SheetButton
                  label="Select messages…"
                  onPress={() => {
                    setSelectIds([menuFor.id]);
                    setMenuFor(null);
                  }}
                  palette={palette}
                />
              ) : null}
              {menuFor?.senderId === account.id ? (
                <>
                  <SheetButton
                    label="Edit"
                    onPress={() => {
                      if (menuFor) {
                        setEditing(menuFor);
                        setDraft(menuFor.body ?? "");
                        setReplyTo(null);
                      }
                      setMenuFor(null);
                    }}
                    palette={palette}
                  />
                  <SheetButton
                    label="Delete"
                    danger
                    onPress={() => {
                      setConfirmDeleteFor(menuFor);
                      setMenuFor(null);
                    }}
                    palette={palette}
                  />
                </>
              ) : (
                <SheetButton
                  label="Report message"
                  onPress={() => {
                    if (menuFor) {
                      setReportFor({
                        type: "MESSAGE",
                        id: menuFor.id,
                        label: menuFor.body ? `"${menuFor.body.slice(0, 24)}…"` : "this message",
                      });
                    }
                    setMenuFor(null);
                  }}
                  palette={palette}
                />
              )}
              <SheetButton label="Cancel" onPress={() => setMenuFor(null)} palette={palette} muted />
            </Pressable>
          </View>
        </Pressable>
      </Modal>

      {/* Delete scope sheet */}
      <Modal visible={confirmDeleteFor !== null} transparent animationType="fade" onRequestClose={() => setConfirmDeleteFor(null)}>
        <Pressable style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.4)" }} onPress={() => setConfirmDeleteFor(null)}>
          <View style={{ flex: 1, justifyContent: "flex-end" }}>
            <Pressable
              onPress={(e) => e.stopPropagation()}
              style={{ backgroundColor: palette.surface, borderTopLeftRadius: radius.card, borderTopRightRadius: radius.card, padding: spacing.lg, gap: spacing.sm }}
            >
              <Text style={{ fontSize: 15, fontWeight: "800", color: palette.text }}>Delete message?</Text>
              <SheetButton label="Delete for me" onPress={() => void runDelete("MINE")} palette={palette} />
              {confirmDeleteFor?.senderId === account.id && (
                <SheetButton label="Delete for everyone" danger onPress={() => void runDelete("EVERYONE")} palette={palette} />
              )}
              <SheetButton label="Cancel" onPress={() => setConfirmDeleteFor(null)} palette={palette} muted />
            </Pressable>
          </View>
        </Pressable>
      </Modal>
      <AttachSheet
        visible={attachSheet}
        onClose={() => setAttachSheet(false)}
        onPicked={stageFiles}
        onError={setMediaError}
      />
      <GifSheet
        visible={gifSheet}
        onClose={() => setGifSheet(false)}
        onPicked={stageFiles}
        onError={setMediaError}
      />
      <LocationSheet
        visible={locationSheet}
        onClose={() => setLocationSheet(false)}
        onSend={(location) => void sendShare({ location })}
      />
      <ContactShareSheet
        visible={contactSheet}
        onClose={() => setContactSheet(false)}
        onSend={(contactCard) => void sendShare({ contactCard })}
      />
      <MediaGallerySheet
        conversationId={conversationId}
        visible={galleryMenu}
        onClose={() => setGalleryMenu(false)}
        onViewOnce={(message) => {
          setGalleryMenu(false);
          setViewOnceFor(message);
        }}
      />
      {viewOnceFor && (
        <ViewOnceSheet
          message={viewOnceFor}
          onClose={(opened) => {
            if (opened) setMessages((prev) => prev.map((m) => (m.id === viewOnceFor.id ? { ...m, viewOnceOpened: true } : m)));
            setViewOnceFor(null);
          }}
        />
      )}
      {forwardFor && (
        <ForwardSheet
          messageIds={forwardFor}
          conversations={forwardChats}
          visible
          onClose={() => setForwardFor(null)}
          onSent={() => setForwardFor(null)}
        />
      )}
      <ChatActionSheet
        conversation={chatState}
        visible={chatMenu}
        onClose={() => setChatMenu(false)}
        onAction={(action) => void runChatAction(action)}
      />
      <ConfirmSheet
        visible={confirming !== null}
        title={confirming?.kind === "clear" ? "Clear this chat?" : "Delete this chat?"}
        body={
          confirming?.kind === "clear"
            ? "The messages disappear from your view. Anything not yet cleared by the other side still exists there."
            : "This chat is removed from your list for good. The other person keeps the full history and your chat reappears when they message you again."
        }
        confirmLabel={confirming?.kind === "clear" ? "Clear chat" : "Delete chat"}
        onClose={() => setConfirming(null)}
        onConfirm={() => void runChatConfirm()}
      />
      <Modal visible={pinsSheet} transparent animationType="fade" onRequestClose={() => setPinsSheet(false)}>
        <Pressable style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.4)" }} onPress={() => setPinsSheet(false)}>
          <View
            style={{
              flex: 1,
              justifyContent: "flex-end",
            }}
          >
            <Pressable
              onPress={(e) => e.stopPropagation()}
              style={{
                backgroundColor: palette.surface,
                borderTopLeftRadius: radius.card,
                borderTopRightRadius: radius.card,
                padding: spacing.lg,
                gap: spacing.sm,
                maxHeight: "70%",
              }}
            >
              <Text style={{ fontSize: 15, fontWeight: "800", color: palette.text }}>
                Pinned messages ({pins.length})
              </Text>
              <ScrollView style={{ maxHeight: 360 }}>
                <View style={{ gap: spacing.sm }}>
                  {pins.map(({ message, pin }) => (
                    <View
                      key={message.id}
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        gap: spacing.sm,
                        borderRadius: radius.field,
                        borderWidth: 1,
                        borderColor: palette.border,
                        paddingHorizontal: 12,
                        paddingVertical: 9,
                      }}
                    >
                      <Pressable
                        style={{ flex: 1, minWidth: 0 }}
                        onPress={() => {
                          setPinsSheet(false);
                          jumpToMessage(message.id);
                        }}
                      >
                        <Text numberOfLines={1} style={{ fontSize: 14, color: palette.text }}>
                          {messageLabel(message)}
                        </Text>
                        <Text style={{ fontSize: 11, color: palette.textFaint, marginTop: 2 }}>
                          {pin.displayName ?? "A member"} · {relativeTime(pin.pinnedAt)} ago
                        </Text>
                      </Pressable>
                      <Pressable
                        onPress={() => void togglePin(message)}
                        hitSlop={8}
                        style={{ borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 5, backgroundColor: palette.raised }}
                      >
                        <Text style={{ fontSize: 11, fontWeight: "800", color: palette.textMuted }}>Unpin</Text>
                      </Pressable>
                    </View>
                  ))}
                </View>
              </ScrollView>
              <SheetButton label="Close" onPress={() => setPinsSheet(false)} palette={palette} muted />
            </Pressable>
          </View>
        </Pressable>
      </Modal>
      {reportFor && (
        <ReportSheet
          visible
          targetType={reportFor.type}
          targetId={reportFor.id}
          targetLabel={reportFor.label}
          onClose={() => setReportFor(null)}
          onDone={() => setReportFor(null)}
        />
      )}
    </KeyboardAvoidingView>
  );
}

function Bubble({
  message,
  mine,
  senderLabel,
  quotedText,
  mentionNames,
  selecting,
  selected,
  onToggleSelect,
  registerRef,
  palette,
  allowAuto,
  onLongPress,
  onReact,
  onViewOnce,
}: {
  message: Message;
  mine: boolean;
  senderLabel: string | null;
  quotedText: string | null;
  /** Roster members this message @-mentions (5E). */
  mentionNames: string[];
  selecting: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  registerRef: (node: View | null) => void;
  palette: ReturnType<typeof usePalette>;
  allowAuto: boolean;
  onLongPress: () => void;
  onReact: (emoji: string) => void;
  onViewOnce: () => void;
}) {
  if (message.deletedAt) {
    return (
      <View style={{ flexDirection: "row", justifyContent: mine ? "flex-end" : "flex-start" }}>
        <View style={{ borderRadius: radius.card, backgroundColor: palette.raised, paddingHorizontal: 14, paddingVertical: 9 }}>
          <Text style={{ fontSize: 14, fontStyle: "italic", color: palette.textFaint }}>Message deleted</Text>
        </View>
      </View>
    );
  }
  const tick = mine ? tickGlyph(message.deliveryStatus) : null;
  const sticker = message.type === "STICKER";
  return (
    <View
      ref={registerRef}
      style={{ flexDirection: "row", alignItems: "flex-end", gap: spacing.sm, justifyContent: mine ? "flex-end" : "flex-start" }}
    >
      {selecting && (
        <Pressable
          onPress={onToggleSelect}
          style={{
            width: 22,
            height: 22,
            borderRadius: radius.pill,
            alignItems: "center",
            justifyContent: "center",
            borderWidth: 2,
            borderColor: selected ? colors.iris600 : palette.border,
            backgroundColor: selected ? colors.iris600 : palette.surface,
            marginBottom: 8,
          }}
        >
          {selected ? <Text style={{ fontSize: 12, color: colors.white, fontWeight: "900" }}>✓</Text> : null}
        </Pressable>
      )}
      <Pressable
        onLongPress={onLongPress}
        onPress={selecting ? onToggleSelect : undefined}
        delayLongPress={280}
        style={{ maxWidth: "76%" }}
      >
        <View
          style={{
            borderRadius: radius.card,
            borderBottomRightRadius: mine ? 4 : radius.card,
            borderBottomLeftRadius: mine ? radius.card : 4,
            backgroundColor: sticker ? "transparent" : mine ? colors.iris600 : palette.surface,
            paddingHorizontal: sticker ? 0 : 14,
            paddingVertical: sticker ? 0 : 9,
            borderWidth: selected ? 2 : 0,
            borderColor: colors.iris500,
          }}
        >
          {senderLabel ? (
            <Text style={{ fontSize: 12, fontWeight: "800", color: colors.iris600, marginBottom: 2 }}>{senderLabel}</Text>
          ) : null}
          {message.forwardedFrom ? (
            <Text style={{ fontSize: 11, color: mine ? "rgba(255,255,255,0.75)" : palette.textFaint, marginBottom: 2 }}>
              ↪ Forwarded from {message.forwardedFrom.displayName ?? "a contact"}
            </Text>
          ) : null}
          {quotedText ? (
            <View
              style={{
                borderLeftWidth: 3,
                borderLeftColor: mine ? "rgba(255,255,255,0.6)" : palette.border,
                paddingLeft: 8,
                marginBottom: 4,
              }}
            >
              <Text numberOfLines={2} style={{ fontSize: 12, color: mine ? "rgba(255,255,255,0.85)" : palette.textMuted }}>
                {quotedText || "Message"}
              </Text>
            </View>
          ) : null}
          {message.location ? <LocationCard location={message.location} /> : null}
          {message.contactCard ? <SharedContactCard card={message.contactCard} /> : null}
          <MessageMedia message={message} onViewOnce={onViewOnce} allowAuto={allowAuto} />
          {message.body ? (
            <Text style={{ fontSize: 15, color: mine ? colors.white : palette.text }}>
              {splitMentions(message.body, mentionNames).map((chunk, index) =>
                chunk.mentioned ? (
                  <Text
                    key={index}
                    style={{
                      fontWeight: "800",
                      color: mine ? colors.white : colors.iris700,
                      backgroundColor: mine ? "rgba(255,255,255,0.25)" : colors.iris100,
                    }}
                  >
                    {chunk.text}
                  </Text>
                ) : (
                  <Text key={index}>{chunk.text}</Text>
                ),
              )}
            </Text>
          ) : null}
          {message.linkPreview ? <LinkPreviewCard preview={message.linkPreview} /> : null}
          <Text
            style={{
              fontSize: 10,
              color: mine && !sticker ? "rgba(255,255,255,0.75)" : palette.textFaint,
              textAlign: "right",
              marginTop: 2,
            }}
          >
            {message.editedAt ? "edited " : ""}
            {message.starredByMe ? "★ " : ""}
            {message.viewOnce ? "🔒 " : ""}
            {message.pinned ? "📌 " : ""}
            {clockTime(message.createdAt)}
            {tick ? `  ${tick.glyph}` : ""}
          </Text>
        </View>
        {message.reactions.length > 0 && (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4, marginTop: 4, justifyContent: mine ? "flex-end" : "flex-start" }}>
            {message.reactions.map((r) => (
              <Pressable
                key={r.emoji}
                onPress={() => onReact(r.emoji)}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 3,
                  borderRadius: radius.pill,
                  paddingHorizontal: 8,
                  paddingVertical: 2,
                  borderWidth: 1,
                  borderColor: r.reactedByMe ? colors.iris500 : palette.border,
                  backgroundColor: r.reactedByMe ? colors.iris100 : palette.surface,
                }}
              >
                <Text style={{ fontSize: 13 }}>{r.emoji}</Text>
                <Text style={{ fontSize: 11, color: palette.textMuted }}>{r.count}</Text>
              </Pressable>
            ))}
          </View>
        )}
      </Pressable>
    </View>
  );
}

function tickGlyph(status: Message["deliveryStatus"]): { glyph: string } | null {
  if (status === "READ") return { glyph: "✓✓" };
  if (status === "DELIVERED") return { glyph: "✓✓" };
  if (status === "SENT") return { glyph: "✓" };
  return null;
}
