import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Image,
  Modal,
  Pressable,
  ScrollView,
  Switch,
  Text,
  View,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import type { GroupDetail, GroupMember, GroupSettings, WsServerEvent } from "@convo/shared";
import { api, resolveMediaUrl } from "../api";
import { useRealtimeEvents } from "../realtime";
import { avatarInitial, errorMessage } from "../chatUtils";
import { Avatar, Button, TextField, usePalette } from "../components/ui";
import { colors, radius, spacing, type Palette } from "../theme";

/** Group info + settings (Phase 4B). Admins see controls members don't. */
export function GroupInfoScreen({
  conversationId,
  selfUserId,
  onBack,
  onLeft,
  onOpenChat,
}: {
  conversationId: string;
  selfUserId: string;
  onBack: () => void;
  onLeft: () => void;
  onOpenChat: () => void;
}) {
  const palette = usePalette();
  const [group, setGroup] = useState<GroupDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [addPhone, setAddPhone] = useState("");
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [aboutDraft, setAboutDraft] = useState<string | null>(null);
  const [exitScope, setExitScope] = useState<"leave" | "delete" | null>(null);

  const load = useCallback(async () => {
    try {
      setGroup(await api.group(conversationId));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [conversationId]);

  useEffect(() => {
    void load();
  }, [load]);

  useRealtimeEvents(
    useCallback(
      (event: WsServerEvent) => {
        if ("conversationId" in event && event.conversationId === conversationId) void load();
      },
      [conversationId, load],
    ),
  );

  const run = async (fn: () => Promise<GroupDetail>) => {
    setBusy(true);
    try {
      setGroup(await fn());
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (patch: Partial<GroupSettings>) => void run(() => api.updateGroup(conversationId, { settings: patch }));

  /** The group icon rides the chat media pipeline: upload bytes, store the key. */
  const pickIcon = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setError("Convo needs photo access to set a group icon.");
      return;
    }
    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      base64: true,
      quality: 82,
      allowsMultipleSelection: false,
    });
    if (picked.canceled) return;
    const asset = picked.assets[0];
    if (!asset?.base64) {
      setError("Could not read the selected photo.");
      return;
    }
    setBusy(true);
    try {
      const uploaded = await api.uploadMediaBase64({
        data: asset.base64,
        mimeType: asset.mimeType ?? "image/jpeg",
        fileName: asset.fileName ?? undefined,
      });
      setGroup(await api.updateGroup(conversationId, { avatarStorageKey: uploaded.storageKey }));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (!group) {
    return (
      <View style={{ flex: 1, backgroundColor: palette.bg, paddingTop: spacing.xl }}>
        <Header palette={palette} title="Group info" onBack={onBack} />
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.md }}>
          {error ? (
            <>
              <Text style={{ color: colors.danger, textAlign: "center", paddingHorizontal: spacing.lg }}>{error}</Text>
              <View style={{ minWidth: 120 }}>
                <Button label="Retry" variant="secondary" onPress={() => void load()} />
              </View>
            </>
          ) : (
            <ActivityIndicator color={colors.iris600} />
          )}
        </View>
      </View>
    );
  }

  const isAdmin = group.myRole === "ADMIN";
  const canEditInfo = isAdmin || group.settings.whoCanEdit === "ALL";
  const avatarUri = resolveMediaUrl(group.avatarUrl);

  return (
    <View style={{ flex: 1, backgroundColor: palette.bg }}>
      <Header palette={palette} title="Group info" onBack={onBack} />
      <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}>
        <View style={{ alignItems: "center", gap: spacing.sm }}>
          {avatarUri ? (
            <Image source={{ uri: avatarUri }} style={{ width: 72, height: 72, borderRadius: 36 }} />
          ) : (
            <Avatar initial={avatarInitial(group.name)} size={72} />
          )}
          {canEditInfo && (
            <View style={{ flexDirection: "row", gap: spacing.md }}>
              <Pressable onPress={() => void pickIcon()} disabled={busy} hitSlop={8}>
                <Text style={{ fontSize: 13, fontWeight: "700", color: colors.iris600 }}>
                  {avatarUri ? "Change icon" : "Add icon"}
                </Text>
              </Pressable>
              {avatarUri && (
                <Pressable
                  onPress={() => void run(() => api.updateGroup(conversationId, { avatarStorageKey: null }))}
                  disabled={busy}
                  hitSlop={8}
                >
                  <Text style={{ fontSize: 13, fontWeight: "700", color: palette.textFaint }}>Remove</Text>
                </Pressable>
              )}
            </View>
          )}
          {nameDraft === null ? (
            <Text selectable style={{ fontSize: 20, fontWeight: "800", color: palette.text }}>{group.name}</Text>
          ) : (
            <View style={{ width: "100%", gap: spacing.sm }}>
              <TextField
                label="Group name"
                value={nameDraft}
                onChangeText={setNameDraft}
                autoFocus
                palette={palette}
              />
              <View style={{ flexDirection: "row", gap: spacing.sm }}>
                <View style={{ flex: 1 }}>
                  <Button label="Cancel" variant="secondary" onPress={() => setNameDraft(null)} />
                </View>
                <View style={{ flex: 1 }}>
                  <Button
                    label="Save"
                    loading={busy}
                    disabled={!nameDraft.trim()}
                    onPress={() => {
                      const next = nameDraft.trim();
                      setNameDraft(null);
                      void run(() => api.updateGroup(conversationId, { name: next }));
                    }}
                  />
                </View>
              </View>
            </View>
          )}
          <Text style={{ fontSize: 13, color: palette.textFaint }}>{group.memberCount} members</Text>
          {aboutDraft === null ? (
            group.about ? (
              <Text style={{ fontSize: 13, color: palette.textMuted, textAlign: "center" }}>{group.about}</Text>
            ) : null
          ) : (
            <View style={{ width: "100%", gap: spacing.sm }}>
              <TextField
                label="Description"
                value={aboutDraft}
                onChangeText={setAboutDraft}
                placeholder="What is this group about?"
                autoFocus
                palette={palette}
              />
              <View style={{ flexDirection: "row", gap: spacing.sm }}>
                <View style={{ flex: 1 }}>
                  <Button label="Cancel" variant="secondary" onPress={() => setAboutDraft(null)} />
                </View>
                <View style={{ flex: 1 }}>
                  <Button
                    label="Save"
                    loading={busy}
                    onPress={() => {
                      const next = aboutDraft.trim();
                      setAboutDraft(null);
                      void run(() => api.updateGroup(conversationId, { about: next || null }));
                    }}
                  />
                </View>
              </View>
            </View>
          )}
          {canEditInfo && nameDraft === null && aboutDraft === null && (
            <View style={{ flexDirection: "row", gap: spacing.md }}>
              <Pressable onPress={() => setNameDraft(group.name)} hitSlop={8}>
                <Text style={{ fontSize: 13, fontWeight: "700", color: colors.iris600 }}>Rename group</Text>
              </Pressable>
              <Pressable onPress={() => setAboutDraft(group.about ?? "")} hitSlop={8}>
                <Text style={{ fontSize: 13, fontWeight: "700", color: colors.iris600 }}>
                  {group.about ? "Edit description" : "Add description"}
                </Text>
              </Pressable>
            </View>
          )}
          <Pressable onPress={onOpenChat} hitSlop={8}>
            <Text style={{ fontSize: 13, fontWeight: "700", color: colors.iris600 }}>Open chat</Text>
          </Pressable>
        </View>

        <Card palette={palette} title="Group type">
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.md }}>
            <Text style={{ fontSize: 14, color: palette.text }}>
              {group.settings.visibility === "PUBLIC" ? "Public group" : "Private group"}
            </Text>
            {isAdmin && (
              <Switch
                value={group.settings.visibility === "PUBLIC"}
                onValueChange={(v) => toggle({ visibility: v ? "PUBLIC" : "PRIVATE" })}
                trackColor={{ false: palette.border, true: colors.iris100 }}
                thumbColor={group.settings.visibility === "PUBLIC" ? colors.iris600 : palette.surface}
              />
            )}
          </View>
          <Text style={{ fontSize: 12, color: palette.textFaint, lineHeight: 18 }}>
            {group.settings.visibility === "PUBLIC"
              ? "Anyone with the link or a search result can join instantly."
              : "People need an admin invite, or an admin must approve their join request."}
          </Text>
        </Card>

        {isAdmin && (
          <Card palette={palette} title="Group permissions">
            <SettingRow
              label="Only admins can send messages"
              hint="Announcement group"
              value={group.settings.announceOnly}
              onValueChange={(v) => toggle({ announceOnly: v, whoCanSend: v ? "ADMINS" : "ALL" })}
              palette={palette}
            />
            <SettingRow
              label="Only admins can edit group info"
              hint="Name, description, settings"
              value={group.settings.whoCanEdit === "ADMINS"}
              onValueChange={(v) => toggle({ whoCanEdit: v ? "ADMINS" : "ALL" })}
              palette={palette}
            />
            <SettingRow
              label="Only admins can share the invite link"
              hint="Members won't see the link"
              value={group.settings.whoCanInvite === "ADMINS"}
              onValueChange={(v) => toggle({ whoCanInvite: v ? "ADMINS" : "ALL" })}
              palette={palette}
            />
            <SettingRow
              label="Require approval for join requests"
              hint="Admins approve or decline each request"
              value={group.settings.requireApproval}
              onValueChange={(v) => toggle({ requireApproval: v })}
              palette={palette}
            />
          </Card>
        )}

        {group.inviteCode && (
          <Card palette={palette} title="Invite link">
            <Text selectable style={{ fontSize: 13, color: palette.text, fontFamily: "monospace" }}>
              {"convo://group/"}
              {group.inviteCode}
            </Text>
            <Text style={{ fontSize: 11, color: palette.textFaint }}>Tap the link to select and copy it.</Text>
            {isAdmin && (
              <Button label="Revoke current link" variant="secondary" loading={busy} onPress={() => void run(() => api.revokeInvite(conversationId))} />
            )}
          </Card>
        )}

        {isAdmin && group.joinRequests.length > 0 && (
          <Card palette={palette} title={`Join requests (${group.joinRequests.length})`}>
            {group.joinRequests.map((member) => (
              <View key={member.userId} style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                <Avatar initial={avatarInitial(memberName(member))} size={36} />
                <Text numberOfLines={1} style={{ flex: 1, fontSize: 14, color: palette.text }}>
                  {memberName(member)}
                </Text>
                <Pressable
                  onPress={() => void run(() => api.approveJoinRequest(conversationId, member.userId))}
                  style={{ backgroundColor: colors.iris600, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 6 }}
                >
                  <Text style={{ color: colors.white, fontSize: 12, fontWeight: "800" }}>Approve</Text>
                </Pressable>
                <Pressable
                  onPress={() => void run(() => api.rejectJoinRequest(conversationId, member.userId))}
                  hitSlop={6}
                >
                  <Text style={{ color: palette.textFaint, fontSize: 18 }}>×</Text>
                </Pressable>
              </View>
            ))}
          </Card>
        )}

        <Card palette={palette} title={`Members (${group.members.length})`}>
          {canEditInfo && (
            <View style={{ flexDirection: "row", gap: spacing.sm, alignItems: "flex-end" }}>
              <View style={{ flex: 1 }}>
                <TextField
                  value={addPhone}
                  onChangeText={setAddPhone}
                  placeholder="+15551234567"
                  keyboardType="phone-pad"
                  palette={palette}
                />
              </View>
              <Pressable
                onPress={() => {
                  const phone = addPhone.trim();
                  if (!phone.startsWith("+")) return;
                  setAddPhone("");
                  void run(() => api.addGroupMembers(conversationId, [phone]));
                }}
                style={{
                  backgroundColor: colors.iris600,
                  borderRadius: radius.pill,
                  paddingHorizontal: 16,
                  paddingVertical: 13,
                }}
              >
                <Text style={{ color: colors.white, fontWeight: "800", fontSize: 14 }}>Add</Text>
              </Pressable>
            </View>
          )}
          {group.members.map((member) => (
            <MemberRow
              key={member.userId}
              member={member}
              self={member.userId === selfUserId}
              canManage={isAdmin && member.userId !== selfUserId}
              busy={busy}
              palette={palette}
              onPromote={() => void run(() => api.promoteMember(conversationId, member.userId))}
              onDemote={() => void run(() => api.demoteMember(conversationId, member.userId))}
              onRemove={() => void run(() => api.removeGroupMember(conversationId, member.userId))}
            />
          ))}
        </Card>

        <View style={{ gap: spacing.sm }}>
          <Button label="Exit group" variant="secondary" onPress={() => setExitScope("leave")} />
          {isAdmin && <Button label="Delete group" variant="danger" onPress={() => setExitScope("delete")} />}
        </View>
        {error && <Text style={{ fontSize: 13, color: colors.danger }}>{error}</Text>}
      </ScrollView>

      <Modal visible={exitScope !== null} transparent animationType="fade" onRequestClose={() => setExitScope(null)}>
        <Pressable style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.45)", alignItems: "center", justifyContent: "center" }} onPress={() => setExitScope(null)}>
          <Pressable
            onPress={(e) => e.stopPropagation()}
            style={{ backgroundColor: palette.surface, borderRadius: radius.card, padding: spacing.lg, gap: spacing.md, width: "82%" }}
          >
            <Text style={{ fontSize: 16, fontWeight: "800", color: palette.text }}>
              {exitScope === "delete" ? "Delete this group for everyone?" : "Leave the group?"}
            </Text>
            <Text style={{ fontSize: 13, color: palette.textMuted }}>
              {exitScope === "delete"
                ? "The group and all of its messages are removed for every member."
                : "You can rejoin later with an invite link or an approved request."}
            </Text>
            <Button
              label={exitScope === "delete" ? "Delete group" : "Leave"}
              variant={exitScope === "delete" ? "danger" : "primary"}
              loading={busy}
              onPress={() => {
                const action = exitScope;
                setExitScope(null);
                if (action === "delete") void destroy();
                else void leave();
              }}
            />
            <Button label="Cancel" variant="ghost" onPress={() => setExitScope(null)} />
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );

  async function leave() {
    setBusy(true);
    await api.leaveGroup(conversationId).catch(() => {});
    setBusy(false);
    onLeft();
  }

  async function destroy() {
    setBusy(true);
    await api.deleteGroup(conversationId).catch(() => {});
    setBusy(false);
    onLeft();
  }
}

