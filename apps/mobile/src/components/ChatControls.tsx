import { useState, type ReactNode } from "react";
import { Modal, Pressable, Text, TextInput, View } from "react-native";
import type { ConversationSummary, ReportReason, ReportTargetType } from "@convo/shared";
import { api } from "../api";
import { peerName } from "../chatUtils";
import { usePalette } from "./ui";
import { colors, radius, spacing } from "../theme";

/**
 * Shared Phase 5A chat controls for React Native: the action sheet every chat
 * exposes, plus the report and confirm sheets. The web equivalent is
 * apps/web/src/components/ChatControls.tsx.
 */

export type ChatAction =
  | { kind: "pin"; pinned: boolean }
  | { kind: "archive"; archived: boolean }
  | { kind: "mute"; hours: number }
  | { kind: "ephemeral"; seconds: number }
  | { kind: "export" }
  | { kind: "clear" }
  | { kind: "delete" }
  | { kind: "info" }
  | { kind: "report" };

/** WhatsApp's mute presets; 0 unmutes. */
export const MUTE_PRESETS: { hours: number; label: string }[] = [
  { hours: 8, label: "8 hours" },
  { hours: 168, label: "1 week" },
  { hours: 8760, label: "1 year" },
];

/** The four disappearing-message timers the API accepts; 0 turns them off. */
export const EPHEMERAL_PRESETS: { seconds: number; label: string }[] = [
  { seconds: 0, label: "Off" },
  { seconds: 86_400, label: "24 hours" },
  { seconds: 7 * 86_400, label: "7 days" },
  { seconds: 90 * 86_400, label: "90 days" },
];

/** Compact timer label for the chat header, e.g. 86400 → "1d". */
export function shortEphemeral(seconds: number): string {
  if (seconds % 86_400 === 0) return `${Math.round(seconds / 86_400)}d`;
  return `${Math.round(seconds / 3600)}h`;
}

const REPORT_REASONS: { value: ReportReason; label: string }[] = [
  { value: "SPAM", label: "Spam" },
  { value: "ABUSE", label: "Abusive" },
  { value: "HARASSMENT", label: "Harassment" },
  { value: "FRAUD", label: "Fraud or scam" },
  { value: "VIOLENT", label: "Violent" },
  { value: "IMPERSONATION", label: "Impersonation" },
  { value: "OTHER", label: "Something else" },
];

export function isMuted(conversation: ConversationSummary): boolean {
  return conversation.mutedUntil !== null && new Date(conversation.mutedUntil) > new Date();
}

/** Applies a non-destructive control; destructive ones are confirmed by the caller. */
export async function applyQuietAction(
  conversation: ConversationSummary,
  action: ChatAction,
): Promise<ConversationSummary | null> {
  if (action.kind === "pin") return api.updateConversation(conversation.id, { pinned: action.pinned });
  if (action.kind === "archive") return api.updateConversation(conversation.id, { archived: action.archived });
  if (action.kind === "mute") return api.updateConversation(conversation.id, { muteHours: action.hours });
  return null;
}

export function Sheet({
  visible,
  onClose,
  title,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
}) {
  const palette = usePalette();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.4)" }} onPress={onClose}>
        <View style={{ flex: 1, justifyContent: "flex-end" }}>
          <Pressable
            onPress={(e) => e.stopPropagation()}
            style={{
              backgroundColor: palette.surface,
              borderTopLeftRadius: radius.card,
              borderTopRightRadius: radius.card,
              padding: spacing.lg,
              gap: spacing.sm,
            }}
          >
            {title && (
              <Text style={{ fontSize: 15, fontWeight: "800", color: palette.text }}>{title}</Text>
            )}
            {children}
          </Pressable>
        </View>
      </Pressable>
    </Modal>
  );
}

