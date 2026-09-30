import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";
import type { ConversationSummary, ReportTargetType, WsServerEvent } from "@convo/shared";
import { api, ApiRequestError } from "../api";
import { useRealtimeEvents, useRealtimeStatus, sendRealtime } from "../realtime";
import { outboxSnapshot, outboxRemove } from "../outbox";
import { avatarInitial, errorMessage, peerName, previewText, relativeTime } from "../chatUtils";
import { Avatar, Button, TextField, usePalette } from "../components/ui";
import {
  ChatActionSheet,
  ConfirmSheet,
  ReportSheet,
  applyQuietAction,
  isMuted,
  type ChatAction,
} from "../components/ChatControls";
import { colors, radius, spacing } from "../theme";

export function ChatsScreen({
  onOpenChat,
  onOpenGroups,
  onOpenContacts,
  onOpenStarred,
  onOpenSearch,
  onOpenUser,
}: {
  onOpenChat: (conversation: ConversationSummary) => void;
  onOpenGroups: () => void;
  onOpenContacts: () => void;
  onOpenStarred: () => void;
  onOpenSearch: () => void;
  onOpenUser: (userId: string) => void;
}) {
  const palette = usePalette();
  const wsStatus = useRealtimeStatus();
  const [conversations, setConversations] = useState<ConversationSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [peerOnline, setPeerOnline] = useState<Record<string, boolean>>({});
  const [showNew, setShowNew] = useState(false);
  const [phone, setPhone] = useState("");
  const [newError, setNewError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [listMode, setListMode] = useState<"chats" | "archived">("chats");
  const [menuFor, setMenuFor] = useState<ConversationSummary | null>(null);
  const [confirming, setConfirming] = useState<{ action: ChatAction; conversation: ConversationSummary } | null>(null);
  const [reportFor, setReportFor] = useState<{ type: ReportTargetType; id: string; label: string } | null>(null);
  const [people, setPeople] = useState<{ phone: string; name: string }[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const list = listMode === "archived" ? await api.listArchived() : await api.listConversations();
      setConversations(list.conversations);
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }, [listMode]);

  useEffect(() => {
    void load();
  }, [load]);

  // Replay the offline outbox whenever the connection (re)establishes.
  useEffect(() => {
    if (wsStatus !== "open") return;
    const items = outboxSnapshot();
    if (items.length === 0) return;
    (async () => {
      for (const item of items) {
        try {
          await api.sendMessage(item.conversationId, {
            clientMessageId: item.clientMessageId,
            body: item.body,
          });
          outboxRemove(item.clientMessageId);
        } catch (err) {
          if (err instanceof ApiRequestError && err.status < 500 && err.code !== "RATE_LIMITED") {
            outboxRemove(item.clientMessageId);
          }
        }
      }
      await load();
    })();
  }, [wsStatus, load]);

  useRealtimeEvents(
    useCallback((event: WsServerEvent) => {
      if (event.type === "message.new") {
        const msg = event.message;
        setConversations((prev) => {
          if (!prev) return prev;
          const conv = prev.find((c) => c.id === msg.conversationId);
          if (!conv) {
            void load();
            return prev;
          }
          return [
            {
              ...conv,
              lastMessage: msg,
              lastMessageAt: msg.createdAt,
              unreadCount: conv.unreadCount + 1,
              unreadMentions: conv.unreadMentions + (msg.mentionedMe ? 1 : 0),
            },
            ...prev.filter((c) => c.id !== conv.id),
          ];
        });
      } else if (event.type === "message.read") {
        setConversations((prev) =>
          prev?.map((c) => (c.id === event.conversationId ? { ...c, lastReadAt: event.readAt } : c)) ?? prev,
        );
      } else if (
        event.type === "group.changed" ||
        event.type === "group.joined" ||
        event.type === "group.joinRequest.new"
      ) {
        // Membership or settings changed: re-pull so role/member count are current.
        void load();
      } else if (event.type === "presence") {
        setPeerOnline((prev) => ({ ...prev, [event.userId]: event.online }));
      }
    }, [load]),
  );

  // Watch presence for all visible peers.
  useEffect(() => {
    if (wsStatus !== "open" || !conversations) return;
    const ids = conversations
      .map((c) => c.peer?.userId)
      .filter((id): id is string => Boolean(id))
      .slice(0, 100);
    if (ids.length > 0) sendRealtime({ type: "watch", userIds: ids });
  }, [wsStatus, conversations]);

  const startChat = async (preset?: string) => {
    const value = (preset ?? phone).trim();
    if (!value) return;
    setStarting(true);
    setNewError(null);
    try {
      const conv = await api.startConversation(value);
      setShowNew(false);
      setPhone("");
      onOpenChat(conv);
    } catch (err) {
      setNewError(errorMessage(err));
    } finally {
      setStarting(false);
    }
  };

  // "Who can you message" suggestions: recents first, then saved contacts.
  useEffect(() => {
    if (!showNew) return;
    let cancelled = false;
    Promise.all([api.recentRecipients(), api.listContacts()])
      .then(([r, c]) => {
        if (cancelled) return;
        const seen = new Set<string>();
        const rows: { phone: string; name: string }[] = [];
        for (const person of [...r.recipients, ...c.contacts]) {
          if (!person.phone || seen.has(person.phone)) continue;
          seen.add(person.phone);
          rows.push({ phone: person.phone, name: person.displayName ?? person.phone });
        }
        setPeople(rows);
      })
      .catch(() => {
        if (!cancelled) setPeople([]);
      });
    return () => {
      cancelled = true;
    };
  }, [showNew]);

  /**
   * Chat controls. Quiet ones (pin/archive/mute) apply in place; clear and
   * delete route through the confirm sheet; info/report open their own sheets.
   */
  const runAction = async (conversation: ConversationSummary, action: ChatAction) => {
    setMenuFor(null);
    if (action.kind === "clear" || action.kind === "delete") {
      setConfirming({ action, conversation });
      return;
    }
    if (action.kind === "info") {
      if (conversation.peer) onOpenUser(conversation.peer.userId);
      return;
    }
    if (action.kind === "report") {
      const peerId = conversation.peer?.userId;
      setReportFor(
        peerId
          ? { type: "USER", id: peerId, label: peerName(conversation) }
          : { type: "CONVERSATION", id: conversation.id, label: peerName(conversation) },
      );
      return;
    }
    try {
      const updated = await applyQuietAction(conversation, action);
      if (!updated) return;
      if (action.kind === "archive") {
        // Either direction moves the chat out of the list currently on screen.
        setConversations((prev) => prev?.filter((c) => c.id !== updated.id) ?? prev);
      } else {
        setConversations((prev) => prev?.map((c) => (c.id === updated.id ? updated : c)) ?? prev);
      }
      setActionError(null);
    } catch (err) {
      setActionError(errorMessage(err));
    }
  };

  const runConfirm = async () => {
    const request = confirming;
    setConfirming(null);
    if (!request) return;
    try {
      if (request.action.kind === "clear") {
        const updated = await api.clearConversation(request.conversation.id);
        setConversations((prev) => prev?.map((c) => (c.id === updated.id ? updated : c)) ?? prev);
      } else if (request.action.kind === "delete") {
        await api.deleteConversation(request.conversation.id);
        setConversations((prev) => prev?.filter((c) => c.id !== request.conversation.id) ?? prev);
      }
    } catch (err) {
      setActionError(errorMessage(err));
    }
  };

  const term = phone.trim().toLowerCase();
  const suggestions = (
    term
      ? people.filter((p) => p.phone.toLowerCase().includes(term) || p.name.toLowerCase().includes(term))
      : people
  ).slice(0, 6);

  if (showNew) {
    return (
      <KeyboardAvoidingView
        style={{ flex: 1, padding: spacing.lg, gap: spacing.md }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <Text style={{ fontSize: 20, fontWeight: "800", color: palette.text }}>New chat</Text>
        <TextField
          label="Phone number"
          value={phone}
          onChangeText={setPhone}
          placeholder="+15551234567"
          keyboardType="phone-pad"
          error={newError}
          autoFocus
          palette={palette}
        />
        <Text style={{ fontSize: 13, color: palette.textMuted }}>
          Enter the full phone number in international format (e.g. +15551234567).
        </Text>
        {suggestions.length > 0 && (
          <View style={{ gap: spacing.xs }}>
            <Text style={{ fontSize: 11, fontWeight: "700", letterSpacing: 0.6, color: palette.textFaint, textTransform: "uppercase" }}>
              {phone.trim() ? "Matches" : "Recent and contacts"}
            </Text>
            {suggestions.map((person) => (
              <Pressable
                key={person.phone}
                onPress={() => void startChat(person.phone)}
                style={({ pressed }) => ({
                  flexDirection: "row",
                  alignItems: "center",
                  gap: spacing.md,
                  paddingVertical: 9,
                  paddingHorizontal: spacing.sm,
                  borderRadius: radius.field,
                  backgroundColor: pressed ? palette.raised : "transparent",
                })}
              >
                <Avatar initial={avatarInitial(person.name)} size={34} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text numberOfLines={1} style={{ fontSize: 14, fontWeight: "700", color: palette.text }}>
                    {person.name}
                  </Text>
                  <Text numberOfLines={1} style={{ fontSize: 12, color: palette.textFaint }}>
                    {person.phone}
                  </Text>
                </View>
              </Pressable>
            ))}
          </View>
        )}
        <View style={{ flexDirection: "row", gap: spacing.sm }}>
          <View style={{ flex: 1 }}>
            <Button label="Cancel" variant="secondary" onPress={() => { setShowNew(false); setNewError(null); }} />
          </View>
          <View style={{ flex: 1 }}>
            <Button label="Start" onPress={() => void startChat()} loading={starting} disabled={phone.trim().length === 0} />
          </View>
        </View>
      </KeyboardAvoidingView>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: spacing.lg, paddingBottom: spacing.sm }}>
        <Text style={{ fontSize: 12, fontWeight: "700", letterSpacing: 0.6, color: palette.textFaint, textTransform: "uppercase" }}>
          {listMode === "archived" ? "Archived" : "Conversations"}
          {wsStatus !== "open" && <Text style={{ color: colors.amberText, fontWeight: "500", textTransform: "none" }}>  ·  reconnecting…</Text>}
        </Text>
        <View style={{ flexDirection: "row", gap: spacing.sm }}>
          <Pressable onPress={onOpenSearch}>
            <View style={{ backgroundColor: palette.surface, borderColor: palette.border, borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 7 }}>
              <Text style={{ color: palette.textMuted, fontWeight: "700", fontSize: 13 }}>🔍</Text>
            </View>
          </Pressable>
          <Pressable onPress={onOpenContacts}>
            <View style={{ backgroundColor: palette.surface, borderColor: palette.border, borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 7 }}>
              <Text style={{ color: palette.textMuted, fontWeight: "700", fontSize: 12 }}>Contacts</Text>
            </View>
          </Pressable>
          <Pressable onPress={onOpenStarred}>
            <View style={{ backgroundColor: palette.surface, borderColor: palette.border, borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 7 }}>
              <Text style={{ color: palette.textMuted, fontWeight: "700", fontSize: 12 }}>★</Text>
            </View>
          </Pressable>
          <Pressable onPress={onOpenGroups}>
            <View style={{ backgroundColor: palette.surface, borderColor: colors.iris600, borderWidth: 1.5, borderRadius: radius.pill, paddingHorizontal: 14, paddingVertical: 7 }}>
              <Text style={{ color: colors.iris600, fontWeight: "700", fontSize: 13 }}>Group</Text>
            </View>
          </Pressable>
          <Pressable onPress={() => setShowNew(true)}>
            <View style={{ backgroundColor: colors.iris600, borderRadius: radius.pill, paddingHorizontal: 14, paddingVertical: 7 }}>
              <Text style={{ color: colors.white, fontWeight: "700", fontSize: 13 }}>New</Text>
            </View>
          </Pressable>
        </View>
      </View>

      <View style={{ flexDirection: "row", gap: spacing.sm, paddingHorizontal: spacing.lg, paddingBottom: spacing.sm }}>
        <Chip
          palette={palette}
          label={listMode === "archived" ? "Back to chats" : "Archived chats"}
          onPress={() => setListMode(listMode === "archived" ? "chats" : "archived")}
        />
      </View>

      {actionError && (
        <Text style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.sm, fontSize: 13, color: colors.danger }}>
          {actionError}
        </Text>
      )}

      {loadError && !conversations ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.lg }}>
          <Text style={{ color: colors.danger, textAlign: "center" }}>{loadError}</Text>
          <View style={{ marginTop: spacing.md, minWidth: 120 }}>
            <Button label="Retry" variant="secondary" onPress={() => void load()} />
          </View>
        </View>
      ) : conversations === null ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator color={colors.iris600} />
        </View>
      ) : (
        <FlatList
          data={conversations}
          keyExtractor={(c) => c.id}
          ListEmptyComponent={
            <View style={{ alignItems: "center", justifyContent: "center", paddingVertical: 60, gap: spacing.sm }}>
              <Text style={{ fontSize: 16, fontWeight: "700", color: palette.text }}>
                {listMode === "archived" ? "No archived chats" : "No conversations yet"}
              </Text>
              <Text style={{ fontSize: 13, color: palette.textMuted, textAlign: "center", paddingHorizontal: 40 }}>
                {listMode === "archived"
                  ? "Long-press a chat and choose Archive to hide it here."
                  : "Start a chat with any phone number on Convo."}
              </Text>
            </View>
          }
          renderItem={({ item }) => (
            <ConversationRow
              conversation={item}
              online={item.peer ? peerOnline[item.peer.userId] === true : false}
              onPress={() => onOpenChat(item)}
              onLongPress={() => setMenuFor(item)}
            />
          )}
          ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: palette.border, marginLeft: 76 }} />}
        />
      )}

      <ChatActionSheet
        conversation={menuFor}
        visible={menuFor !== null}
        onClose={() => setMenuFor(null)}
        onAction={(action) => menuFor && void runAction(menuFor, action)}
      />
      <ConfirmSheet
        visible={confirming !== null}
        title={confirming?.action.kind === "clear" ? "Clear this chat?" : "Delete this chat?"}
        body={
          confirming?.action.kind === "clear"
            ? "The messages disappear from your view. Anything not yet cleared by the other side still exists there."
            : "This chat is removed from your list for good. The other person keeps the full history and your chat reappears when they message you again."
        }
        confirmLabel={confirming?.action.kind === "clear" ? "Clear chat" : "Delete chat"}
        onClose={() => setConfirming(null)}
        onConfirm={() => void runConfirm()}
      />
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
    </View>
  );
}

