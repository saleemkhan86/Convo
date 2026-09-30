import { useCallback, useEffect, useState, type ReactNode } from "react";
import type {
  BlockedUser,
  Contact,
  ConversationSummary,
  GlobalSearchResult,
  RecentRecipient,
  ReportReason,
  ReportTargetType,
  StarredMessage,
  UserCard,
} from "@convo/shared";
import {
  ArchiveIcon,
  BellOffIcon,
  BlockIcon,
  ChatIcon,
  ContactsIcon,
  DownloadIcon,
  FlagIcon,
  PencilIcon,
  PinIcon,
  PlusIcon,
  StarIcon,
  TimerIcon,
  TrashIcon,
  XIcon,
} from "./icons";
import { Button, Input, Spinner, cx } from "./ui";
import { messageLabel } from "./ChatMedia";
import { api, ApiRequestError } from "../lib/api";

/**
 * Phase 5A chat controls: per-viewer chat actions, the address book, safety
 * actions (block/report), starred messages and global search.
 *
 * Every control here is per-viewer state on the server, so nothing in this
 * file changes what another participant sees — except blocking and reporting,
 * which are account-level moderation actions.
 */

const MUTE_PRESETS = [
  { hours: 8, label: "8 hours" },
  { hours: 168, label: "1 week" },
  { hours: 8760, label: "1 year" },
];

export type ChatAction =
  | { kind: "pin"; pinned: boolean }
  | { kind: "archive"; archived: boolean }
  | { kind: "mute"; hours: number }
  | { kind: "clear" }
  | { kind: "delete" }
  | { kind: "info" }
  | { kind: "report" }
  /** Disappearing-messages timer for this 1-1 chat (0 = off). */
  | { kind: "ephemeral"; seconds: number }
  | { kind: "export" };

const EPHEMERAL_PRESETS = [
  { seconds: 0, label: "Off" },
  { seconds: 86_400, label: "24 hours" },
  { seconds: 7 * 86_400, label: "7 days" },
  { seconds: 90 * 86_400, label: "90 days" },
];

/** "24h" / "7d" / "90d" — the compact timer badge used in chat headers. */
export function shortEphemeral(seconds: number): string {
  if (seconds <= 0) return "Off";
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  return `${Math.round(seconds / 3600)}h`;
}

/**
 * Dropdown anchored inside the caller's `relative` container, with a
 * viewport-wide backdrop so a click anywhere else closes it.
 */
