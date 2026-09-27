import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import type { Account, ConversationSummary, Message, WsServerEvent } from "@convo/shared";
import { api } from "../api";
import { useRealtimeEvents, useRealtimeStatus, sendRealtime } from "../realtime";
import { newClientMessageId, outboxAdd, outboxRemove } from "../outbox";
import { avatarInitial, clockTime, errorMessage, peerName } from "../chatUtils";
import { Avatar, usePalette } from "../components/ui";
import { colors, radius, spacing } from "../theme";

interface PendingMessage {
  clientMessageId: string;
  body: string;
  status: "sending" | "failed";
}

export function ChatRoomScreen({
  conversation,
  account,
  onBack,
}: {
  conversation: ConversationSummary;
  account: Account;
  onBack: () => void;
}) {
  const palette = usePalette();
  const wsStatus = useRealtimeStatus();
  const conversationId = conversation.id;
  const peer = conversation.peer;
  const name = peerName(conversation);

  const [messages, setMessages] = useState<Message[]>([]);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [typingUntil, setTypingUntil] = useState(0);
  const [peerOnline, setPeerOnline] = useState(false);

  const scrollRef = useRef<ScrollView>(null);
  const typingSentAt = useRef(0);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // Watch the peer's presence while the socket is open.
  useEffect(() => {
    if (wsStatus === "open" && peer) {
      sendRealtime({ type: "watch", userIds: [peer.userId] });
    }
  }, [wsStatus, peer]);

  // Typing indicator expiry.
  useEffect(() => {
    if (typingUntil === 0) return;
    const t = setTimeout(() => setTypingUntil(0), Math.max(0, typingUntil - Date.now()) + 50);
    return () => clearTimeout(t);
  }, [typingUntil]);

  useRealtimeEvents(
    useCallback(
      (event: WsServerEvent) => {
        if (event.type === "message.new" && event.message.conversationId === conversationId) {
          const msg = event.message;
          setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
          void api.markRead(conversationId, msg.id).catch(() => {});
        } else if (event.type === "typing" && event.conversationId === conversationId) {
          if (event.isTyping) setTypingUntil(Date.now() + 4000);
        } else if (event.type === "presence" && peer && event.userId === peer.userId) {
          setPeerOnline(event.online);
        }
      },
      [conversationId, peer],
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

  const sendMessage = async () => {
    const body = draft.trim();
    if (!body) return;
    setDraft("");
    const clientMessageId = newClientMessageId();
    setPending((p) => [...p, { clientMessageId, body, status: "sending" }]);
    outboxAdd({ conversationId, clientMessageId, body, queuedAt: Date.now() });
    try {
      const msg = await api.sendMessage(conversationId, { clientMessageId, body });
      outboxRemove(clientMessageId);
      setPending((p) => p.filter((m) => m.clientMessageId !== clientMessageId));
      setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
    } catch {
      setPending((p) => p.map((m) => (m.clientMessageId === clientMessageId ? { ...m, status: "failed" } : m)));
    }
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
          <Text numberOfLines={1} style={{ fontSize: 12, color: palette.textFaint }}>
            {Date.now() < typingUntil ? "typing…" : peer?.phone ?? ""}
          </Text>
        </View>
      </View>

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
          {messages.map((msg) => (
            <Bubble key={msg.id} message={msg} mine={msg.senderId === account.id} palette={palette} />
          ))}
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
                <Text style={{ fontSize: 15, color: colors.iris700 }}>{p.body}</Text>
                <Text style={{ fontSize: 10, color: colors.iris700, textAlign: "right", marginTop: 2 }}>
                  {p.status === "failed" ? "Not sent — will retry" : "Sending…"}
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
          flexDirection: "row",
          alignItems: "flex-end",
          gap: spacing.sm,
          padding: spacing.md,
          backgroundColor: palette.surface,
          borderTopWidth: 1,
          borderTopColor: palette.border,
        }}
      >
        <TextInput
          value={draft}
          onChangeText={onDraftChange}
          placeholder="Type a message"
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
          onPress={() => void sendMessage()}
          disabled={draft.trim().length === 0}
          style={({ pressed }) => ({
            backgroundColor: colors.iris600,
            borderRadius: radius.pill,
            paddingHorizontal: 18,
            paddingVertical: 12,
            opacity: draft.trim().length === 0 || pressed ? 0.5 : 1,
          })}
        >
          <Text style={{ color: colors.white, fontWeight: "800", fontSize: 14 }}>Send</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

function Bubble({ message, mine, palette }: { message: Message; mine: boolean; palette: ReturnType<typeof usePalette> }) {
  if (message.deletedAt) {
    return (
      <View style={{ flexDirection: "row", justifyContent: mine ? "flex-end" : "flex-start" }}>
        <View style={{ borderRadius: radius.card, backgroundColor: palette.raised, paddingHorizontal: 14, paddingVertical: 9 }}>
          <Text style={{ fontSize: 14, fontStyle: "italic", color: palette.textFaint }}>Message deleted</Text>
        </View>
      </View>
    );
  }
  return (
    <View style={{ flexDirection: "row", justifyContent: mine ? "flex-end" : "flex-start" }}>
      <View
        style={{
          maxWidth: "76%",
          borderRadius: radius.card,
          borderBottomRightRadius: mine ? 4 : radius.card,
          borderBottomLeftRadius: mine ? radius.card : 4,
          backgroundColor: mine ? colors.iris600 : palette.surface,
          paddingHorizontal: 14,
          paddingVertical: 9,
        }}
      >
        <Text style={{ fontSize: 15, color: mine ? colors.white : palette.text }}>{message.body}</Text>
        <Text style={{ fontSize: 10, color: mine ? "rgba(255,255,255,0.75)" : palette.textFaint, textAlign: "right", marginTop: 2 }}>
          {clockTime(message.createdAt)}
          {mine ? "  ✓" : ""}
        </Text>
      </View>
    </View>
  );
}
