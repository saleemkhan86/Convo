import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import type { BlockedUser, Contact, ConversationSummary, RecentRecipient } from "@convo/shared";
import { api } from "../api";
import { avatarInitial, errorMessage, relativeTime } from "../chatUtils";
import { Avatar, Button, ScreenHeader, TextField, usePalette } from "../components/ui";
import { colors, radius, spacing } from "../theme";

/**
 * Phase 5A contacts: recent recipients, the private address book, and the
 * blocked list. A contact is only useful for chatting once its phone resolves
 * to a Convo account, which the server records as `convoUserId`.
 */
export function ContactsScreen({
  onBack,
  onOpenChat,
  onOpenConversation,
  onOpenUser,
}: {
  onBack: () => void;
  onOpenChat: (conversation: ConversationSummary) => void;
  onOpenConversation: (conversationId: string) => void;
  onOpenUser: (userId: string) => void;
}) {
  const palette = usePalette();
  const [recents, setRecents] = useState<RecentRecipient[] | null>(null);
  const [contacts, setContacts] = useState<Contact[] | null>(null);
  const [blocked, setBlocked] = useState<BlockedUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [r, c, b] = await Promise.all([api.recentRecipients(), api.listContacts(), api.listBlocked()]);
      setRecents(r.recipients);
      setContacts(c.contacts);
      setBlocked(b.blocked);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const resetForm = () => {
    setFormOpen(false);
    setName("");
    setPhone("");
    setEditingId(null);
    setBusy(false);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.saveContact({
        id: editingId ?? undefined,
        displayName: name.trim(),
        phone: phone.trim() || undefined,
      });
      resetForm();
      await reload();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await api.deleteContact(id);
      await reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const startWith = async (target: string) => {
    try {
      onOpenChat(await api.startConversation(target));
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const unblock = async (userId: string) => {
    try {
      await api.unblockUser(userId);
      setBlocked((prev) => prev.filter((b) => b.userId !== userId));
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: palette.bg }}>
      <ScreenHeader
        title="Contacts"
        subtitle={contacts === null ? "Loading…" : `${contacts.length} saved${blocked.length ? ` · ${blocked.length} blocked` : ""}`}
        onBack={onBack}
        palette={palette}
      />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }} keyboardShouldPersistTaps="handled">
        <Button
          label={formOpen ? "Close" : "Add contact"}
          variant={formOpen ? "secondary" : "primary"}
          onPress={() => (formOpen ? resetForm() : setFormOpen(true))}
        />

        {formOpen && (
          <View style={{ backgroundColor: palette.surface, borderColor: palette.border, borderWidth: 1, borderRadius: radius.card, padding: spacing.md, gap: spacing.md }}>
            <TextField label="Name" value={name} onChangeText={setName} placeholder="Display name" palette={palette} />
            <TextField
              label="Phone"
              value={phone}
              onChangeText={setPhone}
              placeholder="+15551234567"
              keyboardType="phone-pad"
              palette={palette}
            />
            <Button label={busy ? "Saving…" : "Save"} onPress={() => void save()} loading={busy} disabled={name.trim().length === 0} />
          </View>
        )}

        {error && <Text style={{ fontSize: 13, color: colors.danger }}>{error}</Text>}

        {recents === null ? (
          <ActivityIndicator color={colors.iris600} />
        ) : (
          <Section title="Recent chats">
            {recents.length === 0 ? (
              <Empty palette={palette} text="No recent chats yet." />
            ) : (
              recents.map((r) => (
                <Row
                  key={r.userId}
                  name={r.displayName ?? r.phone ?? "Convo user"}
                  detail={r.lastMessageAt ? `last message ${relativeTime(r.lastMessageAt)} ago` : r.phone ?? undefined}
                  onPress={() => onOpenConversation(r.conversationId)}
                  onLongPress={() => onOpenUser(r.userId)}
                />
              ))
            )}
          </Section>
        )}

        <Section title="Saved contacts">
          {contacts === null ? (
            <Empty palette={palette} text="Loading…" />
          ) : contacts.length === 0 ? (
            <Empty palette={palette} text="No contacts saved. Contacts stay private to you." />
          ) : (
            contacts.map((c) => (
              <Row
                key={c.id}
                name={c.displayName}
                detail={c.phone ?? c.email ?? (c.convoUserId ? "Convo account" : "Not on Convo yet")}
                muted={!c.convoUserId}
                onPress={() => (c.phone ? void startWith(c.phone) : undefined)}
                onEdit={() => {
                  setFormOpen(true);
                  setEditingId(c.id);
                  setName(c.displayName);
                  setPhone(c.phone ?? "");
                }}
                onDelete={() => void remove(c.id)}
              />
            ))
          )}
        </Section>

        {blocked.length > 0 && (
          <Section title="Blocked">
            {blocked.map((b) => (
              <Row
                key={b.userId}
                name={b.displayName ?? b.phone ?? "Convo user"}
                detail={`blocked ${relativeTime(b.blockedAt)} ago`}
                muted
                onPress={() => void unblock(b.userId)}
              />
            ))}
          </Section>
        )}
      </ScrollView>
    </View>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
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

function Empty({ palette, text }: { palette: ReturnType<typeof usePalette>; text: string }) {
  return <Text style={{ fontSize: 13, color: palette.textFaint, paddingVertical: spacing.sm }}>{text}</Text>;
}

function Row({
  name,
  detail,
  muted,
  onPress,
  onLongPress,
  onEdit,
  onDelete,
}: {
  name: string;
  detail?: string;
  muted?: boolean;
  onPress: () => void;
  onLongPress?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const palette = usePalette();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
      <Pressable
        onPress={onPress}
        onLongPress={onLongPress}
        delayLongPress={280}
        style={({ pressed }) => ({
          flex: 1,
          minWidth: 0,
          flexDirection: "row",
          alignItems: "center",
          gap: spacing.md,
          paddingVertical: 10,
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <Avatar initial={avatarInitial(name)} size={38} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: "700", color: muted ? palette.textMuted : palette.text }}>
            {name}
          </Text>
          {detail && (
            <Text numberOfLines={1} style={{ fontSize: 12, color: palette.textFaint }}>
              {detail}
            </Text>
          )}
        </View>
      </Pressable>
      {onEdit && (
        <Pressable onPress={onEdit} hitSlop={8}>
          <Text style={{ fontSize: 13, fontWeight: "700", color: colors.iris600 }}>Edit</Text>
        </Pressable>
      )}
      {onDelete && (
        <Pressable onPress={onDelete} hitSlop={8}>
          <Text style={{ fontSize: 13, fontWeight: "700", color: colors.danger }}>Delete</Text>
        </Pressable>
      )}
    </View>
  );
}