function Chip({
  palette,
  label,
  onPress,
}: {
  palette: ReturnType<typeof usePalette>;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={{ borderRadius: radius.pill, backgroundColor: palette.raised, paddingHorizontal: 12, paddingVertical: 6 }}>
      <Text style={{ fontSize: 12, fontWeight: "700", color: palette.textMuted }}>{label}</Text>
    </Pressable>
  );
}

function ConversationRow({
  conversation,
  online,
  onPress,
  onLongPress,
}: {
  conversation: ConversationSummary;
  online: boolean;
  onPress: () => void;
  onLongPress: () => void;
}) {
  const palette = usePalette();
  const name = peerName(conversation);
  const muted = isMuted(conversation);
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={280}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: spacing.md,
        paddingHorizontal: spacing.lg,
        paddingVertical: 12,
        backgroundColor: pressed ? palette.raised : "transparent",
      })}
    >
      <Avatar initial={avatarInitial(name)} online={online} size={48} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", gap: spacing.sm }}>
          <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: "700", color: palette.text, flexShrink: 1 }}>
            {conversation.pinned && <Text style={{ color: colors.iris600 }}>📌 </Text>}
            {name}
          </Text>
          {muted && <Text style={{ fontSize: 11, color: palette.textFaint }}>🔕</Text>}
          {conversation.type === "GROUP" && (
            <Text style={{ fontSize: 10, fontWeight: "800", color: colors.iris600, textTransform: "uppercase" }}>Group</Text>
          )}
          {conversation.lastMessage && (
            <Text style={{ fontSize: 11, color: palette.textFaint }}>{relativeTime(conversation.lastMessage.createdAt)}</Text>
          )}
        </View>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: spacing.sm, marginTop: 2 }}>
          <Text numberOfLines={1} style={{ fontSize: 13, color: palette.textMuted, flexShrink: 1 }}>
            {conversation.group ? `${conversation.group.memberCount} members · ` : ""}
            {previewText(conversation)}
          </Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
            {conversation.unreadMentions > 0 && (
              <View style={{ minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 6, backgroundColor: colors.signal500, alignItems: "center", justifyContent: "center" }}>
                <Text style={{ color: colors.white, fontSize: 11, fontWeight: "900" }}>@</Text>
              </View>
            )}
            {conversation.unreadCount > 0 && (
              <View style={{ minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 6, backgroundColor: colors.iris600, alignItems: "center", justifyContent: "center" }}>
                <Text style={{ color: colors.white, fontSize: 11, fontWeight: "800" }}>
                  {conversation.unreadCount > 99 ? "99+" : conversation.unreadCount}
                </Text>
              </View>
            )}
          </View>
        </View>
      </View>
    </Pressable>
  );
}