export function Menu({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return (
    <>
      <div className="fixed inset-0 z-20" onClick={onClose} />
      <div
        className="absolute right-1 top-8 z-30 w-56 overflow-hidden rounded-card border border-ink-200/70 bg-white py-1 shadow-xl dark:border-night-border dark:bg-night-surface"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </>
  );
}

export function MenuItem({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={cx(
        "flex w-full items-center gap-2.5 px-4 py-2 text-left text-sm transition-colors",
        danger
          ? "text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-500/10"
          : "text-ink-700 hover:bg-ink-50 dark:text-ink-200 dark:hover:bg-night-raised",
      )}
    >
      <span className="h-4 w-4 shrink-0">{icon}</span>
      {label}
    </button>
  );
}

/** The ⋮ menu on a chat: pin, mute, archive, clear, delete, info, report. */
export function ChatMenu({
  conversation,
  onClose,
  onAction,
}: {
  conversation: ConversationSummary;
  onClose: () => void;
  onAction: (action: ChatAction) => void;
}) {
  const [muteOpen, setMuteOpen] = useState(false);
  const [ephemeralOpen, setEphemeralOpen] = useState(false);
  const muted = conversation.mutedUntil !== null && new Date(conversation.mutedUntil) > new Date();

  if (ephemeralOpen) {
    return (
      <Menu onClose={onClose}>
        <p className="px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-400">
          Disappearing messages
        </p>
        {EPHEMERAL_PRESETS.map((preset) => (
          <MenuItem
            key={preset.seconds}
            icon={<TimerIcon className="h-4 w-4" />}
            label={`${preset.label}${conversation.ephemeralSeconds === preset.seconds ? " ✓" : ""}`}
            onClick={() => {
              onAction({ kind: "ephemeral", seconds: preset.seconds });
              onClose();
            }}
          />
        ))}
        <MenuItem icon={<XIcon className="h-4 w-4" />} label="Back" onClick={() => setEphemeralOpen(false)} />
      </Menu>
    );
  }

  return (
    <Menu onClose={onClose}>
      {muteOpen ? (
        <>
          <p className="px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-400">
            Mute notifications
          </p>
          {MUTE_PRESETS.map((preset) => (
            <MenuItem
              key={preset.hours}
              icon={<BellOffIcon className="h-4 w-4" />}
              label={preset.label}
              onClick={() => {
                onAction({ kind: "mute", hours: preset.hours });
                onClose();
              }}
            />
          ))}
          {muted && (
            <MenuItem
              icon={<BellOffIcon className="h-4 w-4" />}
              label="Unmute"
              onClick={() => {
                onAction({ kind: "mute", hours: 0 });
                onClose();
              }}
            />
          )}
          <MenuItem icon={<XIcon className="h-4 w-4" />} label="Back" onClick={() => setMuteOpen(false)} />
        </>
      ) : (
        <>
          <MenuItem
            icon={<PinIcon className="h-4 w-4" filled={conversation.pinned} />}
            label={conversation.pinned ? "Unpin chat" : "Pin chat"}
            onClick={() => {
              onAction({ kind: "pin", pinned: !conversation.pinned });
              onClose();
            }}
          />
          <MenuItem
            icon={<BellOffIcon className="h-4 w-4" />}
            label={muted ? "Muted — change" : "Mute notifications"}
            onClick={() => setMuteOpen(true)}
          />
          <MenuItem
            icon={<ArchiveIcon className="h-4 w-4" />}
            label={conversation.archived ? "Unarchive chat" : "Archive chat"}
            onClick={() => {
              onAction({ kind: "archive", archived: !conversation.archived });
              onClose();
            }}
          />
          <MenuItem
            icon={<ContactsIcon className="h-4 w-4" />}
            label={conversation.type === "GROUP" ? "Group info" : "Contact info"}
            onClick={() => {
              onAction({ kind: "info" });
              onClose();
            }}
          />
          {conversation.type === "DIRECT" && (
            <MenuItem
              icon={<TimerIcon className="h-4 w-4" />}
              label={
                conversation.ephemeralSeconds > 0
                  ? `Disappearing · ${shortEphemeral(conversation.ephemeralSeconds)}`
                  : "Disappearing messages"
              }
              onClick={() => setEphemeralOpen(true)}
            />
          )}
          <MenuItem
            icon={<DownloadIcon className="h-4 w-4" />}
            label="Export chat"
            onClick={() => {
              onAction({ kind: "export" });
              onClose();
            }}
          />
          <MenuItem
            icon={<TrashIcon className="h-4 w-4" />}
            label="Clear chat"
            onClick={() => {
              onAction({ kind: "clear" });
              onClose();
            }}
          />
          <MenuItem
            icon={<TrashIcon className="h-4 w-4" />}
            label="Delete chat"
            danger
            onClick={() => {
              onAction({ kind: "delete" });
              onClose();
            }}
          />
          {conversation.type === "DIRECT" && conversation.peer && (
            <MenuItem
              icon={<FlagIcon className="h-4 w-4" />}
              label="Report"
              danger
              onClick={() => {
                onAction({ kind: "report" });
                onClose();
              }}
            />
          )}
        </>
      )}
    </Menu>
  );
}

/** Modal shell shared by the 5A dialogs. */
export function Dialog({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink-900/40 p-4 pt-[8vh] backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className={cx(
          "flex max-h-[80vh] w-full flex-col overflow-hidden rounded-card border border-ink-200/70 bg-white shadow-xl dark:border-night-border dark:bg-night-surface",
          wide ? "max-w-2xl" : "max-w-md",
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-ink-200/70 px-5 py-3 dark:border-night-border">
          <h2 className="text-sm font-bold text-ink-900 dark:text-white">{title}</h2>
          <button className="text-ink-400 hover:text-ink-600" onClick={onClose} aria-label="Close">
            <XIcon className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  onClose,
  onConfirm,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog title={title} onClose={onClose}>
      <div className="p-5">
        <p className="text-sm text-ink-600 dark:text-ink-300">{body}</p>
        <div className="mt-5 flex gap-2">
          <Button variant="secondary" block onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            block
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

// ────────────────────────────── starred messages ──────────────────────────────

export function StarredDialog({
  onClose,
  onOpen,
}: {
  onClose: () => void;
  onOpen: (conversationId: string, messageId: string) => void;
}) {
  const [items, setItems] = useState<StarredMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listStarred()
      .then((r) => !cancelled && setItems(r.items))
      .catch((err) => !cancelled && setError(messageOf(err)));
    return () => {
      cancelled = true;
    };
  }, []);

  const unstar = async (id: string) => {
    try {
      await api.starMessage(id, false);
      setItems((prev) => prev?.filter((i) => i.message.id !== id) ?? prev);
    } catch (err) {
      setError(messageOf(err));
    }
  };

  return (
    <Dialog title="Starred messages" onClose={onClose} wide>
      <div className="p-4">
        {error && <p className="mb-3 text-xs text-rose-600">{error}</p>}
        {items === null ? (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        ) : items.length === 0 ? (
          <p className="py-10 text-center text-sm text-ink-400">
            No starred messages yet. Long-press or hover a message and choose Star.
          </p>
        ) : (
          items.map((item) => (
            <div
              key={item.message.id}
              className="mb-2 flex items-start gap-3 rounded-xl border border-ink-200/70 px-3 py-2.5 dark:border-night-border"
            >
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 text-[11px] font-semibold text-ink-400">
                  <StarIcon className="h-3 w-3 text-iris-500" filled />
                  {item.conversationName ?? "Unknown chat"}
                </p>
                <p className="mt-0.5 truncate text-sm text-ink-800 dark:text-ink-100">
                  {item.message.deletedAt ? "Message deleted" : messageLabel(item.message)}
                </p>
              </div>
              <button
                className="text-xs font-semibold text-iris-600 hover:underline"
                onClick={() => onOpen(item.conversationId, item.message.id)}
              >
                Open
              </button>
              <button className="text-ink-400 hover:text-rose-600" onClick={() => void unstar(item.message.id)} aria-label="Unstar">
                <TrashIcon className="h-4 w-4" />
              </button>
            </div>
          ))
        )}
      </div>
    </Dialog>
  );
}

// ────────────────────────────── global search ──────────────────────────────

export function SearchDialog({
  initial,
  onClose,
  onOpenConversation,
}: {
  initial: string;
  onClose: () => void;
  onOpenConversation: (conversationId: string) => void;
}) {
  const [query, setQuery] = useState(initial);
  const [result, setResult] = useState<GlobalSearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResult(null);
      return;
    }
    const t = window.setTimeout(() => {
      setBusy(true);
      api
        .search(q)
        .then((r) => {
          setResult(r);
          setError(null);
        })
        .catch((err) => setError(messageOf(err)))
        .finally(() => setBusy(false));
    }, 250);
    return () => window.clearTimeout(t);
  }, [query]);

  const empty =
    result !== null &&
    result.contacts.length === 0 &&
    result.conversations.length === 0 &&
    result.messages.length === 0 &&
    result.groups.length === 0;

  return (
    <Dialog title="Search" onClose={onClose} wide>
      <div className="border-b border-ink-200/70 p-4 dark:border-night-border">
        <Input
          placeholder="People, chats and messages"
          value={query}
          autoFocus
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="p-4">
        {busy && <div className="flex justify-center py-6"><Spinner /></div>}
        {error && <p className="text-xs text-rose-600">{error}</p>}
        {!busy && (result === null || empty) && !error && (
          <p className="py-6 text-center text-sm text-ink-400">
            {query.trim().length < 2 ? "Type at least two characters." : "Nothing matched that search."}
          </p>
        )}
        {!busy && result && !empty && (
          <>
            <Section label={`Chats (${result.conversations.length})`} show={result.conversations.length > 0}>
              {result.conversations.map((c) => (
                <Row
                  key={c.id}
                  title={c.type === "GROUP" ? (c.title ?? "Group") : (c.peer?.displayName ?? c.peer?.phone ?? "Unknown")}
                  subtitle={c.lastMessage?.body ?? "No messages yet"}
                  onClick={() => {
                    onOpenConversation(c.id);
                    onClose();
                  }}
                />
              ))}
            </Section>
            <Section label={`Contacts (${result.contacts.length})`} show={result.contacts.length > 0}>
              {result.contacts.map((ct) => (
                <Row key={ct.id} title={ct.displayName} subtitle={ct.phone ?? ct.email ?? ""} />
              ))}
            </Section>
            <Section label={`Messages (${result.messages.length})`} show={result.messages.length > 0}>
              {result.messages.map((m) => (
                <Row
                  key={m.message.id}
                  title={m.conversationName ?? "Chat"}
                  subtitle={m.message.deletedAt ? "Message deleted" : messageLabel(m.message)}
                  onClick={() => {
                    onOpenConversation(m.conversationId);
                    onClose();
                  }}
                />
              ))}
            </Section>
            <Section
              label={`Groups you can join (${result.groups.length})`}
              show={result.groups.length > 0}
            >
              {result.groups.map((g) => (
                <Row key={g.conversationId} title={g.name} subtitle={`${g.memberCount} members`} />
              ))}
            </Section>
          </>
        )}
      </div>
    </Dialog>
  );
}

