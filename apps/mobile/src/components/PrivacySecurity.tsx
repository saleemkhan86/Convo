import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Pressable, Switch, Text, View } from "react-native";
import type {
  Account,
  Contact,
  DeviceInfo,
  GroupAddVisibility,
  ProfileVisibility,
  SessionInfo,
  UpdateProfileRequest,
} from "@convo/shared";
import { api, ApiRequestError } from "../api";
import { Button, CardBox, Muted, TextField, usePalette } from "./ui";
import { colors, radius, spacing } from "../theme";

/**
 * Phase 5C settings on mobile: per-field profile privacy, chat privacy
 * defaults, two-step verification, active sessions, linked devices and the
 * account-deletion grace window.
 *
 * App lock is web-only for now — React Native has no SubtleCrypto, so the
 * device cannot hash its own lock PIN before sending it (see docs/TODO.md).
 */

const VISIBILITY_OPTIONS: Array<[ProfileVisibility, string]> = [
  ["EVERYONE", "Everyone"],
  ["CONTACTS", "Contacts"],
  ["CONTACTS_EXCEPT", "Except…"],
  ["NONE", "Nobody"],
];

const GROUP_ADD_OPTIONS: Array<[GroupAddVisibility, string]> = [
  ["EVERYONE", "Everyone"],
  ["CONTACTS", "My contacts"],
  ["NOBODY", "Nobody"],
];

const EPHEMERAL_OPTIONS: Array<[number, string]> = [
  [0, "Off"],
  [86_400, "24h"],
  [7 * 86_400, "7d"],
  [90 * 86_400, "90d"],
];

export function PrivacySection({
  account,
  onAccountUpdated,
}: {
  account: Account;
  onAccountUpdated: (a: Account) => void;
}) {
  const palette = usePalette();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [busyField, setBusyField] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.listContacts().then((r) => setContacts(r.contacts)).catch(() => {});
  }, []);

  const patch = async (field: string, body: UpdateProfileRequest) => {
    setBusyField(field);
    setError(null);
    try {
      onAccountUpdated(await api.updateProfile(body));
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusyField(null);
    }
  };

  const excluded = new Set(account.visibilityExcluded ?? []);
  const showExclusions =
    account.avatarVisibility === "CONTACTS_EXCEPT" ||
    account.aboutVisibility === "CONTACTS_EXCEPT" ||
    account.onlineVisibility === "CONTACTS_EXCEPT";

  const toggleExcluded = (userId: string) => {
    const next = new Set(excluded);
    if (next.has(userId)) next.delete(userId);
    else next.add(userId);
    void patch("excluded", { visibilityExcluded: [...next] });
  };

  return (
    <CardBox palette={palette}>
      <SectionLabel palette={palette}>Privacy</SectionLabel>
      {error && <Text style={{ fontSize: 13, color: colors.danger }}>{error}</Text>}

      <ChoiceRow
        label="Profile photo"
        hint="Who can see your profile photo."
        options={VISIBILITY_OPTIONS}
        value={account.avatarVisibility ?? "EVERYONE"}
        busy={busyField === "avatar"}
        onChange={(v) => void patch("avatar", { avatarVisibility: v })}
      />
      <ChoiceRow
        label="About"
        hint="Who can read your about line."
        options={VISIBILITY_OPTIONS}
        value={account.aboutVisibility ?? "EVERYONE"}
        busy={busyField === "about"}
        onChange={(v) => void patch("about", { aboutVisibility: v })}
      />
      <ChoiceRow
        label="Last seen & online"
        hint="Hiding this removes both the online dot and your last-seen time."
        options={VISIBILITY_OPTIONS}
        value={account.onlineVisibility ?? "EVERYONE"}
        busy={busyField === "online"}
        onChange={(v) => void patch("online", { onlineVisibility: v })}
      />

      {showExclusions && (
        <View style={{ gap: 6 }}>
          <Text style={{ fontSize: 12, fontWeight: "700", color: palette.textFaint }}>
            EXCEPT THESE CONTACTS
          </Text>
          {contacts.length === 0 ? (
            <Muted palette={palette}>
              Your address book is empty — add contacts to build an exception list.
            </Muted>
          ) : (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
              {contacts.map((c) => {
                const id = c.convoUserId ?? c.id;
                const off = excluded.has(id);
                return (
                  <Pressable
                    key={id}
                    disabled={busyField !== null}
                    onPress={() => toggleExcluded(id)}
                    style={{
                      borderRadius: radius.pill,
                      borderWidth: 1,
                      paddingHorizontal: 12,
                      paddingVertical: 6,
                      borderColor: off ? colors.danger : palette.border,
                      backgroundColor: off ? colors.danger + "18" : "transparent",
                      opacity: busyField !== null && !off ? 0.5 : 1,
                    }}
                  >
                    <Text style={{ fontSize: 12, fontWeight: "700", color: off ? colors.danger : palette.textMuted }}>
                      {off ? `✕ ${c.displayName || c.phone}` : c.displayName || c.phone}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          )}
        </View>
      )}

      <ChoiceRow
        label="Who can add me to groups"
        options={GROUP_ADD_OPTIONS}
        value={account.groupAddVisibility ?? "EVERYONE"}
        busy={busyField === "groupAdd"}
        onChange={(v) => void patch("groupAdd", { groupAddVisibility: v })}
      />

      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.md }}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ fontSize: 14, fontWeight: "600", color: palette.text }}>Read receipts</Text>
          <Text style={{ fontSize: 12, color: palette.textFaint }}>
            Turning this off hides blue ticks both ways.
          </Text>
        </View>
        <Switch
          value={account.readReceiptsEnabled ?? true}
          disabled={busyField === "receipts"}
          onValueChange={(v) => void patch("receipts", { readReceiptsEnabled: v })}
        />
      </View>

      <ChoiceRow
        label="Default disappearing messages"
        hint="Applied to new 1-1 chats you start."
        options={EPHEMERAL_OPTIONS}
        value={account.defaultEphemeralSeconds ?? 0}
        busy={busyField === "ephemeral"}
        onChange={(v) => void patch("ephemeral", { defaultEphemeralSeconds: v })}
      />
    </CardBox>
  );
}

