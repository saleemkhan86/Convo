import { useCallback, useEffect, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from "react-native";
import type { GroupSummary } from "@convo/shared";
import { api } from "../api";
import { avatarInitial, errorMessage } from "../chatUtils";
import { Avatar, Button, TextField, usePalette } from "../components/ui";
import { colors, radius, spacing } from "../theme";

type Tab = "create" | "join" | "discover";

/** Create a group, join with an invite code, or browse public groups. */
export function GroupDirectoryScreen({
  onBack,
  onOpenGroup,
}: {
  onBack: () => void;
  onOpenGroup: (conversationId: string) => void;
}) {
  const palette = usePalette();
  const [tab, setTab] = useState<Tab>("create");

  return (
    <View style={{ flex: 1, backgroundColor: palette.bg }}>
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
        <Text style={{ fontSize: 16, fontWeight: "800", color: palette.text }}>Groups</Text>
      </View>

      <View style={{ flexDirection: "row", gap: spacing.sm, padding: spacing.lg, paddingBottom: spacing.md }}>
        {(["create", "join", "discover"] as Tab[]).map((key) => (
          <Pressable
            key={key}
            onPress={() => setTab(key)}
            style={{
              flex: 1,
              paddingVertical: 9,
              borderRadius: radius.pill,
              alignItems: "center",
              backgroundColor: tab === key ? colors.iris600 : palette.surface,
              borderWidth: 1,
              borderColor: tab === key ? colors.iris600 : palette.border,
            }}
          >
            <Text style={{ fontSize: 12, fontWeight: "700", color: tab === key ? colors.white : palette.text }}>
              {key === "create" ? "Create" : key === "join" ? "Join code" : "Discover"}
            </Text>
          </Pressable>
        ))}
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: spacing.lg, paddingTop: spacing.sm, gap: spacing.md }}
        keyboardShouldPersistTaps="handled"
      >
        {tab === "create" && <CreateTab onOpenGroup={onOpenGroup} />}
        {tab === "join" && <JoinTab onOpenGroup={onOpenGroup} />}
        {tab === "discover" && <DiscoverTab onOpenGroup={onOpenGroup} />}
      </ScrollView>
    </View>
  );
}

function CreateTab({ onOpenGroup }: { onOpenGroup: (id: string) => void }) {
  const palette = usePalette();
  const [name, setName] = useState("");
  const [about, setAbout] = useState("");
  const [phones, setPhones] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const list = phones
        .split(/[\s,;]+/)
        .map((p) => p.trim())
        .filter((p) => p.startsWith("+"));
      const detail = await api.createGroup({
        name: name.trim(),
        about: about.trim() || undefined,
        visibility: isPublic ? "PUBLIC" : "PRIVATE",
        phones: list,
      });
      onOpenGroup(detail.conversationId);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ gap: spacing.md }}>
      <TextField label="Group name" value={name} onChangeText={setName} placeholder="Weekend trip crew" palette={palette} error={error} autoFocus />
      <TextField
        label="Description (optional)"
        value={about}
        onChangeText={setAbout}
        placeholder="What is this group about?"
        palette={palette}
      />
      <TextField
        label="Add people by phone (optional)"
        value={phones}
        onChangeText={setPhones}
        placeholder="+15551234567, +15559876543"
        keyboardType="phone-pad"
        palette={palette}
      />
      <Text style={{ fontSize: 12, color: palette.textFaint, marginTop: -6 }}>
        Separate numbers with commas. Unknown numbers are skipped, so nobody is ever revealed by a failed lookup.
      </Text>
      <Pressable
        onPress={() => setIsPublic((v) => !v)}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: spacing.sm,
          borderRadius: radius.field,
          borderWidth: 1,
          borderColor: isPublic ? colors.iris500 : palette.border,
          backgroundColor: isPublic ? colors.iris100 : palette.surface,
          padding: spacing.md,
        }}
      >
        <View
          style={{
            width: 18,
            height: 18,
            borderRadius: 5,
            borderWidth: 2,
            borderColor: isPublic ? colors.iris600 : palette.border,
            backgroundColor: isPublic ? colors.iris600 : "transparent",
          }}
        />
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 14, fontWeight: "700", color: palette.text }}>Public group</Text>
          <Text style={{ fontSize: 12, color: palette.textMuted }}>
            Anyone with the link can join instantly. Private groups need an admin approval.
          </Text>
        </View>
      </Pressable>
      <Button label="Create group" loading={busy} disabled={name.trim().length === 0} onPress={() => void submit()} />
    </KeyboardAvoidingView>
  );
}

