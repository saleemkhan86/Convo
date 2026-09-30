import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import type { StarredMessage } from "@convo/shared";
import { api } from "../api";
import { errorMessage, relativeTime } from "../chatUtils";
import { ScreenHeader, usePalette } from "../components/ui";
import { colors, radius, spacing } from "../theme";

/** Starred messages across every chat (Phase 5A) — a per-viewer bookmark list. */
export function StarredScreen({
  onBack,
  onOpenConversation,
}: {
  onBack: () => void;
  onOpenConversation: (conversationId: string) => void;
}) {
  const palette = usePalette();
  const [items, setItems] = useState<StarredMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const page = await api.listStarred();
      setItems(page.items);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const unstar = async (id: string) => {
    try {
      await api.starMessage(id, false);
      setItems((prev) => prev?.filter((item) => item.message.id !== id) ?? prev);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: palette.bg }}>
      <ScreenHeader
        title="Starred messages"
        subtitle={items === null ? "Loading…" : `${items.length} starred`}
        onBack={onBack}
        palette={palette}
      />
      {error && (
        <Text style={{ padding: spacing.lg, fontSize: 13, color: colors.danger }}>{error}</Text>
      )}
      {items === null ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator color={colors.iris600} />
        </View>
      ) : items.length === 0 ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.lg }}>
          <Text style={{ fontSize: 15, fontWeight: "700", color: palette.text }}>Nothing starred yet</Text>
          <Text style={{ marginTop: spacing.sm, fontSize: 13, color: palette.textMuted, textAlign: "center" }}>
            Long-press a message and choose Star to keep it here.
          </Text>
        </View>
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }}>
          {items.map((item) => (
            <Pressable
              key={item.message.id}
              onPress={() => onOpenConversation(item.conversationId)}
              style={({ pressed }) => ({
                backgroundColor: palette.surface,
                borderColor: palette.border,
                borderWidth: 1,
                borderRadius: radius.card,
                padding: spacing.md,
                gap: spacing.xs,
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <View style={{ flexDirection: "row", justifyContent: "space-between", gap: spacing.sm }}>
                <Text numberOfLines={1} style={{ flex: 1, fontSize: 12, fontWeight: "800", color: colors.iris600 }}>
                  {item.conversationName ?? "Convo chat"}
                </Text>
                <Text style={{ fontSize: 11, color: palette.textFaint }}>
                  {relativeTime(item.message.createdAt)}
                </Text>
              </View>
              <Text style={{ fontSize: 14, color: palette.text }}>{item.message.body ?? "Message"}</Text>
              <Pressable onPress={() => void unstar(item.message.id)} hitSlop={8}>
                <Text style={{ fontSize: 12, fontWeight: "700", color: colors.danger, marginTop: spacing.xs }}>
                  Unstar
                </Text>
              </Pressable>
            </Pressable>
          ))}
        </ScrollView>
      )}
    </View>
  );
}
