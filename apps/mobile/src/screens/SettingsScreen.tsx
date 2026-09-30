import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { Account, MediaAutoDownload } from "@convo/shared";
import { api, ApiRequestError } from "../api";
import { PrivacySection, SecuritySection } from "../components/PrivacySecurity";
import { Button, CardBox, Heading, Muted, Screen, TextField, usePalette } from "../components/ui";
import { colors, radius, spacing } from "../theme";

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
  const [savingPref, setSavingPref] = useState<MediaAutoDownload | null>(null);
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
            Storage &amp; data
          </Text>
          <Text style={{ fontSize: 13, color: palette.textMuted }}>Media auto-download</Text>
          <View style={{ flexDirection: "row", gap: spacing.sm }}>
            {([
              { value: "ALWAYS", label: "Always" },
              { value: "WIFI_ONLY", label: "Wi-Fi only" },
            ] as const).map((option) => {
              const active = (account.mediaAutoDownload ?? "ALWAYS") === option.value;
              return (
                <Pressable
                  key={option.value}
                  disabled={savingPref !== null}
                  onPress={() => {
                    if (active) return;
                    setSavingPref(option.value);
                    api
                      .updateProfile({ mediaAutoDownload: option.value })
                      .then(onAccountUpdated)
                      .catch(() => {})
                      .finally(() => setSavingPref(null));
                  }}
                  style={{
                    flex: 1,
                    borderRadius: radius.field,
                    borderWidth: 1,
                    paddingVertical: 10,
                    alignItems: "center",
                    borderColor: active ? colors.iris500 : palette.border,
                    backgroundColor: active ? colors.iris100 : "transparent",
                    opacity: savingPref !== null && !active ? 0.5 : 1,
                  }}
                >
                  <Text style={{ fontSize: 13, fontWeight: "800", color: active ? colors.iris700 : palette.textMuted }}>
                    {savingPref === option.value ? "Saving…" : option.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <Muted palette={palette}>
            Wi-Fi only holds back videos and voice notes on mobile data until you tap to download them.
          </Muted>
        </CardBox>

        <PrivacySection account={account} onAccountUpdated={onAccountUpdated} />

        <SecuritySection
          account={account}
          onAccountUpdated={onAccountUpdated}
          onSignedOut={onSignedOut}
        />

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