function Header({ title, onBack, palette }: { title: string; onBack: () => void; palette: Palette }) {
  return (
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
      <Text style={{ fontSize: 16, fontWeight: "800", color: palette.text }}>{title}</Text>
    </View>
  );
}

function Card({ title, children, palette }: { title: string; children: ReactNode; palette: Palette }) {
  return (
    <View style={{ backgroundColor: palette.surface, borderColor: palette.border, borderWidth: 1, borderRadius: radius.card, padding: spacing.md, gap: spacing.md }}>
      <Text style={{ fontSize: 11, fontWeight: "800", letterSpacing: 0.6, color: palette.textFaint, textTransform: "uppercase" }}>
        {title}
      </Text>
      {children}
    </View>
  );
}

function SettingRow({
  label,
  hint,
  value,
  onValueChange,
  palette,
}: {
  label: string;
  hint: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  palette: Palette;
}) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.md }}>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 14, color: palette.text }}>{label}</Text>
        <Text style={{ fontSize: 11, color: palette.textFaint }}>{hint}</Text>
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        trackColor={{ false: palette.border, true: colors.iris100 }}
        thumbColor={value ? colors.iris600 : palette.surface}
      />
    </View>
  );
}

function MemberRow({
  member,
  self,
  canManage,
  busy,
  palette,
  onPromote,
  onDemote,
  onRemove,
}: {
  member: GroupMember;
  self: boolean;
  canManage: boolean;
  busy: boolean;
  palette: Palette;
  onPromote: () => void;
  onDemote: () => void;
  onRemove: () => void;
}) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
      <Avatar initial={avatarInitial(memberName(member))} size={36} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ fontSize: 14, color: palette.text }}>
          {memberName(member)}
          {self && <Text style={{ color: palette.textFaint }}>  (you)</Text>}
        </Text>
        {member.role === "ADMIN" && (
          <Text style={{ fontSize: 11, fontWeight: "700", color: colors.iris600 }}>Admin</Text>
        )}
      </View>
      {canManage && (
        <View style={{ flexDirection: "row", gap: spacing.md }}>
          <Pressable onPress={member.role === "ADMIN" ? onDemote : onPromote} disabled={busy} hitSlop={6}>
            <Text style={{ fontSize: 12, fontWeight: "700", color: colors.iris600 }}>
              {member.role === "ADMIN" ? "Demote" : "Make admin"}
            </Text>
          </Pressable>
          <Pressable onPress={onRemove} disabled={busy} hitSlop={6}>
            <Text style={{ fontSize: 12, fontWeight: "700", color: colors.danger }}>Remove</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

function memberName(member: GroupMember): string {
  return member.displayName ?? member.phone ?? "Convo user";
}