export function SheetButton({
  label,
  onPress,
  palette,
  danger,
  muted,
}: {
  label: string;
  onPress: () => void;
  palette: ReturnType<typeof usePalette>;
  danger?: boolean;
  muted?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        paddingVertical: 12,
        paddingHorizontal: spacing.md,
        borderRadius: radius.field,
        backgroundColor: pressed ? palette.raised : palette.bg,
        borderWidth: 1,
        borderColor: palette.border,
      })}
    >
      <Text style={{ fontSize: 15, fontWeight: "700", color: danger ? colors.danger : muted ? palette.textFaint : palette.text }}>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * Per-conversation controls. Pin/archive/mute apply immediately; clear, delete
 * and report are handed to the caller because they need confirming.
 */
export function ChatActionSheet({
  conversation,
  visible,
  onClose,
  onAction,
}: {
  conversation: ConversationSummary | null;
  visible: boolean;
  onClose: () => void;
  onAction: (action: ChatAction) => void;
}) {
  const palette = usePalette();
  const [mutePicker, setMutePicker] = useState(false);
  const [ephemeralPicker, setEphemeralPicker] = useState(false);
  if (!conversation) return null;
  const muted = isMuted(conversation);

  if (ephemeralPicker) {
    return (
      <Sheet visible={visible} onClose={() => setEphemeralPicker(false)} title="Disappearing messages">
        {EPHEMERAL_PRESETS.map((preset) => (
          <SheetButton
            key={preset.seconds}
            label={
              conversation.ephemeralSeconds === preset.seconds ? `${preset.label} ✓` : preset.label
            }
            palette={palette}
            onPress={() => {
              setEphemeralPicker(false);
              onAction({ kind: "ephemeral", seconds: preset.seconds });
            }}
          />
        ))}
        <SheetButton label="Back" muted palette={palette} onPress={() => setEphemeralPicker(false)} />
      </Sheet>
    );
  }

  if (mutePicker) {
    return (
      <Sheet visible={visible} onClose={() => setMutePicker(false)} title={`Mute ${peerName(conversation)}`}>
        {MUTE_PRESETS.map((preset) => (
          <SheetButton
            key={preset.hours}
            label={preset.label}
            palette={palette}
            onPress={() => {
              setMutePicker(false);
              onAction({ kind: "mute", hours: preset.hours });
            }}
          />
        ))}
        {muted && (
          <SheetButton
            label="Unmute"
            palette={palette}
            onPress={() => {
              setMutePicker(false);
              onAction({ kind: "mute", hours: 0 });
            }}
          />
        )}
        <SheetButton label="Cancel" muted palette={palette} onPress={() => setMutePicker(false)} />
      </Sheet>
    );
  }

  return (
    <Sheet visible={visible} onClose={onClose} title={peerName(conversation)}>
      <SheetButton
        label={conversation.pinned ? "Unpin chat" : "Pin chat"}
        palette={palette}
        onPress={() => onAction({ kind: "pin", pinned: !conversation.pinned })}
      />
      <SheetButton
        label={muted ? "Unmute chat" : "Mute notifications"}
        palette={palette}
        onPress={() => (muted ? onAction({ kind: "mute", hours: 0 }) : setMutePicker(true))}
      />
      <SheetButton
        label={conversation.archived ? "Unarchive chat" : "Archive chat"}
        palette={palette}
        onPress={() => onAction({ kind: "archive", archived: !conversation.archived })}
      />
      {conversation.type === "DIRECT" && (
        <SheetButton
          label={
            conversation.ephemeralSeconds > 0
              ? `Disappearing · ${shortEphemeral(conversation.ephemeralSeconds)}`
              : "Disappearing messages"
          }
          palette={palette}
          onPress={() => setEphemeralPicker(true)}
        />
      )}
      {conversation.type === "DIRECT" && (
        <SheetButton label="Contact info" palette={palette} onPress={() => onAction({ kind: "info" })} />
      )}
      <SheetButton label="Export chat" palette={palette} onPress={() => onAction({ kind: "export" })} />
      <SheetButton label="Clear chat" palette={palette} onPress={() => onAction({ kind: "clear" })} />
      <SheetButton label="Report chat" palette={palette} onPress={() => onAction({ kind: "report" })} />
      <SheetButton label="Delete chat for me" danger palette={palette} onPress={() => onAction({ kind: "delete" })} />
      <SheetButton label="Cancel" muted palette={palette} onPress={onClose} />
    </Sheet>
  );
}

