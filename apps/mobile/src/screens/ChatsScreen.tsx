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
import type { ConversationSummary, WsServerEvent } from "@convo/shared";
import { api, ApiRequestError } from "../api";
import { useRealtimeEvents, useRealtimeStatus, sendRealtime } from "../realtime";
import { outboxSnapshot, outboxRemove } from "../outbox";
import { avatarInitial, errorMessage, peerName, previewText, relativeTime } from "../chatUtils";
import { Avatar, Button, TextField, usePalette } from "../components/ui";
import { colors, radius, spacing } from "../theme";

export function ChatsScreen({
  onOpenChat,
}: {
  onOpenChat: (conversation: ConversationSummary) => void;
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

  const load = useCallback(async () => {
    try {
      const list = await api.listConversations();
      setConversations(list.conversations);
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }, []);

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
            { ...conv, lastMessage: msg, lastMessageAt: msg.createdAt, unreadCount: conv.unreadCount + 1 },
            ...prev.filter((c) => c.id !== conv.id),
          ];
        });
      } else if (event.type === "message.read") {
        setConversations((prev) =>
          prev?.map((c) => (c.id === event.conversationId ? { ...c, lastReadAt: event.readAt } : c)) ?? prev,
        );
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

  const startChat = async () => {
    const value = phone.trim();
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
          Conversations
          {wsStatus !== "open" && <Text style={{ color: colors.amberText, fontWeight: "500", textTransform: "none" }}>  ·  reconnecting…</Text>}
        </Text>
        <Pressable onPress={() => setShowNew(true)}>
          <View style={{ backgroundColor: colors.iris600, borderRadius: radius.pill, paddingHorizontal: 14, paddingVertical: 7 }}>
            <Text style={{ color: colors.white, fontWeight: "700", fontSize: 13 }}>New</Text>
          </View>
        </Pressable>
      </View>

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
              <Text style={{ fontSize: 16, fontWeight: "700", color: palette.text }}>No conversations yet</Text>
              <Text style={{ fontSize: 13, color: palette.textMuted, textAlign: "center", paddingHorizontal: 40 }}>
                Start a chat with any phone number on Convo.
              </Text>
            </View>
          }
          renderItem={({ item }) => (
            <ConversationRow
              conversation={item}
              online={item.peer ? peerOnline[item.peer.userId] === true : false}
              onPress={() => onOpenChat(item)}
            />
          )}
          ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: palette.border, marginLeft: 76 }} />}
        />
      )}
    </View>
  );
}

function ConversationRow({
  conversation,
  online,
  onPress,
}: {
  conversation: ConversationSummary;
  online: boolean;
  onPress: () => void;
}) {
  const palette = usePalette();
  const name = peerName(conversation);
  return (
    <Pressable
      onPress={onPress}
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
          <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: "700", color: palette.text, flexShrink: 1 }}>{name}</Text>
          {conversation.lastMessage && (
            <Text style={{ fontSize: 11, color: palette.textFaint }}>{relativeTime(conversation.lastMessage.createdAt)}</Text>
          )}
        </View>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: spacing.sm, marginTop: 2 }}>
          <Text numberOfLines={1} style={{ fontSize: 13, color: palette.textMuted, flexShrink: 1 }}>{previewText(conversation)}</Text>
          {conversation.unreadCount > 0 && (
            <View style={{ minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 6, backgroundColor: colors.iris600, alignItems: "center", justifyContent: "center" }}>
              <Text style={{ color: colors.white, fontSize: 11, fontWeight: "800" }}>
                {conversation.unreadCount > 99 ? "99+" : conversation.unreadCount}
              </Text>
            </View>
          )}
        </View>
      </View>
    </Pressable>
  );
}
