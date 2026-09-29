import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import type { Account, MailThreadSummary, WsServerEvent } from "@convo/shared";
import { api } from "../api";
import { useRealtimeEvents, useRealtimeStatus } from "../realtime";
import { newClientMessageId } from "../outbox";
import {
  avatarInitial,
  errorMessage,
  participantsLabel,
  previewText,
  relativeTime,
  threadTitle,
} from "../mailUtils";
import { Avatar, Button, TextField, usePalette } from "../components/ui";
import { colors, radius, spacing } from "../theme";

export function MailScreen({
  account,
  onOpenThread,
}: {
  account: Account;
  onOpenThread: (thread: MailThreadSummary) => void;
}) {
  const palette = usePalette();
  const wsStatus = useRealtimeStatus();
  const myEmail = account.email?.email ?? null;
  const [threads, setThreads] = useState<MailThreadSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showCompose, setShowCompose] = useState(false);

  const load = useCallback(async () => {
    try {
      const list = await api.listMailThreads();
      setThreads(list.threads);
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useRealtimeEvents(
    useCallback((event: WsServerEvent) => {
      if (event.type !== "mail.new") return;
      const incoming = event.thread;
      setThreads((prev) => {
        if (!prev) return prev;
        return [incoming, ...prev.filter((t) => t.id !== incoming.id)];
      });
    }, []),
  );

  if (showCompose) {
    return (
      <ComposeDialog
        palette={palette}
        onClose={() => setShowCompose(false)}
        onSent={async () => {
          setShowCompose(false);
          await load();
        }}
      />
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: spacing.lg, paddingBottom: spacing.sm }}>
        <Text style={{ fontSize: 12, fontWeight: "700", letterSpacing: 0.6, color: palette.textFaint, textTransform: "uppercase" }}>
          Mail
          {wsStatus !== "open" && <Text style={{ color: colors.amberText, fontWeight: "500", textTransform: "none" }}>  ·  reconnecting…</Text>}
        </Text>
        <Pressable onPress={() => setShowCompose(true)}>
          <View style={{ backgroundColor: colors.iris600, borderRadius: radius.pill, paddingHorizontal: 14, paddingVertical: 7 }}>
            <Text style={{ color: colors.white, fontWeight: "700", fontSize: 13 }}>New</Text>
          </View>
        </Pressable>
      </View>

      {loadError && !threads ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.lg }}>
          <Text style={{ color: colors.danger, textAlign: "center" }}>{loadError}</Text>
          <View style={{ marginTop: spacing.md, minWidth: 120 }}>
            <Button label="Retry" variant="secondary" onPress={() => void load()} />
          </View>
        </View>
      ) : threads === null ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator color={colors.iris600} />
        </View>
      ) : (
        <FlatList
          data={threads}
          keyExtractor={(t) => t.id}
          ListEmptyComponent={
            <View style={{ alignItems: "center", justifyContent: "center", paddingVertical: 60, gap: spacing.sm }}>
              <Text style={{ fontSize: 16, fontWeight: "700", color: palette.text }}>No mail yet</Text>
              <Text style={{ fontSize: 13, color: palette.textMuted, textAlign: "center", paddingHorizontal: 40 }}>
                Compose a new mail to any Convo user or external address.
              </Text>
            </View>
          }
          renderItem={({ item }) => (
            <ThreadRow thread={item} myEmail={myEmail} onPress={() => onOpenThread(item)} />
          )}
          ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: palette.border, marginLeft: 76 }} />}
        />
      )}
    </View>
  );
}

