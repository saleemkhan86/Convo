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
import type { Account, MailMessage, MailThreadSummary, WsServerEvent } from "@convo/shared";
import { api } from "../api";
import { useRealtimeEvents, useRealtimeStatus } from "../realtime";
import { newClientMessageId } from "../outbox";
import {
  avatarInitial,
  clockTime,
  errorMessage,
  participantsLabel,
  senderLabel,
  threadTitle,
} from "../mailUtils";
import { Avatar, usePalette } from "../components/ui";
import { colors, radius, spacing } from "../theme";

interface PendingReply {
  clientSendId: string;
  body: string;
  status: "sending" | "failed";
}

export function MailThreadScreen({
  thread,
  account,
  onBack,
}: {
  thread: MailThreadSummary;
  account: Account;
  onBack: () => void;
}) {
  const palette = usePalette();
  const wsStatus = useRealtimeStatus();
  const threadId = thread.id;
  const myEmail = account.email?.email ?? null;
  const title = threadTitle(thread, myEmail);

  const [messages, setMessages] = useState<MailMessage[]>([]);
  const [pending, setPending] = useState<PendingReply[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const page = await api.listMailMessages(threadId);
        if (cancelled) return;
        setMessages(page.messages);
        setLoading(false);
        await api.markThreadRead(threadId).catch(() => {});
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
  }, [threadId]);

  useRealtimeEvents(
    useCallback(
      (event: WsServerEvent) => {
        if (event.type !== "mail.new") return;
        if (event.message.threadId !== threadId) return;
        const msg = event.message;
        setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
        void api.markThreadRead(threadId).catch(() => {});
      },
      [threadId],
    ),
  );

  useEffect(() => {
    if (!loading) {
      const t = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: false }), 50);
      return () => clearTimeout(t);
    }
  }, [messages.length, pending.length, loading]);

  const sendReply = async () => {
    const body = draft.trim();
    if (!body) return;
    setDraft("");
    const clientSendId = newClientMessageId();
    setPending((p) => [...p, { clientSendId, body, status: "sending" }]);
    try {
      const result = await api.replyMail(threadId, { clientSendId, body });
      setPending((p) => p.filter((m) => m.clientSendId !== clientSendId));
      setMessages((prev) => (prev.some((m) => m.id === result.message.id) ? prev : [...prev, result.message]));
    } catch {
      setPending((p) => p.map((m) => (m.clientSendId === clientSendId ? { ...m, status: "failed" } : m)));
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
        <Avatar initial={avatarInitial(title)} size={38} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: "800", color: palette.text }}>{title}</Text>
          <Text numberOfLines={1} style={{ fontSize: 12, color: palette.textFaint }}>
            {participantsLabel(thread, myEmail)}
            {wsStatus !== "open" ? "  ·  reconnecting…" : ""}
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
        <ScrollView ref={scrollRef} style={{ flex: 1 }} contentContainerStyle={{ padding: spacing.md, gap: spacing.sm }}>
          {messages.map((msg) => (
            <MailBubble key={msg.id} message={msg} mine={msg.direction === "OUTBOUND"} myEmail={myEmail} palette={palette} />
          ))}
          {pending.map((p) => (
            <View key={p.clientSendId} style={{ flexDirection: "row", justifyContent: "flex-end" }}>
              <View
                style={{
                  maxWidth: "82%",
                  borderRadius: radius.card,
                  borderBottomRightRadius: 4,
                  backgroundColor: colors.iris100,
                  paddingHorizontal: 14,
                  paddingVertical: 9,
                }}
              >
                <Text style={{ fontSize: 15, color: colors.iris700 }}>{p.body}</Text>
                <Text style={{ fontSize: 10, color: colors.iris700, textAlign: "right", marginTop: 2 }}>
                  {p.status === "failed" ? "Not sent — retry" : "Sending…"}
                </Text>
              </View>
            </View>
          ))}
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
          onChangeText={setDraft}
          placeholder="Reply…"
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
          onPress={() => void sendReply()}
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

function MailBubble({
  message,
  mine,
  myEmail,
  palette,
}: {
  message: MailMessage;
  mine: boolean;
  myEmail: string | null;
  palette: ReturnType<typeof usePalette>;
}) {
  const time = clockTime(message.receivedAt ?? message.sentAt ?? message.createdAt);
  return (
    <View style={{ flexDirection: "row", justifyContent: mine ? "flex-end" : "flex-start" }}>
      <View
        style={{
          maxWidth: "82%",
          borderRadius: radius.card,
          borderBottomRightRadius: mine ? 4 : radius.card,
          borderBottomLeftRadius: mine ? radius.card : 4,
          backgroundColor: mine ? colors.iris600 : palette.surface,
          paddingHorizontal: 14,
          paddingVertical: 9,
        }}
      >
        {!mine && (
          <Text style={{ fontSize: 11, fontWeight: "700", color: colors.iris600, marginBottom: 2 }}>
            {senderLabel(message, myEmail)}
          </Text>
        )}
        {message.subject && (
          <Text style={{ fontSize: 13, fontWeight: "700", color: mine ? colors.white : palette.text, marginBottom: 2 }}>
            {message.subject}
          </Text>
        )}
        <Text style={{ fontSize: 15, color: mine ? colors.white : palette.text }}>{message.bodyText ?? ""}</Text>
        <Text style={{ fontSize: 10, color: mine ? "rgba(255,255,255,0.75)" : palette.textFaint, textAlign: "right", marginTop: 2 }}>
          {time}
          {mine ? "  ✓" : ""}
        </Text>
      </View>
    </View>
  );
}
