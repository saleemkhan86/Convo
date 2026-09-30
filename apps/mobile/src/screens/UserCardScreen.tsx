import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import type { UserCard } from "@convo/shared";
import { api } from "../api";
import { avatarInitial, errorMessage, lastSeenLabel } from "../chatUtils";
import { Avatar, Button, ScreenHeader, usePalette } from "../components/ui";
import { ReportSheet } from "../components/ChatControls";
import { colors, radius, spacing } from "../theme";

/**
 * The contact-info card (Phase 5A). Privacy-gated fields arrive as null when
 * the owner hid them, so this screen never shows a "hidden" placeholder.
 */
export function UserCardScreen({
  userId,
  onBack,
  onOpenConversation,
}: {
  userId: string;
  onBack: () => void;
  onOpenConversation: (conversationId: string) => void;
}) {
  const palette = usePalette();
  const [card, setCard] = useState<UserCard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reportOpen, setReportOpen] = useState(false);

  const reload = useCallback(async () => {
    try {
      setCard(await api.userCard(userId));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [userId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const toggleBlock = async () => {
    if (!card) return;
    try {
      if (card.blockedByMe) {
        await api.unblockUser(card.userId);
      } else {
        await api.blockUser({ userId: card.userId });
      }
      await reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  if (!card) {
    return (
      <View style={{ flex: 1, backgroundColor: palette.bg }}>
        <ScreenHeader title="Contact info" onBack={onBack} palette={palette} />
        {error ? (
          <View style={{ padding: spacing.lg, gap: spacing.md }}>
            <Text style={{ fontSize: 14, color: colors.danger }}>{error}</Text>
            <Button label="Retry" variant="secondary" onPress={() => void reload()} />
          </View>
        ) : (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
            <ActivityIndicator color={colors.iris600} />
          </View>
        )}
      </View>
    );
  }

  const name = card.displayName ?? card.phone ?? "Convo user";
  const sharedId = card.sharedConversationId;
  return (
    <View style={{ flex: 1, backgroundColor: palette.bg }}>
      <ScreenHeader title="Contact info" onBack={onBack} palette={palette} />
      <View style={{ flex: 1, padding: spacing.lg, gap: spacing.md }}>
        <View style={{ alignItems: "center", gap: spacing.sm, paddingVertical: spacing.md }}>
          <Avatar initial={avatarInitial(name)} size={84} />
          <Text style={{ fontSize: 19, fontWeight: "800", color: palette.text }}>{name}</Text>
          {card.phone && <Text style={{ fontSize: 13, color: palette.textMuted }}>{card.phone}</Text>}
          {card.bio && (
            <Text style={{ fontSize: 13, color: palette.textMuted, textAlign: "center" }}>{card.bio}</Text>
          )}
          <Text style={{ fontSize: 12, color: palette.textFaint }}>
            {lastSeenLabel(card.lastSeenAt) || "last seen hidden"}
          </Text>
          {card.blockedByMe && (
            <View style={{ borderRadius: radius.pill, backgroundColor: colors.amberBg, paddingHorizontal: 12, paddingVertical: 5 }}>
              <Text style={{ fontSize: 12, fontWeight: "800", color: colors.amberText }}>Blocked — they cannot reach you</Text>
            </View>
          )}
        </View>

        {error && <Text style={{ fontSize: 13, color: colors.danger }}>{error}</Text>}

        {sharedId && <Button label="Open chat" onPress={() => onOpenConversation(sharedId)} />}
        <Button
          label={card.blockedByMe ? "Unblock" : "Block"}
          variant={card.blockedByMe ? "secondary" : "danger"}
          onPress={() => void toggleBlock()}
        />
        <Button label="Report" variant="secondary" onPress={() => setReportOpen(true)} />
      </View>

      <ReportSheet
        visible={reportOpen}
        targetType="USER"
        targetId={card.userId}
        targetLabel={name}
        onClose={() => setReportOpen(false)}
        onDone={() => {
          setReportOpen(false);
          void reload();
        }}
      />
    </View>
  );
}