function Section({ label, show, children }: { label: string; show: boolean; children: ReactNode }) {
  if (!show) return null;
  return (
    <div className="mb-4">
      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-400">{label}</p>
      {children}
    </div>
  );
}

function Row({
  title,
  subtitle,
  onClick,
}: {
  title: string;
  subtitle: string;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      className="w-full rounded-lg px-3 py-2 text-left transition-colors enabled:hover:bg-ink-50 dark:enabled:hover:bg-night-raised"
    >
      <p className="truncate text-sm font-semibold text-ink-900 dark:text-white">{title}</p>
      {subtitle && <p className="truncate text-xs text-ink-500 dark:text-ink-400">{subtitle}</p>}
    </button>
  );
}

// ────────────────────────────── address book ──────────────────────────────

export function ContactsDialog({
  onClose,
  onOpenChat,
}: {
  onClose: () => void;
  onOpenChat: (conversationId: string) => void;
}) {
  const [contacts, setContacts] = useState<Contact[] | null>(null);
  const [recents, setRecents] = useState<RecentRecipient[] | null>(null);
  const [editing, setEditing] = useState<Contact | "new" | null>(null);
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    api
      .listContacts()
      .then((r) => setContacts(r.contacts))
      .catch((err) => setError(messageOf(err)));
    api
      .recentRecipients()
      .then((r) => setRecents(r.recipients))
      .catch(() => setRecents([]));
  }, []);

  useEffect(reload, [reload]);

  const startChat = async (target: string) => {
    try {
      const conv = await api.startConversation(target);
      onOpenChat(conv.id);
      onClose();
    } catch (err) {
      setError(messageOf(err));
    }
  };

  const remove = async (id: string) => {
    try {
      await api.deleteContact(id);
      setContacts((prev) => prev?.filter((c) => c.id !== id) ?? prev);
    } catch (err) {
      setError(messageOf(err));
    }
  };

  if (editing) {
    return (
      <ContactForm
        contact={editing === "new" ? null : editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          reload();
        }}
      />
    );
  }

  return (
    <Dialog title="Contacts" onClose={onClose}>
      <div className="p-4">
        {error && <p className="mb-3 text-xs text-rose-600">{error}</p>}
        <div className="mb-4 flex gap-2">
          <Button className="!px-3 !py-1.5 text-xs" onClick={() => setEditing("new")}>
            <PlusIcon className="h-3.5 w-3.5" /> Add contact
          </Button>
          <Button variant="secondary" className="!px-3 !py-1.5 text-xs" onClick={() => void startChat(phone)}>
            New by number
          </Button>
          <Input
            className="!w-40 !py-1.5 !text-xs"
            placeholder="+91…"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </div>

        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-400">Recent chats</p>
        {recents === null ? (
          <div className="flex justify-center py-4"><Spinner /></div>
        ) : recents.length === 0 ? (
          <p className="py-2 text-xs text-ink-400">No recent chats.</p>
        ) : (
          recents.map((r) => (
            <button
              key={r.conversationId}
              onClick={() => {
                onOpenChat(r.conversationId);
                onClose();
              }}
              className="w-full rounded-lg px-3 py-2 text-left hover:bg-ink-50 dark:hover:bg-night-raised"
            >
              <p className="truncate text-sm font-semibold text-ink-900 dark:text-white">
                {r.displayName ?? r.phone ?? "Convo user"}
              </p>
              <p className="truncate text-xs text-ink-400">{r.phone ?? "on Convo"}</p>
            </button>
          ))
        )}

        <p className="mb-1.5 mt-4 text-[11px] font-semibold uppercase tracking-wide text-ink-400">
          Saved contacts
        </p>
        {contacts === null ? (
          <div className="flex justify-center py-4"><Spinner /></div>
        ) : contacts.length === 0 ? (
          <p className="py-2 text-xs text-ink-400">
            No saved contacts yet. Saved contacts can see your last-seen when you restrict it to contacts.
          </p>
        ) : (
          contacts.map((c) => (
            <div key={c.id} className="flex items-center gap-2 rounded-lg px-3 py-2 hover:bg-ink-50 dark:hover:bg-night-raised">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-ink-900 dark:text-white">{c.displayName}</p>
                <p className="truncate text-xs text-ink-400">{c.phone ?? c.email}</p>
              </div>
              {c.convoUserId && (
                <button
                  className="text-xs font-semibold text-iris-600 hover:underline"
                  onClick={() => void startChat(c.phone ?? "")}
                >
                  Message
                </button>
              )}
              <button className="text-ink-400 hover:text-ink-700" onClick={() => setEditing(c)} aria-label="Edit">
                <PencilIcon className="h-4 w-4" />
              </button>
              <button className="text-ink-400 hover:text-rose-600" onClick={() => void remove(c.id)} aria-label="Delete">
                <TrashIcon className="h-4 w-4" />
              </button>
            </div>
          ))
        )}
      </div>
    </Dialog>
  );
}

