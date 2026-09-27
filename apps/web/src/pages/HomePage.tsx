import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ChatIcon, ContactsIcon, MailIcon, PhoneIcon, PlusIcon, SearchIcon, SettingsIcon } from "../components/icons";
import { Badge, Button, Logo, cx } from "../components/ui";
import { useAuth } from "../lib/auth";

type Section = "chats" | "mail";

export function HomePage() {
  const { account } = useAuth();
  const [section, setSection] = useState<Section>("chats");

  if (!account) return null;
  const chatsAvailable = account.capabilities.chats;
  const mailAvailable = account.capabilities.mail;
  const activeAvailable = section === "chats" ? chatsAvailable : mailAvailable;

  return (
    <div className="flex h-full">
      {/* Left navigation rail (desktop) */}
      <aside className="hidden w-64 shrink-0 flex-col border-r border-ink-200/70 bg-white md:flex dark:border-night-border dark:bg-night-surface">
        <div className="px-5 py-5">
          <Logo />
        </div>
        <nav className="flex-1 space-y-1 px-3">
          <NavItem icon={<ChatIcon />} label="Chats" active={section === "chats"} onClick={() => setSection("chats")}
            badge={chatsAvailable ? undefined : "Connect"} />
          <NavItem icon={<MailIcon />} label="Mail" active={section === "mail"} onClick={() => setSection("mail")}
            badge={mailAvailable ? undefined : "Connect"} />
          <NavItem icon={<ContactsIcon />} label="Contacts" disabled soon />
          <Link to="/settings">
            <NavItem icon={<SettingsIcon />} label="Settings" />
          </Link>
        </nav>
        <div className="border-t border-ink-200/70 p-4 dark:border-night-border">
          <div className="flex items-center gap-3">
            <Avatar name={account.displayName ?? account.email?.email ?? account.phone?.phone ?? "?"} />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-ink-800 dark:text-ink-100">
                {account.displayName ?? "Your Convo"}
              </p>
              <p className="truncate text-xs text-ink-400">
                {account.email?.email ?? account.phone?.phone}
              </p>
            </div>
          </div>
        </div>
      </aside>

      {/* Conversation column */}
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-3 border-b border-ink-200/70 bg-white/80 px-5 py-4 backdrop-blur dark:border-night-border dark:bg-night-surface/80">
          <div className="flex items-center gap-3 md:hidden">
            <Logo />
          </div>
          <div className="hidden md:block">
            <h1 className="text-lg font-bold tracking-tight text-ink-900 dark:text-white">
              {section === "chats" ? "Chats" : "Mail"}
            </h1>
            <p className="text-xs text-ink-400">
              {section === "chats" ? "Phone-number messaging" : "Email conversations"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative hidden sm:block">
              <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
              <input
                placeholder={`Search ${section}…`}
                disabled={!activeAvailable}
                className="w-52 rounded-full border border-ink-200 bg-ink-50 py-2 pl-9 pr-4 text-sm placeholder:text-ink-400 focus:border-iris-400 focus:outline-none disabled:opacity-50 dark:border-night-border dark:bg-night-raised"
              />
            </div>
            <Button className="!px-3.5" disabled={!activeAvailable} title={activeAvailable ? "New" : "Connect an identity first"}>
              <PlusIcon className="h-4 w-4" />
              <span className="hidden sm:inline">{section === "chats" ? "New chat" : "New mail"}</span>
            </Button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto">
          {activeAvailable ? (
            <EmptyConversations section={section} />
          ) : (
            <ConnectIdentityPrompt section={section} />
          )}
        </div>

        {/* Bottom tab bar (mobile browsers) */}
        <nav className="flex border-t border-ink-200/70 bg-white md:hidden dark:border-night-border dark:bg-night-surface">
          <TabButton icon={<ChatIcon />} label="Chats" active={section === "chats"} onClick={() => setSection("chats")} />
          <TabButton icon={<MailIcon />} label="Mail" active={section === "mail"} onClick={() => setSection("mail")} />
          <Link to="/settings" className="flex-1">
            <div className="flex flex-col items-center gap-1 py-2.5 text-ink-500">
              <SettingsIcon className="h-5 w-5" />
              <span className="text-[11px] font-medium">Settings</span>
            </div>
          </Link>
        </nav>
      </main>

      {/* Details panel (wide desktop) */}
      <aside className="hidden w-72 shrink-0 flex-col border-l border-ink-200/70 bg-white xl:flex dark:border-night-border dark:bg-night-surface">
        <div className="border-b border-ink-200/70 px-5 py-4 dark:border-night-border">
          <h2 className="text-sm font-bold text-ink-900 dark:text-white">Your Convo</h2>
        </div>
        <div className="flex-1 space-y-4 p-5">
          <IdentityRow label="Phone Number" value={account.phone?.phone} connectPath="/settings/connect-phone" connectLabel="Connect Phone Number" />
          <IdentityRow label="Email" value={account.email?.email} connectPath="/settings/connect-email" connectLabel="Connect Email" />
          <div className="rounded-card bg-ink-50 p-4 text-xs leading-relaxed text-ink-500 dark:bg-night-raised dark:text-ink-400">
            Both identities live on one Convo account. Connect the other one any
            time to unlock {account.capabilities.chats ? "Mail" : "Chats"}.
          </div>
        </div>
      </aside>
    </div>
  );
}

function NavItem({
  icon,
  label,
  active,
  onClick,
  disabled,
  soon,
  badge,
}: {
  icon: ReactNode;
  label: string;
  active?: boolean;
  onClick?: () => void;
  disabled?: boolean;
  soon?: boolean;
  badge?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cx(
        "flex w-full items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-semibold transition-colors disabled:opacity-40",
        active
          ? "bg-iris-50 text-iris-700 dark:bg-iris-500/15 dark:text-iris-300"
          : "text-ink-600 hover:bg-ink-100 dark:text-ink-300 dark:hover:bg-night-raised",
      )}
    >
      {icon}
      <span className="flex-1 text-left">{label}</span>
      {soon && <Badge>Soon</Badge>}
      {badge && <Badge tone="iris">{badge}</Badge>}
    </button>
  );
}