function ThreadRow({
  thread,
  myEmail,
  onPress,
}: {
  thread: MailThreadSummary;
  myEmail: string | null;
  onPress: () => void;
}) {
  const palette = usePalette();
  const title = threadTitle(thread, myEmail);
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
      <Avatar initial={avatarInitial(title)} size={48} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", gap: spacing.sm }}>
          <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: "700", color: palette.text, flexShrink: 1 }}>{title}</Text>
          <Text style={{ fontSize: 11, color: palette.textFaint }}>{relativeTime(thread.lastActivityAt)}</Text>
        </View>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: spacing.sm, marginTop: 2 }}>
          <Text numberOfLines={1} style={{ fontSize: 13, color: palette.textMuted, flexShrink: 1 }}>{previewText(thread)}</Text>
          {thread.unreadCount > 0 && (
            <View style={{ minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 6, backgroundColor: colors.iris600, alignItems: "center", justifyContent: "center" }}>
              <Text style={{ color: colors.white, fontSize: 11, fontWeight: "800" }}>
                {thread.unreadCount > 99 ? "99+" : thread.unreadCount}
              </Text>
            </View>
          )}
        </View>
        <Text numberOfLines={1} style={{ fontSize: 11, color: palette.textFaint, marginTop: 2 }}>
          {participantsLabel(thread, myEmail)}
        </Text>
      </View>
    </Pressable>
  );
}

function ComposeDialog({
  palette,
  onClose,
  onSent,
}: {
  palette: ReturnType<typeof usePalette>;
  onClose: () => void;
  onSent: () => Promise<void>;
}) {
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [showSubject, setShowSubject] = useState(false);
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const addresses = to
    .split(/[\s,]+/)
    .map((a) => a.trim())
    .filter(Boolean);
  const canSend = addresses.length > 0 && body.trim().length > 0;

  const send = async () => {
    setSending(true);
    setError(null);
    try {
      await api.composeMail({
        clientSendId: newClientMessageId(),
        to: addresses,
        ...(subject.trim() ? { subject: subject.trim() } : {}),
        body: body.trim(),
      });
      await onSent();
    } catch (err) {
      setError(errorMessage(err));
      setSending(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: spacing.lg, paddingTop: spacing.xl, paddingBottom: spacing.md, borderBottomWidth: 1, borderBottomColor: palette.border }}>
        <Text style={{ fontSize: 20, fontWeight: "800", color: palette.text }}>New mail</Text>
        <Pressable onPress={onClose} hitSlop={8}>
          <Text style={{ fontSize: 15, fontWeight: "600", color: palette.textMuted }}>Cancel</Text>
        </Pressable>
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }}>
        <TextField
          label="To"
          value={to}
          onChangeText={(v) => { setTo(v); setError(null); }}
          placeholder="friend@example.com"
          keyboardType="email-address"
          error={error}
          autoFocus
          palette={palette}
        />
        {showSubject ? (
          <TextField label="Subject" value={subject} onChangeText={setSubject} placeholder="Subject" palette={palette} />
        ) : (
          <Pressable onPress={() => setShowSubject(true)}>
            <Text style={{ fontSize: 13, fontWeight: "600", color: colors.iris600 }}>+ Add subject</Text>
          </Pressable>
        )}
        <TextInput
          value={body}
          onChangeText={(v) => { setBody(v); setError(null); }}
          placeholder="Write your message…"
          placeholderTextColor={palette.textFaint}
          multiline
          style={{
            minHeight: 160,
            backgroundColor: palette.surface,
            borderColor: palette.border,
            borderWidth: 1,
            borderRadius: radius.field,
            paddingHorizontal: spacing.md,
            paddingVertical: 13,
            fontSize: 15,
            color: palette.text,
            textAlignVertical: "top",
          }}
        />
        {otherParticipantsHint(addresses, palette)}
      </ScrollView>

      <View style={{ padding: spacing.lg, borderTopWidth: 1, borderTopColor: palette.border }}>
        <Button label="Send" onPress={() => void send()} loading={sending} disabled={!canSend} />
      </View>
    </KeyboardAvoidingView>
  );
}

function otherParticipantsHint(addresses: string[], palette: ReturnType<typeof usePalette>) {
  if (addresses.length === 0) return null;
  return (
    <Text style={{ fontSize: 12, color: palette.textFaint }}>
      Sending to {addresses.length} {addresses.length === 1 ? "recipient" : "recipients"}.
    </Text>
  );
}