function ContactForm({
  contact,
  onClose,
  onSaved,
}: {
  contact: Contact | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(contact?.displayName ?? "");
  const [phone, setPhone] = useState(contact?.phone ?? "");
  const [email, setEmail] = useState(contact?.email ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.saveContact({
        id: contact?.id,
        displayName: name.trim(),
        ...(phone.trim() ? { phone: phone.trim() } : {}),
        ...(email.trim() ? { email: email.trim() } : {}),
      });
      onSaved();
    } catch (err) {
      setError(messageOf(err));
      setBusy(false);
    }
  };

  return (
    <Dialog title={contact ? "Edit contact" : "Add contact"} onClose={onClose}>
      <div className="space-y-3 p-5">
        <Input label="Name" value={name} autoFocus onChange={(e) => setName(e.target.value)} error={error} />
        <Input label="Phone" placeholder="+919876543210" value={phone} onChange={(e) => setPhone(e.target.value)} />
        <Input label="Email" placeholder="optional" value={email} onChange={(e) => setEmail(e.target.value)} />
        <div className="flex gap-2 pt-1">
          <Button variant="secondary" block onClick={onClose}>
            Cancel
          </Button>
          <Button block loading={busy} onClick={() => void save()} disabled={name.trim().length === 0 || (!phone.trim() && !email.trim())}>
            Save
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

// ────────────────────────────── contact info ──────────────────────────────

export function ContactInfoDialog({
  userId,
  onClose,
  onOpenChat,
}: {
  userId: string;
  onClose: () => void;
  onOpenChat: (conversationId: string) => void;
}) {
  const [card, setCard] = useState<UserCard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reportOpen, setReportOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .userCard(userId)
      .then((c) => !cancelled && setCard(c))
      .catch((err) => !cancelled && setError(messageOf(err)));
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const toggleBlock = async () => {
    if (!card) return;
    try {
      if (card.blockedByMe) await api.unblockUser(card.userId);
      else await api.blockUser({ userId: card.userId });
      setCard(await api.userCard(card.userId));
    } catch (err) {
      setError(messageOf(err));
    }
  };

  if (reportOpen && card) {
    return (
      <ReportDialog
        targetType="USER"
        targetId={card.userId}
        targetLabel={card.displayName ?? card.phone ?? "this account"}
        onClose={() => setReportOpen(false)}
        onDone={() => onClose()}
      />
    );
  }

  return (
    <Dialog title="Contact info" onClose={onClose}>
      <div className="p-5">
        {error && <p className="mb-3 text-xs text-rose-600">{error}</p>}
        {card === null ? (
          <div className="flex justify-center py-8"><Spinner /></div>
        ) : (
          <>
            <div className="flex flex-col items-center text-center">
              <span className="flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-iris-500 to-signal-400 text-xl font-bold text-white">
                {(card.displayName ?? "?").charAt(0).toUpperCase()}
              </span>
              <p className="mt-3 text-base font-bold text-ink-900 dark:text-white">
                {card.displayName ?? "Convo user"}
              </p>
              {card.phone && <p className="mt-0.5 text-sm text-ink-500 dark:text-ink-400">{card.phone}</p>}
              {card.bio && <p className="mt-1 text-xs text-ink-400">{card.bio}</p>}
              <p className="mt-1 text-xs text-ink-400">
                {card.lastSeenAt ? `last seen ${new Date(card.lastSeenAt).toLocaleString()}` : "last seen hidden"}
              </p>
            </div>

            <div className="mt-5 space-y-2">
              {card.sharedConversationId && (
                <Button
                  block
                  onClick={() => {
                    onOpenChat(card.sharedConversationId!);
                    onClose();
                  }}
                >
                  <ChatIcon className="h-4 w-4" /> Open chat
                </Button>
              )}
              <Button variant="secondary" block onClick={() => void toggleBlock()}>
                <BlockIcon className="h-4 w-4" />
                {card.blockedByMe ? "Unblock" : "Block"} {card.blockedByMe ? "contact" : "this contact"}
              </Button>
              <Button variant="ghost" block onClick={() => setReportOpen(true)}>
                <FlagIcon className="h-4 w-4" /> Report
              </Button>
            </div>
            {card.blockedByMe && (
              <p className="mt-3 text-center text-[11px] text-ink-400">
                Blocked contacts cannot see your status or reach you — they are never told.
              </p>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}

// ────────────────────────────── reporting ──────────────────────────────

const REASON_OPTIONS: { value: ReportReason; label: string }[] = [
  { value: "SPAM", label: "Spam" },
  { value: "ABUSE", label: "Abusive content" },
  { value: "HARASSMENT", label: "Harassment" },
  { value: "FRAUD", label: "Fraud or scam" },
  { value: "VIOLENT", label: "Violent content" },
  { value: "IMPERSONATION", label: "Impersonation" },
  { value: "OTHER", label: "Something else" },
];

export function ReportDialog({
  targetType,
  targetId,
  targetLabel,
  onClose,
  onDone,
}: {
  targetType: ReportTargetType;
  targetId: string;
  targetLabel: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState<ReportReason>("SPAM");
  const [details, setDetails] = useState("");
  const [block, setBlock] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    try {
      await api.report({
        targetType,
        targetId,
        reason,
        details: details.trim() || undefined,
        blockAfterReport: block,
      });
      onDone();
    } catch (err) {
      setError(messageOf(err));
      setBusy(false);
    }
  };

  return (
    <Dialog title={`Report ${targetLabel}`} onClose={onClose}>
      <div className="space-y-3 p-5">
        <p className="text-xs text-ink-500 dark:text-ink-400">
          Reports go to Convo moderators with the message content attached. The account is not told who reported it.
        </p>
        <div className="grid grid-cols-2 gap-2">
          {REASON_OPTIONS.map((option) => (
            <button
              key={option.value}
              onClick={() => setReason(option.value)}
              className={cx(
                "rounded-xl border px-3 py-2 text-left text-xs font-medium transition-colors",
                reason === option.value
                  ? "border-iris-400 bg-iris-50 text-iris-700 dark:border-iris-500/40 dark:bg-iris-500/15 dark:text-iris-300"
                  : "border-ink-200 text-ink-600 hover:bg-ink-50 dark:border-night-border dark:text-ink-300 dark:hover:bg-night-raised",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
        <textarea
          value={details}
          onChange={(e) => setDetails(e.target.value)}
          rows={3}
          placeholder="Add details (optional)"
          className="w-full rounded-xl border border-ink-200 bg-ink-50 px-3 py-2 text-sm placeholder:text-ink-400 focus:border-iris-400 focus:outline-none dark:border-night-border dark:bg-night-raised dark:text-ink-100"
        />
        <label className="flex items-center gap-2 text-xs text-ink-600 dark:text-ink-300">
          <input type="checkbox" checked={block} onChange={(e) => setBlock(e.target.checked)} />
          Also block this account
        </label>
        {error && <p className="text-xs text-rose-600">{error}</p>}
        <div className="flex gap-2 pt-1">
          <Button variant="secondary" block onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" block loading={busy} onClick={() => void submit()}>
            Send report
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

// ────────────────────────────── blocked list ──────────────────────────────

export function BlockedList({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<BlockedUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    api
      .listBlocked()
      .then((r) => setRows(r.blocked))
      .catch((err) => setError(messageOf(err)));
  }, []);
  useEffect(reload, [reload]);

  const unblock = async (userId: string) => {
    try {
      await api.unblockUser(userId);
      setRows((prev) => prev?.filter((b) => b.userId !== userId) ?? prev);
    } catch (err) {
      setError(messageOf(err));
    }
  };

  return (
    <Dialog title="Blocked accounts" onClose={onClose}>
      <div className="p-4">
        {error && <p className="mb-3 text-xs text-rose-600">{error}</p>}
        {rows === null ? (
          <div className="flex justify-center py-8"><Spinner /></div>
        ) : rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-ink-400">You have not blocked anyone.</p>
        ) : (
          rows.map((b) => (
            <div key={b.userId} className="flex items-center gap-2 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-ink-900 dark:text-white">
                  {b.displayName ?? b.phone ?? "Convo user"}
                </p>
                <p className="truncate text-xs text-ink-400">{b.phone ?? "phone hidden"}</p>
              </div>
              <button className="text-xs font-semibold text-iris-600 hover:underline" onClick={() => void unblock(b.userId)}>
                Unblock
              </button>
            </div>
          ))
        )}
      </div>
    </Dialog>
  );
}

/** Mute/pin/archive state used by the chat list row. */
export function chatFlags(conversation: ConversationSummary): { pinned: boolean; muted: boolean; archived: boolean } {
  return {
    pinned: conversation.pinned,
    muted: conversation.mutedUntil !== null && new Date(conversation.mutedUntil) > new Date(),
    archived: conversation.archived,
  };
}

export function messageOf(err: unknown): string {
  if (err instanceof ApiRequestError) return err.message;
  return err instanceof Error ? err.message : "Something went wrong";
}