function JoinTab({ onOpenGroup }: { onOpenGroup: (id: string) => void }) {
  const palette = usePalette();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const detail = await api.joinByCode(code.trim());
      onOpenGroup(detail.conversationId);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ gap: spacing.md }}>
      <TextField
        label="Invite code"
        value={code}
        onChangeText={setCode}
        placeholder="Paste the code from your invite link"
        palette={palette}
        error={error}
      />
      <Text style={{ fontSize: 12, color: palette.textFaint, marginTop: -6 }}>
        Private groups with approval on send a join request to the admins instead of letting you in.
      </Text>
      <Button label="Join group" loading={busy} disabled={code.trim().length < 8} onPress={() => void submit()} />
    </KeyboardAvoidingView>
  );
}

function DiscoverTab({ onOpenGroup }: { onOpenGroup: (id: string) => void }) {
  const palette = usePalette();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<GroupSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  const search = useCallback(async () => {
    if (!q.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setResults((await api.discoverGroups(q.trim())).groups);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [q]);

  const join = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      const { pending } = await api.applyToGroup(id);
      setApplied((prev) => ({ ...prev, [id]: true }));
      if (!pending) onOpenGroup(id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ gap: spacing.md }}>
      <View style={{ flexDirection: "row", gap: spacing.sm, alignItems: "flex-end" }}>
        <View style={{ flex: 1 }}>
          <TextField label="Search public groups" value={q} onChangeText={setQ} placeholder="team, neighbours…" palette={palette} />
        </View>
        <Pressable
          onPress={() => void search()}
          disabled={busy}
          style={{ backgroundColor: colors.iris600, borderRadius: radius.pill, paddingHorizontal: 18, paddingVertical: 13 }}
        >
          <Text style={{ color: colors.white, fontWeight: "800", fontSize: 14 }}>Go</Text>
        </Pressable>
      </View>
      {error && <Text style={{ fontSize: 13, color: colors.danger }}>{error}</Text>}
      {results.length === 0 && !busy && (
        <Text style={{ fontSize: 13, color: palette.textFaint }}>No public groups found yet.</Text>
      )}
      {results.map((group) => (
        <View
          key={group.conversationId}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: spacing.md,
            borderRadius: radius.card,
            borderWidth: 1,
            borderColor: palette.border,
            backgroundColor: palette.surface,
            padding: spacing.md,
          }}
        >
          <Avatar initial={avatarInitial(group.name)} size={44} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: "700", color: palette.text }}>
              {group.name}
            </Text>
            <Text numberOfLines={1} style={{ fontSize: 12, color: palette.textMuted }}>
              {group.memberCount} members{group.about ? ` · ${group.about}` : ""}
            </Text>
          </View>
          <Pressable
            onPress={() => void join(group.conversationId)}
            disabled={busy}
            style={{
              borderRadius: radius.pill,
              paddingHorizontal: 14,
              paddingVertical: 8,
              backgroundColor: applied[group.conversationId] ? colors.success : colors.iris600,
            }}
          >
            <Text style={{ color: colors.white, fontSize: 12, fontWeight: "800" }}>
              {applied[group.conversationId] ? "Requested" : "Join"}
            </Text>
          </Pressable>
        </View>
      ))}
    </KeyboardAvoidingView>
  );
}