export function SecuritySection({
  account,
  onAccountUpdated,
  onSignedOut,
}: {
  account: Account;
  onAccountUpdated: (a: Account) => void;
  onSignedOut: () => void;
}) {
  const palette = usePalette();
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [enrolling, setEnrolling] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null);

  const load = useCallback(() => {
    api.listSessions().then(setSessions).catch(() => setSessions([]));
    api.listDevices().then(setDevices).catch(() => setDevices([]));
  }, []);

  useEffect(load, [load]);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      load();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(null);
    }
  };

  const enable2fa = () => {
    if (pin.length !== 6) {
      setError("Choose a 6-digit PIN.");
      return;
    }
    if (pin !== confirm) {
      setError("The two PINs don't match.");
      return;
    }
    void run("2fa", async () => {
      await api.setTwoFactor(pin);
      onAccountUpdated(await api.me());
      setPin("");
      setConfirm("");
      setEnrolling(false);
    });
  };

  const disable2fa = () => {
    void run("2fa-off", async () => {
      await api.disableTwoFactor();
      onAccountUpdated(await api.me());
    });
  };

  const requestDeletion = () => {
    void run("delete", async () => {
      await api.requestAccountDeletion();
      onAccountUpdated(await api.me());
    });
  };

  return (
    <CardBox palette={palette}>
      <SectionLabel palette={palette}>Security</SectionLabel>
      {error && <Text style={{ fontSize: 13, color: colors.danger }}>{error}</Text>}

      <View style={{ gap: spacing.sm }}>
        <Text style={{ fontSize: 14, fontWeight: "600", color: palette.text }}>Two-step verification</Text>
        <Muted palette={palette}>
          Ask for a 6-digit PIN after the code every time you sign in.
        </Muted>
        {account.twoFactorEnabled ? (
          <Button
            label={busy === "2fa-off" ? "Turning off…" : "Turn off"}
            variant="secondary"
            loading={busy === "2fa-off"}
            onPress={disable2fa}
          />
        ) : enrolling ? (
          <View style={{ gap: spacing.sm }}>
            <TextField
              label="PIN"
              value={pin}
              onChangeText={(v) => setPin(v.replace(/\D/g, "").slice(0, 6))}
              placeholder="000000"
              keyboardType="number-pad"
              secureTextEntry
              palette={palette}
            />
            <TextField
              label="Confirm PIN"
              value={confirm}
              onChangeText={(v) => setConfirm(v.replace(/\D/g, "").slice(0, 6))}
              placeholder="000000"
              keyboardType="number-pad"
              secureTextEntry
              palette={palette}
            />
            <View style={{ flexDirection: "row", gap: spacing.sm }}>
              <View style={{ flex: 1 }}>
                <Button label="Cancel" variant="ghost" onPress={() => { setEnrolling(false); setPin(""); setConfirm(""); }} />
              </View>
              <View style={{ flex: 1 }}>
                <Button label="Turn on" loading={busy === "2fa"} onPress={enable2fa} />
              </View>
            </View>
          </View>
        ) : (
          <Button label="Turn on" variant="secondary" onPress={() => setEnrolling(true)} />
        )}
      </View>

      <View style={{ gap: spacing.sm }}>
        <Text style={{ fontSize: 14, fontWeight: "600", color: palette.text }}>Active sessions</Text>
        {sessions === null ? (
          <Muted palette={palette}>Loading…</Muted>
        ) : sessions.length === 0 ? (
          <Muted palette={palette}>No sessions on record.</Muted>
        ) : (
          sessions.map((s) => (
            <Row key={s.id} palette={palette}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={{ fontSize: 13, fontWeight: "700", color: palette.text }}>
                  {s.deviceInfo ?? "Unknown device"}
                  {s.current ? " · this device" : ""}
                </Text>
                <Text style={{ fontSize: 11, color: palette.textFaint }}>
                  {new Date(s.createdAt).toLocaleDateString()}
                  {s.ip ? ` · ${s.ip}` : ""}
                </Text>
              </View>
              {!s.current && (
                <Pressable
                  disabled={busy !== null}
                  onPress={() => void run(`session:${s.id}`, () => api.revokeSession(s.id))}
                  style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: radius.pill, backgroundColor: palette.raised }}
                >
                  <Text style={{ fontSize: 12, fontWeight: "700", color: colors.danger }}>Log out</Text>
                </Pressable>
              )}
            </Row>
          ))
        )}
        <Button
          label={busy === "revoke-others" ? "Logging out…" : "Log out everywhere else"}
          variant="secondary"
          loading={busy === "revoke-others"}
          onPress={() => void run("revoke-others", () => api.revokeOtherSessions())}
        />
      </View>

      <View style={{ gap: spacing.sm }}>
        <Text style={{ fontSize: 14, fontWeight: "600", color: palette.text }}>Linked devices</Text>
        {devices === null ? (
          <Muted palette={palette}>Loading…</Muted>
        ) : devices.length === 0 ? (
          <Muted palette={palette}>No devices linked.</Muted>
        ) : (
          devices.map((d) => (
            <Row key={d.id} palette={palette}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={{ fontSize: 13, fontWeight: "700", color: palette.text }}>
                  {d.platform}
                  {d.appVersion ? ` · ${d.appVersion}` : ""}
                </Text>
                <Text style={{ fontSize: 11, color: palette.textFaint }}>
                  Last seen {new Date(d.lastSeenAt).toLocaleDateString()}
                </Text>
              </View>
              <Pressable
                disabled={busy !== null}
                onPress={() => void run(`device:${d.id}`, () => api.deleteDevice(d.id))}
                style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: radius.pill, backgroundColor: palette.raised }}
              >
                <Text style={{ fontSize: 12, fontWeight: "700", color: colors.danger }}>Unlink</Text>
              </Pressable>
            </Row>
          ))
        )}
      </View>

      <View style={{ gap: spacing.sm }}>
        <Text style={{ fontSize: 14, fontWeight: "600", color: palette.text }}>Delete account</Text>
        {account.deletionRequestedAt ? (
          <>
            <Muted palette={palette}>
              Your account is scheduled for deletion and will be removed permanently. Signing in during
              the grace window cancels it.
            </Muted>
            <Button
              label={busy === "cancel-delete" ? "Cancelling…" : "Cancel deletion"}
              variant="secondary"
              loading={busy === "cancel-delete"}
              onPress={() => void run("cancel-delete", () => api.cancelAccountDeletion())}
            />
          </>
        ) : (
          <>
            <Muted palette={palette}>
              Starts a 30-day grace window. You can sign back in and cancel until then.
            </Muted>
            <Button
              label={busy === "delete" ? "Requesting…" : "Request deletion"}
              variant="danger"
              loading={busy === "delete"}
              onPress={requestDeletion}
            />
            <Button label="Sign out" variant="ghost" onPress={() => void api.signOut().then(onSignedOut)} />
          </>
        )}
      </View>
    </CardBox>
  );
}

