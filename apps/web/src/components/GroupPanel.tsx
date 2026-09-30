import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { GroupDetail, GroupMember, GroupSettings, WsServerEvent } from "@convo/shared";
import { LinkIcon, PencilIcon, PlusIcon, TrashIcon, XIcon } from "./icons";
import { Badge, Button, Input, Spinner, cx } from "./ui";
import { api } from "../lib/api";
import { useRealtimeSubscription } from "../lib/realtime";

/**
 * Group info drawer (Phase 4B): settings, members, join requests, invite link.
 * Admin-only controls are hidden for members, matching the server's rules.
 */
export function GroupPanel({
  conversationId,
  selfUserId,
  onClose,
  onLeft,
}: {
  conversationId: string;
  selfUserId: string;
  onClose: () => void;
  onLeft: () => void;
}) {
  const [group, setGroup] = useState<GroupDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [addPhone, setAddPhone] = useState("");
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [editingAbout, setEditingAbout] = useState(false);
  const [aboutDraft, setAboutDraft] = useState("");

  const refresh = useCallback(async () => {
    try {
      setGroup(await api.group(conversationId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the group");
    }
  }, [conversationId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useRealtimeSubscription(
    useCallback(
      (event: WsServerEvent) => {
        if ("conversationId" in event && event.conversationId === conversationId) void refresh();
      },
      [conversationId, refresh],
    ),
  );

  const isAdmin = group?.myRole === "ADMIN";
  const canEditInfo =
    isAdmin || (group !== null && group.settings.whoCanEdit === "ALL");

  const run = async (fn: () => Promise<GroupDetail>) => {
    setBusy(true);
    try {
      setGroup(await fn());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(false);
    }
  };

  const toggleSetting = (patch: Partial<GroupSettings>) =>
    void run(() => api.updateGroup(conversationId, { settings: patch }));

  /**
   * The group icon rides the same upload pipeline as chat media: the bytes go
   * to /media/upload, and the chat only ever stores the returned key.
   */
  const uploadAvatar = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const { storageKey } = await api.uploadMedia(file);
      setGroup(await api.updateGroup(conversationId, { avatarStorageKey: storageKey }));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not upload the group photo");
    } finally {
      setBusy(false);
    }
  };

  if (!group) {
    return (
      <aside className="flex w-full flex-col border-l border-ink-200/70 bg-white md:w-80 dark:border-night-border dark:bg-night-surface">
        <PanelHeader title="Group info" onClose={onClose} />
        <div className="flex flex-1 items-center justify-center">
          {error ? <p className="px-6 text-center text-sm text-ink-500">{error}</p> : <Spinner />}
        </div>
      </aside>
    );
  }

  return (
    <aside className="flex w-full shrink-0 flex-col border-l border-ink-200/70 bg-white md:w-80 dark:border-night-border dark:bg-night-surface">
      <PanelHeader title="Group info" onClose={onClose} />
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
        <div className="flex flex-col items-center text-center">
          {group.avatarUrl ? (
            <img
              src={group.avatarUrl}
              alt=""
              className="h-16 w-16 rounded-2xl bg-gradient-to-br from-iris-500 to-signal-400 object-cover text-xl font-bold text-white"
            />
          ) : (
            <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-iris-500 to-signal-400 text-xl font-bold text-white">
              {group.name.charAt(0).toUpperCase()}
            </span>
          )}
          {canEditInfo && (
            <span className="mt-2 flex gap-3">
              <label className="cursor-pointer text-[11px] font-semibold text-iris-600 hover:underline">
                {group.avatarUrl ? "Change photo" : "Add photo"}
                <input
                  type="file"
                  accept="image/*"
                  className="sr-only"
                  disabled={busy}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    // Reset so picking the same file again still fires onChange.
                    e.target.value = "";
                    void uploadAvatar(file);
                  }}
                />
              </label>
              {group.avatarUrl && (
                <button
                  className="text-[11px] font-semibold text-ink-400 hover:text-rose-600"
                  disabled={busy}
                  onClick={() => void run(() => api.updateGroup(conversationId, { avatarStorageKey: null }))}
                >
                  Remove
                </button>
              )}
            </span>
          )}
          {editingName ? (
            <div className="mt-3 flex w-full gap-2">
              <input
                value={nameDraft}
                autoFocus
                onChange={(e) => setNameDraft(e.target.value)}
                className="min-w-0 flex-1 rounded-lg border border-ink-200 px-2 py-1 text-sm dark:border-night-border dark:bg-night-raised"
              />
              <Button
                className="!px-2 !py-1 text-xs"
                disabled={!nameDraft.trim()}
                onClick={() => {
                  setEditingName(false);
                  void run(() => api.updateGroup(conversationId, { name: nameDraft.trim() }));
                }}
              >
                Save
              </Button>
            </div>
          ) : (
            <div className="mt-3 flex items-center gap-2">
              <p className="text-base font-bold text-ink-900 dark:text-white">{group.name}</p>
              {canEditInfo && (
                <button
                  onClick={() => {
                    setNameDraft(group.name);
                    setEditingName(true);
                  }}
                  aria-label="Rename group"
                  className="text-ink-400 hover:text-ink-600"
                >
                  <PencilIcon className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          )}
          <p className="mt-1 text-xs text-ink-400">{group.memberCount} members</p>
          {editingAbout ? (
            <div className="mt-2 flex w-full gap-2">
              <input
                value={aboutDraft}
                autoFocus
                placeholder="Group description"
                onChange={(e) => setAboutDraft(e.target.value)}
                className="min-w-0 flex-1 rounded-lg border border-ink-200 px-2 py-1 text-sm dark:border-night-border dark:bg-night-raised"
              />
              <Button
                className="!px-2 !py-1 text-xs"
                disabled={busy}
                onClick={() => {
                  setEditingAbout(false);
                  void run(() => api.updateGroup(conversationId, { about: aboutDraft.trim() || null }));
                }}
              >
                Save
              </Button>
            </div>
          ) : (
            <div className="mt-2 flex items-center justify-center gap-2">
              {group.about ? (
                <p className="text-xs text-ink-500 dark:text-ink-400">{group.about}</p>
              ) : (
                <p className="text-xs italic text-ink-400">No description</p>
              )}
              {canEditInfo && (
                <button
                  onClick={() => {
                    setAboutDraft(group.about ?? "");
                    setEditingAbout(true);
                  }}
                  aria-label="Edit group description"
                  className="text-ink-400 hover:text-ink-600"
                >
                  <PencilIcon className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          )}
        </div>

        <Section title="Type">
          <div className="flex items-center gap-2">
            <Badge tone={group.settings.visibility === "PUBLIC" ? "success" : "iris"}>
              {group.settings.visibility === "PUBLIC" ? "Public" : "Private"}
            </Badge>
            {isAdmin && (
              <button
                className="text-xs font-semibold text-iris-600 hover:underline"
                disabled={busy}
                onClick={() =>
                  toggleSetting({
                    visibility: group.settings.visibility === "PUBLIC" ? "PRIVATE" : "PUBLIC",
                  })
                }
              >
                Make {group.settings.visibility === "PUBLIC" ? "private" : "public"}
              </button>
            )}
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-ink-400">
            {group.settings.visibility === "PUBLIC"
              ? "Anyone can join from the invite link or search."
              : "People need an admin invite or an approved join request."}
          </p>
        </Section>

        {isAdmin && (
          <Section title="Group permissions">
            <ToggleRow
              label="Only admins can send messages"
              checked={group.settings.announceOnly}
              onChange={(v) => toggleSetting({ announceOnly: v })}
            />
            <ToggleRow
              label="Only admins can edit group info"
              checked={group.settings.whoCanEdit === "ADMINS"}
              onChange={(v) => toggleSetting({ whoCanEdit: v ? "ADMINS" : "ALL" })}
            />
            <ToggleRow
              label="Only admins can share the invite link"
              checked={group.settings.whoCanInvite === "ADMINS"}
              onChange={(v) => toggleSetting({ whoCanInvite: v ? "ADMINS" : "ALL" })}
            />
            <ToggleRow
              label="Require admin approval for join requests"
              checked={group.settings.requireApproval}
              onChange={(v) => toggleSetting({ requireApproval: v })}
            />
          </Section>
        )}

        {group.inviteCode && (
          <Section title="Invite link">
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-lg bg-ink-100 px-2 py-1.5 text-[11px] dark:bg-night-raised">
                convo://group/{group.inviteCode}
              </code>
              <Button
                variant="secondary"
                className="!px-2 !py-1.5 text-[11px]"
                onClick={() => void navigator.clipboard?.writeText(`convo://group/${group.inviteCode}`)}
              >
                <LinkIcon className="h-3 w-3" /> Copy
              </Button>
            </div>
            {isAdmin && (
              <button
                className="mt-2 text-[11px] font-semibold text-rose-600 hover:underline"
                disabled={busy}
                onClick={() => void run(() => api.revokeInvite(conversationId))}
              >
                Revoke current link
              </button>
            )}
          </Section>
        )}

        {isAdmin && group.joinRequests.length > 0 && (
          <Section title={`Join requests (${group.joinRequests.length})`}>
            <ul className="space-y-2">
              {group.joinRequests.map((req) => (
                <li key={req.userId} className="flex items-center gap-2">
                  <MemberDot member={req} />
                  <span className="min-w-0 flex-1 truncate text-sm text-ink-700 dark:text-ink-200">
                    {displayName(req)}
                  </span>
                  <button
                    className="rounded-full bg-iris-600 px-2.5 py-1 text-[11px] font-semibold text-white disabled:opacity-50"
                    disabled={busy}
                    onClick={() => void run(() => api.approveJoinRequest(conversationId, req.userId))}
                  >
                    Approve
                  </button>
                  <button
                    className="rounded-full border border-ink-200 px-2.5 py-1 text-[11px] font-semibold text-ink-500 disabled:opacity-50 dark:border-night-border"
                    disabled={busy}
                    onClick={() => void run(() => api.rejectJoinRequest(conversationId, req.userId))}
                  >
                    Decline
                  </button>
                </li>
              ))}
            </ul>
          </Section>
        )}

        <Section title="Members">
          {canEditInfo && (
            <form
              className="mb-2 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const phone = addPhone.trim();
                if (!phone.startsWith("+")) return;
                setAddPhone("");
                void run(() => api.addGroupMembers(conversationId, [phone]));
              }}
            >
              <input
                value={addPhone}
                onChange={(e) => setAddPhone(e.target.value)}
                placeholder="+919876543210"
                className="min-w-0 flex-1 rounded-lg border border-ink-200 px-2 py-1.5 text-xs dark:border-night-border dark:bg-night-raised"
              />
              <Button type="submit" className="!px-2 !py-1.5 text-[11px]" disabled={busy}>
                <PlusIcon className="h-3 w-3" /> Add
              </Button>
            </form>
          )}
          <ul className="space-y-1">
            {group.members.map((member) => (
              <li key={member.userId} className="group/member flex items-center gap-2 py-0.5">
                <MemberDot member={member} />
                <span className="min-w-0 flex-1 truncate text-sm text-ink-700 dark:text-ink-200">
                  {displayName(member)}
                  {member.userId === selfUserId && <span className="text-ink-400"> (you)</span>}
                </span>
                {member.role === "ADMIN" && <Badge tone="iris">Admin</Badge>}
                {isAdmin && member.userId !== selfUserId && (
                  <span className="flex gap-1 opacity-0 transition-opacity group-hover/member:opacity-100">
                    <button
                      title={member.role === "ADMIN" ? "Demote" : "Make admin"}
                      className="text-[11px] font-semibold text-iris-600 hover:underline"
                      disabled={busy}
                      onClick={() =>
                        void run(() =>
                          member.role === "ADMIN"
                            ? api.demoteMember(conversationId, member.userId)
                            : api.promoteMember(conversationId, member.userId),
                        )
                      }
                    >
                      {member.role === "ADMIN" ? "Demote" : "Admin"}
                    </button>
                    <button
                      title="Remove from group"
                      className="text-rose-500 hover:text-rose-700"
                      disabled={busy}
                      onClick={() => void run(() => api.removeGroupMember(conversationId, member.userId))}
                    >
                      <TrashIcon className="h-3.5 w-3.5" />
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </Section>

        <div className="space-y-2 border-t border-ink-200/70 pt-4 dark:border-night-border">
          <Button
            variant="secondary"
            block
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await api.leaveGroup(conversationId).catch(() => {});
              setBusy(false);
              onLeft();
            }}
          >
            Exit group
          </Button>
          {isAdmin && (
            <Button
              variant="danger"
              block
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                await api.deleteGroup(conversationId).catch(() => {});
                setBusy(false);
                onLeft();
              }}
            >
              Delete group
            </Button>
          )}
        </div>
      </div>
    </aside>
  );
}

function PanelHeader({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div className="flex items-center justify-between border-b border-ink-200/70 px-4 py-3 dark:border-night-border">
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">{title}</p>
      <button onClick={onClose} aria-label="Close" className="text-ink-400 hover:text-ink-600">
        <XIcon className="h-4 w-4" />
      </button>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-ink-400">{title}</p>
      {children}
    </section>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="mb-2 flex cursor-pointer items-center justify-between gap-3">
      <span className="text-xs text-ink-600 dark:text-ink-300">{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 accent-iris-600"
      />
    </label>
  );
}

function MemberDot({ member }: { member: GroupMember }) {
  const initial = displayName(member).charAt(0).toUpperCase();
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-ink-200 text-[11px] font-bold text-ink-600 dark:bg-night-raised dark:text-ink-200">
      {initial}
    </span>
  );
}

function displayName(member: GroupMember): string {
  return member.displayName ?? member.phone ?? "Convo user";
}

/** Create-group / join-by-code / discover-public dialog. */
export function GroupDirectoryDialog({
  onClose,
  onOpen,
}: {
  onClose: () => void;
  onOpen: (conversationId: string) => void;
}) {
  const [tab, setTab] = useState<"create" | "join" | "discover">("create");
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-md animate-rise rounded-card border border-ink-200/70 bg-white p-6 shadow-xl dark:border-night-border dark:bg-night-surface"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-ink-900 dark:text-white">Groups</h2>
          <button onClick={onClose} aria-label="Close" className="text-ink-400 hover:text-ink-600">
            <XIcon className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-3 flex gap-1 rounded-full bg-ink-100 p-1 dark:bg-night-raised">
          {(["create", "join", "discover"] as const).map((key) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={cx(
                "flex-1 rounded-full py-1.5 text-xs font-semibold capitalize transition-colors",
                tab === key
                  ? "bg-white text-ink-900 shadow-sm dark:bg-night-surface dark:text-white"
                  : "text-ink-500",
              )}
            >
              {key === "join" ? "Join with code" : key}
            </button>
          ))}
        </div>
        {tab === "create" && <CreateGroupTab onOpen={onOpen} onClose={onClose} />}
        {tab === "join" && <JoinByCodeTab onOpen={onOpen} />}
        {tab === "discover" && <DiscoverTab onOpen={onOpen} />}
      </div>
    </div>
  );
}

function CreateGroupTab({ onOpen, onClose }: { onOpen: (id: string) => void; onClose: () => void }) {
  const [name, setName] = useState("");
  const [about, setAbout] = useState("");
  const [phones, setPhones] = useState("");
  const [avatarKey, setAvatarKey] = useState<string | null>(null);
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
        avatarStorageKey: avatarKey ?? undefined,
        visibility: isPublic ? "PUBLIC" : "PRIVATE",
        phones: list,
      });
      onClose();
      onOpen(detail.conversationId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the group");
      setBusy(false);
    }
  };

  const pickAvatar = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      setAvatarKey((await api.uploadMedia(file)).storageKey);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not upload the photo");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 space-y-4">
      <Input
        label="Group name"
        value={name}
        autoFocus
        onChange={(e) => setName(e.target.value)}
        placeholder="Weekend trip crew"
        error={error}
      />
      <Input
        label="Description (optional)"
        value={about}
        onChange={(e) => setAbout(e.target.value)}
        placeholder="What is this group about?"
      />
      <Input
        label="Add people by phone (optional)"
        value={phones}
        onChange={(e) => setPhones(e.target.value)}
        placeholder="+919800000001, +919800000002"
        hint="Separated by commas. Unknown numbers are skipped."
      />
      <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-600 dark:text-ink-300">
        <input
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => void pickAvatar(e.target.files?.[0])}
        />
        <span className="rounded-lg border border-ink-200 px-3 py-1.5 text-xs font-semibold dark:border-night-border">
          {avatarKey ? "Group photo chosen" : "Add group photo"}
        </span>
      </label>
      <label className="flex items-center gap-2 text-sm text-ink-600 dark:text-ink-300">
        <input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} className="h-4 w-4 accent-iris-600" />
        Public group — anyone with the link can join without approval
      </label>
      <Button block loading={busy} disabled={!name.trim()} onClick={() => void submit()}>
        Create group
      </Button>
    </div>
  );
}

