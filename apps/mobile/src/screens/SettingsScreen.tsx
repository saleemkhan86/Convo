import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import type { Account } from "@convo/shared";
import { api, ApiRequestError } from "../api";
import { Button, CardBox, Heading, Muted, Screen, TextField, usePalette } from "../components/ui";
import { colors, spacing } from "../theme";

export function SettingsScreen({
  account,
  onBack,
  onAccountUpdated,
  onConnect,
  onSignedOut,
}: {
  account: Account;
  onBack: () => void;
  onAccountUpdated: (a: Account) => void;
  onConnect: (channel: "email" | "phone") => void;
  onSignedOut: () => void;
}) {
  const palette = usePalette();
  const [displayName, setDisplayName] = useState(account.displayName ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const saveProfile = async () => {
    setSaving(true);
    setError(null);
    try {
      onAccountUpdated(await api.updateProfileMobile(displayName.trim() || null));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen palette={palette}>
      <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}>
        <View style={{ gap: spacing.sm }}>
          <Button label="← Back" variant="ghost" onPress={onBack} />
          <Heading palette={palette}>Settings</Heading>
        </View>

        <CardBox palette={palette}>
          <Text style={{ fontSize: 12, fontWeight: "700", color: palette.textFaint, textTransform: "uppercase", letterSpacing: 1 }}>
            Account
          </Text>
          <IdentityRow
            palette={palette}
            label="Phone Number"
            value={account.phone?.phone}
            connectLabel="Connect Phone Number"
            onConnect={() => onConnect("phone")}
            footnote={account.phone ? "Chats enabled" : undefined}
          />
          <IdentityRow
            palette={palette}
            label="Email"
            value={account.email?.email}
            connectLabel="Connect Email"
            onConnect={() => onConnect("email")}
            footnote={account.email ? "Mail enabled" : undefined}
          />
          <View style={{ flexDirection: "row", gap: spacing.md }}>
            <Capability enabled={account.capabilities.chats} label="Chats enabled" palette={palette} />
            <Capability enabled={account.capabilities.mail} label="Mail enabled" palette={palette} />
          </View>
        </CardBox>

        <CardBox palette={palette}>
          <Text style={{ fontSize: 12, fontWeight: "700", color: palette.textFaint, textTransform: "uppercase", letterSpacing: 1 }}>
            Profile
          </Text>
          <TextField label="Display name" value={displayName} onChangeText={setDisplayName} placeholder="How contacts see you" error={error} palette={palette} />
          <Button label="Save profile" onPress={() => void saveProfile()} loading={saving} variant="secondary" />
        </CardBox>

        <CardBox palette={palette}>
          <Text style={{ fontSize: 12, fontWeight: "700", color: palette.textFaint, textTransform: "uppercase", letterSpacing: 1 }}>
            Session
          </Text>
          <Muted palette={palette}>You can sign back in with any connected identity.</Muted>
          <Button
            label="Sign out"
            variant="danger"
            onPress={() => {
              void api.signOut().then(onSignedOut);
            }}
          />
        </CardBox>
      </ScrollView>
    </Screen>
  );
}

function IdentityRow({
  palette,
  label,
  value,
  connectLabel,
  onConnect,
  footnote,
}: {
  palette: ReturnType<typeof usePalette>;
  label: string;
  value?: string | null;
  connectLabel: string;
  onConnect: () => void;
  footnote?: string;
}) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ fontSize: 12, fontWeight: "600", color: palette.textMuted }}>{label}</Text>
      {value ? (
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <Text style={{ fontSize: 15, fontWeight: "700", color: palette.text }}>{value}</Text>
          <View style={{ backgroundColor: colors.success + "22", borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 }}>
            <Text style={{ color: colors.success, fontSize: 12, fontWeight: "700" }}>✓ Verified</Text>
          </View>
        </View>
      ) : (
        <View style={{ gap: spacing.sm }}>
          <Text style={{ fontSize: 14, color: palette.textFaint }}>Not connected</Text>
          <Button label={connectLabel} variant="secondary" onPress={onConnect} />
        </View>
      )}
      {footnote && <Text style={{ fontSize: 12, color: colors.success }}>✓ {footnote}</Text>}
    </View>
  );
}

function Capability({ enabled, label, palette }: { enabled: boolean; label: string; palette: ReturnType<typeof usePalette> }) {
  return (
    <Text style={{ fontSize: 13, fontWeight: "600", color: enabled ? colors.success : palette.textFaint }}>
      {enabled ? "✓" : "○"} {label}
    </Text>
  );
}