function SectionLabel({ palette, children }: { palette: ReturnType<typeof usePalette>; children: string }) {
  return (
    <Text
      style={{
        fontSize: 12,
        fontWeight: "700",
        color: palette.textFaint,
        textTransform: "uppercase",
        letterSpacing: 1,
      }}
    >
      {children}
    </Text>
  );
}

function Row({ palette, children }: { palette: ReturnType<typeof usePalette>; children: ReactNode }) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: spacing.sm,
        borderRadius: radius.field,
        borderWidth: 1,
        borderColor: palette.border,
        padding: spacing.sm,
      }}
    >
      {children}
    </View>
  );
}

function ChoiceRow<T extends string | number>({
  label,
  hint,
  options,
  value,
  busy,
  onChange,
}: {
  label: string;
  hint?: string;
  options: Array<[T, string]>;
  value: T;
  busy: boolean;
  onChange: (v: T) => void;
}) {
  const palette = usePalette();
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ fontSize: 14, fontWeight: "600", color: palette.text }}>{label}</Text>
      {hint && <Text style={{ fontSize: 12, color: palette.textFaint }}>{hint}</Text>}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
        {options.map(([optionValue, optionLabel]) => {
          const active = optionValue === value;
          return (
            <Pressable
              key={String(optionValue)}
              disabled={busy}
              onPress={() => onChange(optionValue)}
              style={{
                borderRadius: radius.pill,
                borderWidth: 1,
                paddingHorizontal: 12,
                paddingVertical: 8,
                borderColor: active ? colors.iris500 : palette.border,
                backgroundColor: active ? colors.iris100 : "transparent",
                opacity: busy && !active ? 0.5 : 1,
              }}
            >
              <Text style={{ fontSize: 12, fontWeight: "800", color: active ? colors.iris700 : palette.textMuted }}>
                {busy && !active ? optionLabel : optionLabel}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function messageOf(err: unknown): string {
  return err instanceof ApiRequestError ? err.message : "Something went wrong";
}