function JoinByCodeTab({ onOpen }: { onOpen: (id: string) => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const detail = await api.joinByCode(code.trim());
      onOpen(detail.conversationId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not join");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 space-y-4">
      <Input
        label="Invite code"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder="Paste the code from your invite link"
        error={error}
        hint="Private groups with approval on will send a join request instead of entering."
      />
      <Button block loading={busy} disabled={code.trim().length < 8} onClick={() => void submit()}>
        Join group
      </Button>
    </div>
  );
}

function DiscoverTab({ onOpen }: { onOpen: (id: string) => void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Awaited<ReturnType<typeof api.discoverGroups>>["groups"]>([]);
  const [busy, setBusy] = useState(false);

  const search = async () => {
    if (!q.trim()) return;
    setBusy(true);
    try {
      setResults((await api.discoverGroups(q.trim())).groups);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 space-y-3">
      <div className="flex gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void search()}
          placeholder="Search public groups…"
          className="min-w-0 flex-1 rounded-xl border border-ink-200 bg-ink-50 px-3 py-2 text-sm dark:border-night-border dark:bg-night-raised"
        />
        <Button variant="secondary" loading={busy} onClick={() => void search()}>
          Search
        </Button>
      </div>
      <ul className="max-h-56 space-y-1 overflow-y-auto">
        {results.length === 0 && <li className="py-6 text-center text-xs text-ink-400">No public groups found.</li>}
        {results.map((g) => (
          <li key={g.conversationId} className="flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-ink-50 dark:hover:bg-night-raised">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-ink-100 text-xs font-bold text-ink-600 dark:bg-night-raised dark:text-ink-200">
              {g.name.charAt(0).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-ink-800 dark:text-ink-100">{g.name}</span>
              <span className="block text-[11px] text-ink-400">{g.memberCount} members</span>
            </span>
            <Button
              className="!px-3 !py-1.5 text-xs"
              onClick={async () => {
                await api.applyToGroup(g.conversationId);
                onOpen(g.conversationId);
              }}
            >
              Join
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