function TabButton({ icon, label, active, onClick }: { icon: ReactNode; label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cx(
        "flex flex-1 flex-col items-center gap-1 py-2.5 transition-colors",
        active ? "text-iris-600 dark:text-iris-400" : "text-ink-500",
      )}
    >
      {icon}
      <span className="text-[11px] font-medium">{label}</span>
    </button>
  );
}

function Avatar({ name }: { name: string }) {
  const initial = name.replace(/[^\p{L}\p{N}]/gu, "").charAt(0).toUpperCase() || "?";
  return (
    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-iris-500 to-signal-400 text-sm font-bold text-white">
      {initial}
    </span>
  );
}

function IdentityRow({
  label,
  value,
  connectPath,
  connectLabel,
}: {
  label: string;
  value: string | null | undefined;
  connectPath: string;
  connectLabel: string;
}) {
  return (
    <div className="rounded-card border border-ink-200/70 p-4 dark:border-night-border">
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">{label}</p>
      {value ? (
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <p className="truncate text-sm font-semibold text-ink-800 dark:text-ink-100">{value}</p>
          <Badge tone="success">Verified</Badge>
        </div>
      ) : (
        <div className="mt-2 space-y-2">
          <p className="text-sm text-ink-400">Not connected</p>
          <Link to={connectPath}>
            <Button variant="secondary" className="w-full !px-3 !py-2 text-xs">
              <PhoneIcon className="h-3.5 w-3.5" /> {connectLabel}
            </Button>
          </Link>
        </div>
      )}
    </div>
  );
}

function ConnectIdentityPrompt({ section }: { section: Section }) {
  const isChats = section === "chats";
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-sm animate-rise text-center">
        <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-iris-500 to-signal-400 text-white shadow-lg shadow-iris-500/20">
          {isChats ? <ChatIcon className="h-7 w-7" /> : <MailIcon className="h-7 w-7" />}
        </span>
        <h2 className="mt-5 text-xl font-bold tracking-tight text-ink-900 dark:text-white">
          {isChats ? "Connect a phone number to start using Chats" : "Connect an email address to start using Mail"}
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-500 dark:text-ink-400">
          {isChats
            ? "Chats are instant messaging with phone numbers. Add your phone identity to this account — everything stays under one Convo."
            : "Mail lets you message any email address, chat-style. Add your email identity to this account to send and receive."}
        </p>
        <Link to={isChats ? "/settings/connect-phone" : "/settings/connect-email"}>
          <Button className="mt-6">
            {isChats ? "Connect Phone Number" : "Connect Email"}
          </Button>
        </Link>
      </div>
    </div>
  );
}

function EmptyConversations({ section }: { section: Section }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-sm text-center">
        <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-ink-100 text-ink-400 dark:bg-night-raised">
          {section === "chats" ? <ChatIcon className="h-6 w-6" /> : <MailIcon className="h-6 w-6" />}
        </span>
        <h2 className="mt-4 text-lg font-bold text-ink-900 dark:text-white">
          {section === "chats" ? "No conversations yet" : "No mail yet"}
        </h2>
        <p className="mt-1.5 text-sm text-ink-500 dark:text-ink-400">
          {section === "chats"
            ? "Start a new chat with a contact — real-time messaging arrives in Phase 2."
            : "Compose a new mail to anyone — Convo users or external addresses."}
        </p>
      </div>
    </div>
  );
}
