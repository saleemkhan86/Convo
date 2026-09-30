import { useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { ConversationSummary, GlobalSearchResult } from "@convo/shared";
import { api } from "../api";
import { avatarInitial, errorMessage } from "../chatUtils";
import { Avatar, ScreenHeader, usePalette } from "../components/ui";
import { colors, radius, spacing } from "../theme";

/**
 * One query across the caller's own data (Phase 5A): contacts, chats, message
 * bodies and discoverable public groups. The server only searches rows the
 * caller can already see.
 */
export function SearchScreen({
  onBack,
  onOpenChat,
  onOpenConversation,
}: {
  onBack: () => void;
  onOpenChat: (conversation: ConversationSummary) => void;
  onOpenConversation: (conversationId: string) => void;
}) {
  const palette = usePalette();
  const [term, setTerm] = useState("");
  const [result, setResult] = useState<GlobalSearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const value = term.trim();
    if (timer.current) clearTimeout(timer.current);
    if (value.length < 2) {
      setResult(null);
      setBusy(false);
      return;
    }
    setBusy(true);
    timer.current = setTimeout(() => {
      api
        .search(value)
        .then((r) => {
          setResult(r);
          setError(null);
        })
        .catch((err) => setError(errorMessage(err)))
        .finally(() => setBusy(false));
    }, 250);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [term]);

  const startWith = async (phone: string) => {
    try {
      onOpenChat(await api.startConversation(phone));
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const empty =
    result !== null &&
    result.contacts.length === 0 &&
    result.conversations.length === 0 &&
    result.messages.length === 0 &&
    result.groups.length === 0;

  return (
    <View style={{ flex: 1, backgroundColor: palette.bg }}>
      <ScreenHeader title="Search" onBack={onBack} palette={palette} />
      <View style={{ padding: spacing.lg, paddingBottom: spacing.sm }}>
        <TextInput
          value={term}
          onChangeText={setTerm}
          placeholder="Contacts, chats, messages, groups"
          placeholderTextColor={palette.textFaint}
          autoFocus
          style={{
            backgroundColor: palette.surface,
            borderColor: palette.border,
            borderWidth: 1,
            borderRadius: radius.field,
            paddingHorizontal: spacing.md,
            paddingVertical: 12,
            fontSize: 15,
            color: palette.text,
          }}
        />
      </View>
      {error && <Text style={{ paddingHorizontal: spacing.lg, fontSize: 13, color: colors.danger }}>{error}</Text>}
      {busy && (
        <View style={{ paddingVertical: spacing.lg, alignItems: "center" }}>
          <ActivityIndicator color={colors.iris600} />
        </View>
      )}
      {empty && !busy && (
        <Text style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.lg, fontSize: 13, color: palette.textMuted }}>
          No matches for “{result?.query ?? ""}”.
        </Text>
      )}
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: spacing.lg, paddingTop: spacing.sm, gap: spacing.md }}>
        {result && result.conversations.length > 0 && (
          <Group title="Chats">
            {result.conversations.map((c) => (
              <Line
                key={c.id}
                name={c.type === "GROUP" ? c.title ?? "Group" : c.peer?.displayName ?? c.peer?.phone ?? "Convo chat"}
                detail={c.lastMessage?.body ?? undefined}
                onPress={() => onOpenChat(c)}
              />
            ))}
          </Group>
        )}
        {result && result.messages.length > 0 && (
          <Group title="Messages">
            {result.messages.map((m) => (
              <Line
                key={m.message.id}
                name={m.conversationName ?? "Convo chat"}
                detail={m.message.body ?? "Message"}
                onPress={() => onOpenConversation(m.conversationId)}
              />
            ))}
          </Group>
        )}
        {result && result.contacts.length > 0 && (
          <Group title="Contacts">
            {result.contacts.map((c) => (
              <Line
                key={c.id}
                name={c.displayName}
                detail={c.phone ?? c.email ?? undefined}
                onPress={() => (c.phone ? void startWith(c.phone) : undefined)}
              />
            ))}
          </Group>
        )}
        {result && result.groups.length > 0 && (
          <Group title="Public groups">
            {result.groups.map((g) => (
              <Line
                key={g.conversationId}
                name={g.name}
                detail={`${g.memberCount} members`}
                onPress={() => onOpenConversation(g.conversationId)}
              />
            ))}
          </Group>
        )}
      </ScrollView>
    </View>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  const palette = usePalette();
  return (
    <View style={{ gap: spacing.xs }}>
      <Text style={{ fontSize: 11, fontWeight: "700", letterSpacing: 0.6, color: palette.textFaint, textTransform: "uppercase" }}>
        {title}
      </Text>
      {children}
    </View>
  );
}

function Line({
  name,
  detail,
  onPress,
}: {
  name: string;
  detail?: string;
  onPress: () => void;
}) {
  const palette = usePalette();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: spacing.md,
        paddingVertical: 10,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Avatar initial={avatarInitial(name)} size={34} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ fontSize: 14, fontWeight: "700", color: palette.text }}>
          {name}
        </Text>
        {detail && (
          <Text numberOfLines={1} style={{ fontSize: 12, color: palette.textFaint }}>
            {detail}
          </Text>
        )}
      </View>
    </Pressable>
  );
}