export function ConfirmSheet({
  visible,
  title,
  body,
  confirmLabel,
  onClose,
  onConfirm,
}: {
  visible: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const palette = usePalette();
  return (
    <Sheet visible={visible} onClose={onClose} title={title}>
      <Text style={{ fontSize: 14, lineHeight: 21, color: palette.textMuted }}>{body}</Text>
      <SheetButton label={confirmLabel} danger palette={palette} onPress={onConfirm} />
      <SheetButton label="Cancel" muted palette={palette} onPress={onClose} />
    </Sheet>
  );
}

/** Reason picker + optional block, matching the web report dialog. */
export function ReportSheet({
  visible,
  targetType,
  targetId,
  targetLabel,
  onClose,
  onDone,
}: {
  visible: boolean;
  targetType: ReportTargetType;
  targetId: string;
  targetLabel: string;
  onClose: () => void;
  onDone: (blocked: boolean) => void;
}) {
  const palette = usePalette();
  const [reason, setReason] = useState<ReportReason>("SPAM");
  const [details, setDetails] = useState("");
  const [block, setBlock] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.report({
        targetType,
        targetId,
        reason,
        details: details.trim() || undefined,
        blockAfterReport: block,
      });
      onDone(result.blocked);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Report failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet visible={visible} onClose={onClose} title={`Report ${targetLabel}`}>
      <Text style={{ fontSize: 13, color: palette.textMuted }}>What is wrong with this {targetType.toLowerCase()}?</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
        {REPORT_REASONS.map((option) => (
          <Pressable
            key={option.value}
            onPress={() => setReason(option.value)}
            style={{
              borderRadius: radius.pill,
              borderWidth: 1,
              borderColor: reason === option.value ? colors.iris600 : palette.border,
              backgroundColor: reason === option.value ? colors.iris100 : palette.surface,
              paddingHorizontal: 12,
              paddingVertical: 7,
            }}
          >
            <Text style={{ fontSize: 13, fontWeight: "700", color: reason === option.value ? colors.iris700 : palette.textMuted }}>
              {option.label}
            </Text>
          </Pressable>
        ))}
      </View>
      <TextInput
        value={details}
        onChangeText={setDetails}
        placeholder="Add details (optional)"
        placeholderTextColor={palette.textFaint}
        multiline
        style={{
          minHeight: 72,
          borderRadius: radius.field,
          borderWidth: 1,
          borderColor: palette.border,
          backgroundColor: palette.bg,
          padding: spacing.md,
          fontSize: 14,
          color: palette.text,
          textAlignVertical: "top",
        }}
      />
      <Pressable onPress={() => setBlock((v) => !v)} style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
        <View
          style={{
            width: 20,
            height: 20,
            borderRadius: 6,
            borderWidth: 1.5,
            borderColor: block ? colors.iris600 : palette.border,
            backgroundColor: block ? colors.iris600 : "transparent",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {block && <Text style={{ color: colors.white, fontSize: 12, fontWeight: "900" }}>✓</Text>}
        </View>
        <Text style={{ fontSize: 14, color: palette.text }}>Also block this account</Text>
      </Pressable>
      {error && <Text style={{ fontSize: 13, color: colors.danger }}>{error}</Text>}
      <SheetButton label={busy ? "Sending…" : "Send report"} palette={palette} onPress={() => void submit()} />
      <SheetButton label="Cancel" muted palette={palette} onPress={onClose} />
    </Sheet>
  );
}
