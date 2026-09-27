import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowLeftIcon, CheckIcon, MailIcon, PhoneIcon } from "../components/icons";
import { Badge, Button, Card, Input, Logo, cx } from "../components/ui";
import { ApiRequestError, api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useTheme, type ThemeMode } from "../lib/theme";

export function SettingsPage() {
  const { account, setAccount, signOut } = useAuth();
  const { mode, setMode } = useTheme();
  const [displayName, setDisplayName] = useState(account?.displayName ?? "");
  const [bio, setBio] = useState(account?.bio ?? "");
  const [saving, setSaving] = useState(false);
  const [profileMsg, setProfileMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  if (!account) return null;

  const saveProfile = async () => {
    setSaving(true);
    setProfileMsg(null);
    try {
      setAccount(
        await api.updateProfile({
          displayName: displayName.trim() || null,
          bio: bio.trim() || null,
        }),
      );
      setProfileMsg({ kind: "ok", text: "Profile saved" });
    } catch (err) {
      setProfileMsg({ kind: "err", text: err instanceof ApiRequestError ? err.message : "Save failed" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto h-full max-w-2xl overflow-y-auto px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <Link to="/" className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-500 hover:text-ink-800 dark:hover:text-ink-200">
          <ArrowLeftIcon className="h-4 w-4" /> Back
        </Link>
        <Logo />
      </div>

      <h1 className="mb-6 text-2xl font-bold tracking-tight text-ink-900 dark:text-white">Settings</h1>

      <div className="space-y-6">
        {/* Account & identities (spec §27–28) */}
        <section>
          <SectionTitle>Account</SectionTitle>
          <Card className="space-y-5">
            <div className="space-y-4">
              <IdentityCard
                icon={<PhoneIcon className="h-5 w-5 text-iris-500" />}
                label="Phone Number"
                value={account.phone?.phone}
                emptyText="Not connected"
                connectTo="/settings/connect-phone"
                connectLabel="Connect Phone Number"
                footnote={account.phone ? "Chats enabled" : undefined}
              />
              <IdentityCard
                icon={<MailIcon className="h-5 w-5 text-signal-500" />}
                label="Email"
                value={account.email?.email}
                emptyText="Not connected"
                connectTo="/settings/connect-email"
                connectLabel="Connect Email"
                footnote={account.email ? "Mail enabled" : undefined}
              />
            </div>

            <div className="rounded-card bg-ink-50 px-4 py-3 dark:bg-night-raised">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">Communication</p>
              <div className="mt-2 flex gap-4 text-sm">
                <Capability enabled={account.capabilities.chats} label="Chats enabled" />
                <Capability enabled={account.capabilities.mail} label="Mail enabled" />
              </div>
            </div>

            <div className="space-y-3 border-t border-ink-100 pt-4 dark:border-night-border">
              <Input label="Display name" value={displayName} maxLength={64}
                onChange={(e) => setDisplayName(e.target.value)} placeholder="How contacts see you" />
              <Input label="Bio" value={bio} maxLength={280}
                onChange={(e) => setBio(e.target.value)} placeholder="A short line about you" />
              <div className="flex items-center gap-3">
                <Button loading={saving} onClick={() => void saveProfile()}>Save profile</Button>
                {profileMsg && (
                  <span className={cx("text-sm", profileMsg.kind === "ok" ? "text-emerald-600" : "text-red-600")}>
                    {profileMsg.text}
                  </span>
                )}
              </div>
            </div>
          </Card>
        </section>

        {/* Appearance */}
        <section>
          <SectionTitle>Appearance</SectionTitle>
          <Card>
            <div className="flex gap-2">
              {(["light", "dark", "system"] as ThemeMode[]).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={cx(
                    "flex-1 rounded-xl border px-4 py-2.5 text-sm font-semibold capitalize transition-colors",
                    mode === m
                      ? "border-iris-500 bg-iris-50 text-iris-700 dark:bg-iris-500/15 dark:text-iris-300"
                      : "border-ink-200 text-ink-500 hover:border-ink-300 dark:border-night-border dark:text-ink-400",
                  )}
                >
                  {m}
                </button>
              ))}
            </div>
          </Card>
        </section>

        {/* Placeholder sections for later phases */}
        <section>
          <SectionTitle>Privacy · Notifications · Storage · Security</SectionTitle>
          <Card>
            <p className="text-sm text-ink-500 dark:text-ink-400">
              Privacy controls, per-conversation notifications, storage
              management and active-session controls arrive in later phases
              (see docs/TODO.md).
            </p>
          </Card>
        </section>

        <section>
          <Card className="flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-ink-800 dark:text-ink-100">Sign out</p>
              <p className="text-xs text-ink-400">You can sign back in with any connected identity.</p>
            </div>
            <Button variant="danger" onClick={() => void signOut()}>Sign out</Button>
          </Card>
        </section>
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="mb-2 px-1 text-sm font-bold uppercase tracking-wide text-ink-400">{children}</h2>;
}

function IdentityCard({
  icon,
  label,
  value,
  emptyText,
  connectTo,
  connectLabel,
  footnote,
}: {
  icon: ReactNode;
  label: string;
  value: string | null | undefined;
  emptyText: string;
  connectTo: string;
  connectLabel: string;
  footnote?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-card border border-ink-200/70 px-4 py-3.5 dark:border-night-border">
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-ink-50 dark:bg-night-raised">
          {icon}
        </span>
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">{label}</p>
          {value ? (
            <p className="truncate text-sm font-semibold text-ink-800 dark:text-ink-100">{value}</p>
          ) : (
            <p className="text-sm text-ink-400">{emptyText}</p>
          )}
          {footnote && <p className="text-[11px] text-emerald-600 dark:text-emerald-400">✓ {footnote}</p>}
        </div>
      </div>
      {value ? (
        <Badge tone="success"><CheckIcon /> Verified</Badge>
      ) : (
        <Link to={connectTo} className="shrink-0">
          <Button variant="secondary" className="!px-3.5 !py-2 text-xs">{connectLabel}</Button>
        </Link>
      )}
    </div>
  );
}

function Capability({ enabled, label }: { enabled: boolean; label: string }) {
  return (
    <span className={cx("inline-flex items-center gap-1.5 font-medium", enabled ? "text-emerald-600 dark:text-emerald-400" : "text-ink-400")}>
      {enabled ? <CheckIcon className="h-3.5 w-3.5" /> : <span className="h-3.5 w-3.5 rounded-full border-2 border-current opacity-40" />}
      {label}
    </span>
  );
}
