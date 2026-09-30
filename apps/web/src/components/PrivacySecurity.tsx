import { useCallback, useEffect, useState } from "react";
import type { Contact, DeviceInfo, GroupAddVisibility, ProfileVisibility, SessionInfo } from "@convo/shared";
import { ApiRequestError, api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Button, Card, Input, cx } from "./ui";

/**
 * Phase 5C settings: per-field profile privacy, chat privacy defaults, app
 * lock, two-step verification, active sessions, linked devices and the
 * account-deletion grace window. Every rule is stored server-side — these
 * panels read back exactly what the API applies.
 */

const VISIBILITY_OPTIONS: Array<[ProfileVisibility, string]> = [
  ["EVERYONE", "Everyone"],
  ["CONTACTS", "My contacts"],
  ["CONTACTS_EXCEPT", "My contacts except…"],
  ["NONE", "Nobody"],
];

const EPHEMERAL_OPTIONS = [
  [0, "Off"],
  [86_400, "24 hours"],
  [7 * 86_400, "7 days"],
  [90 * 86_400, "90 days"],
] as const;

export function PrivacySection() {
  const { account, setAccount } = useAuth();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.listContacts().then((res) => setContacts(res.contacts)).catch(() => {});
  }, []);

  if (!account) return null;

  const patch = async (body: Parameters<typeof api.updateProfile>[0]) => {
    setBusy(true);
    setError(null);
    try {
      setAccount(await api.updateProfile(body));
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
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
    void patch({ visibilityExcluded: [...next] });
  };

  return (
    <Card className="space-y-6">
      <Setting label="Profile photo" hint="Who can see your profile photo.">
        <ChoiceRow
          disabled={busy}
          options={VISIBILITY_OPTIONS}
          value={account.avatarVisibility ?? "EVERYONE"}
          onChange={(v) => void patch({ avatarVisibility: v })}
        />
      </Setting>

      <Setting label="About" hint="Who can read your about line.">
        <ChoiceRow
          disabled={busy}
          options={VISIBILITY_OPTIONS}
          value={account.aboutVisibility ?? "EVERYONE"}
          onChange={(v) => void patch({ aboutVisibility: v })}
        />
      </Setting>

      <Setting label="Last seen & online" hint="Hiding this removes both the online dot and your last-seen time.">
        <ChoiceRow
          disabled={busy}
          options={VISIBILITY_OPTIONS}
          value={account.onlineVisibility ?? "EVERYONE"}
          onChange={(v) => void patch({ onlineVisibility: v })}
        />
      </Setting>

      {showExclusions && (
        <div className="rounded-card bg-ink-50 p-4 dark:bg-night-raised">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">Except these contacts</p>
          {contacts.length === 0 ? (
            <p className="mt-2 text-sm text-ink-500 dark:text-ink-400">
              Your address book is empty — add contacts to build an exception list.
            </p>
          ) : (
            <div className="mt-2 flex flex-wrap gap-2">
              {contacts.map((c) => (
                <button
                  key={c.id}
                  disabled={busy}
                  onClick={() => toggleExcluded(c.convoUserId ?? c.id)}
                  className={cx(
                    "rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors",
                    excluded.has(c.convoUserId ?? c.id)
                      ? "border-red-300 bg-red-50 text-red-700 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-300"
                      : "border-ink-200 text-ink-500 dark:border-night-border dark:text-ink-400",
                  )}
                >
                  {c.displayName || c.phone}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <Setting label="Groups" hint="Who can add you to a group. People you hide from are skipped silently.">
        <ChoiceRow<GroupAddVisibility>
          disabled={busy}
          options={[
            ["EVERYONE", "Everyone"],
            ["CONTACTS", "My contacts"],
            ["NOBODY", "Nobody"],
          ]}
          value={account.groupAddVisibility ?? "EVERYONE"}
          onChange={(v) => void patch({ groupAddVisibility: v })}
        />
      </Setting>

      <Setting label="Read receipts" hint="Turning this off hides your ticks both ways.">
        <Toggle
          disabled={busy}
          on={account.readReceiptsEnabled ?? true}
          onChange={(on) => void patch({ readReceiptsEnabled: on })}
        />
      </Setting>

      <Setting label="Default disappearing messages" hint="New 1-1 chats start with this timer (WhatsApp rule: only when both sides opt in).">
        <ChoiceRow
          disabled={busy}
          options={EPHEMERAL_OPTIONS.map(([v, label]) => [String(v), label])}
          value={String(account.defaultEphemeralSeconds ?? 0)}
          onChange={(v) => void patch({ defaultEphemeralSeconds: Number(v) })}
        />
      </Setting>

      <AppLockSettings />
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
    </Card>
  );
}

/**
 * App lock mirrors onto the account so devices agree, but the PIN is hashed on
 * this browser — the server only ever stores the salted digest.
 */
function AppLockSettings() {
  const { account, setAccount } = useAuth();
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = account?.appLock ?? { enabled: false, biometric: false, timeoutSeconds: 0, pinHash: null, salt: null };

  const save = async (next: typeof lock) => {
    setBusy(true);
    setError(null);
    try {
      setAccount(await api.updateProfile({ appLock: next }));
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const enable = async () => {
    if (!/^\d{4,6}$/.test(pin)) {
      setError("Choose a 4–6 digit PIN");
      return;
    }
    const salt = randomHex(16);
    await save({
      ...lock,
      enabled: true,
      salt,
      pinHash: await sha256Hex(`${salt}:${pin}`),
    });
    setPin("");
  };

  return (
    <div className="space-y-3 border-t border-ink-100 pt-4 dark:border-night-border">
      <Setting label="App lock" hint="Ask for a PIN when Convo resumes from the background.">
        <Toggle disabled={busy} on={lock.enabled} onChange={(on) => void (on ? enable() : save({ ...lock, enabled: false, pinHash: null, salt: null }))} />
      </Setting>
      {lock.enabled && (
        <>
          <Setting label="Biometric unlock" hint="Use the device fingerprint when it is available.">
            <Toggle disabled={busy} on={lock.biometric} onChange={(on) => void save({ ...lock, biometric: on })} />
          </Setting>
          <Setting label="Lock after" hint="Idle time before the PIN is required again.">
            <ChoiceRow
              disabled={busy}
              options={[
                ["0", "Immediately"],
                ["60", "1 minute"],
                ["300", "5 minutes"],
                ["3600", "1 hour"],
              ]}
              value={String(lock.timeoutSeconds)}
              onChange={(v) => void save({ ...lock, timeoutSeconds: Number(v) })}
            />
          </Setting>
        </>
      )}
      {!lock.enabled && (
        <div className="flex items-end gap-3">
          <div className="flex-1">
            <Input
              label="Lock PIN"
              type="password"
              inputMode="numeric"
              value={pin}
              maxLength={6}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
              placeholder="4–6 digits, never leaves this device"
            />
          </div>
          <Button disabled={busy} onClick={() => void enable()}>
            Turn on
          </Button>
        </div>
      )}
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}

export function SecuritySection() {
  const { account, setAccount, signOut } = useAuth();
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [deletion, setDeletion] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, d] = await Promise.all([api.listSessions(), api.listDevices()]);
      setSessions(s);
      setDevices(d);
    } catch {
      // the panels stay usable; the next open retries
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, account?.twoFactorEnabled]);

  if (!account) return null;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const savePin = () =>
    run(async () => {
      if (!/^\d{6}$/.test(pin)) throw new Error("PIN must be 6 digits");
      if (pin !== confirm) throw new Error("The PINs do not match");
      await api.setTwoFactor(pin);
      setPin("");
      setConfirm("");
      await setAccount(await api.me());
    });

  return (
    <div className="space-y-6">
      <Card className="space-y-4">
        <Setting
          label="Two-step verification"
          hint="A 6-digit PIN after the SMS code. Nobody signs into your account without it."
        >
          <span className={cx("text-sm font-semibold", account.twoFactorEnabled ? "text-emerald-600 dark:text-emerald-400" : "text-ink-400")}>
            {account.twoFactorEnabled ? "On" : "Off"}
          </span>
        </Setting>
        {account.twoFactorEnabled ? (
          <Button variant="secondary" disabled={busy} onClick={() => void run(() => api.disableTwoFactor().then(() => api.me()).then(setAccount))}>
            Turn off
          </Button>
        ) : (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Input label="New PIN" type="password" inputMode="numeric" maxLength={6} value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} />
              <Input label="Confirm PIN" type="password" inputMode="numeric" maxLength={6} value={confirm}
                onChange={(e) => setConfirm(e.target.value.replace(/\D/g, ""))} />
            </div>
            <Button disabled={busy} onClick={() => void savePin()}>Turn on</Button>
          </div>
        )}
      </Card>

      <Card className="space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-sm font-bold uppercase tracking-wide text-ink-400">Linked devices</p>
          <Button variant="ghost" disabled={busy} onClick={() => void run(() => api.revokeOtherSessions().then(() => {}))}>
            Log out everywhere else
          </Button>
        </div>
        {sessions.length === 0 ? (
          <p className="text-sm text-ink-500 dark:text-ink-400">No other active sessions.</p>
        ) : (
          <ul className="divide-y divide-ink-100 dark:divide-night-border">
            {sessions.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-4 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink-800 dark:text-ink-100">
                    {s.deviceInfo ?? "Unknown device"}
                    {s.current && <span className="ml-2 text-xs font-medium text-emerald-600 dark:text-emerald-400">this session</span>}
                  </p>
                  <p className="text-xs text-ink-400">
                    {s.ip ? `${s.ip} · ` : ""}since {new Date(s.createdAt).toLocaleDateString()}
                  </p>
                </div>
                {!s.current && (
                  <Button variant="secondary" className="!px-3 !py-1.5 text-xs" disabled={busy}
                    onClick={() => void run(() => api.revokeSession(s.id))}>
                    Log out
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}

        <p className="pt-2 text-sm font-bold uppercase tracking-wide text-ink-400">Push registrations</p>
        {devices.length === 0 ? (
          <p className="text-sm text-ink-500 dark:text-ink-400">No devices registered for notifications.</p>
        ) : (
          <ul className="space-y-2">
            {devices.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-4 text-sm">
                <span className="text-ink-700 dark:text-ink-200">
                  {d.platform}
                  {d.appVersion ? ` · v${d.appVersion}` : ""}
                </span>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-ink-400">{new Date(d.lastSeenAt).toLocaleDateString()}</span>
                  <button disabled={busy} onClick={() => void run(() => api.deleteDevice(d.id))}
                    className="font-semibold text-red-600 hover:text-red-700 dark:text-red-400">
                    Unlink
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {error && <p className="text-sm text-red-600 dark:text-red-400">{message(error)}</p>}
      </Card>

      <Card className="space-y-3">
        <p className="text-sm font-bold uppercase tracking-wide text-ink-400">Delete account</p>
        <p className="text-sm text-ink-500 dark:text-ink-400">
          Your identities are disconnected and your profile is anonymised after a 30-day grace window.
          Signing back in during that window cancels it.
        </p>
        {account.deletionRequestedAt ? (
          <div className="space-y-2">
            <p className="text-sm font-semibold text-amber-700 dark:text-amber-400">
              Deletion scheduled for {new Date(account.deletionRequestedAt).toLocaleString()}
            </p>
            <Button variant="secondary" disabled={busy}
              onClick={() => void run(() => api.cancelAccountDeletion().then(() => api.me()).then(setAccount))}>
              Cancel deletion
            </Button>
          </div>
        ) : (
          <Button variant="danger" disabled={busy}
            onClick={() =>
              void run(async () => {
                const res = await api.requestAccountDeletion();
                setDeletion(res.deletionScheduledAt);
                await setAccount(await api.me());
              })
            }>
            Delete my account
          </Button>
        )}
        {deletion && !account.deletionRequestedAt && (
          <p className="text-xs text-ink-400">Scheduled for {new Date(deletion).toLocaleString()}.</p>
        )}
        <Button variant="ghost" disabled={busy} onClick={() => void signOut()}>
          Sign out of this device
        </Button>
      </Card>
    </div>
  );
}

function Setting({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink-800 dark:text-ink-100">{label}</p>
          <p className="mt-0.5 text-xs text-ink-500 dark:text-ink-400">{hint}</p>
        </div>
        <div className="shrink-0">{children}</div>
      </div>
    </div>
  );
}

function ChoiceRow<T extends string>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: T;
  options: Array<[T, string]>;
  onChange: (next: T) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map(([v, label]) => (
        <button
          key={v}
          disabled={disabled}
          onClick={() => onChange(v)}
          className={cx(
            "rounded-full border px-3.5 py-1.5 text-xs font-semibold transition-colors disabled:opacity-50",
            value === v
              ? "border-iris-500 bg-iris-50 text-iris-700 dark:bg-iris-500/15 dark:text-iris-300"
              : "border-ink-200 text-ink-500 hover:border-ink-300 dark:border-night-border dark:text-ink-400",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function Toggle({ on, onChange, disabled }: { on: boolean; onChange: (next: boolean) => void; disabled: boolean }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={cx(
        "relative h-6 w-11 rounded-full transition-colors disabled:opacity-50",
        on ? "bg-iris-600" : "bg-ink-200 dark:bg-night-border",
      )}
    >
      <span
        className={cx(
          "absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all",
          on ? "left-[22px]" : "left-0.5",
        )}
      />
    </button>
  );
}

function message(err: unknown): string {
  if (err instanceof ApiRequestError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong";
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
