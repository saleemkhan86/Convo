import { useCallback, useEffect, useState } from "react";
import type { MailConnection } from "@convo/shared";
import { CheckIcon, MailIcon, RefreshIcon, TrashIcon } from "./icons";
import { Badge, Button, cx } from "./ui";
import { api, ApiRequestError } from "../lib/api";

export function MailConnectionsSection() {
  const [connections, setConnections] = useState<MailConnection[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const loadConnections = useCallback(async () => {
    try {
      setError(null);
      const result = await api.listMailConnections();
      setConnections(result.connections);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to load connections");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadConnections();
  }, [loadConnections]);

  const connectGmail = async () => {
    try {
      setError(null);
      const result = await api.startGoogleOAuth();
      window.location.href = result.authorizationUrl;
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to start OAuth");
    }
  };

  const syncConnection = async (id: string) => {
    setSyncingId(id);
    try {
      await api.syncMailConnection(id);
      await loadConnections();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Sync failed");
    } finally {
      setSyncingId(null);
    }
  };

  const deleteConnection = async (id: string) => {
    if (!confirm("Disconnect this mailbox? You'll stop receiving new emails.")) return;
    setDeletingId(id);
    try {
      await api.deleteMailConnection(id);
      await loadConnections();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to disconnect");
    } finally {
      setDeletingId(null);
    }
  };

  if (loading) {
    return (
      <div className="rounded-card border border-ink-200/70 px-4 py-6 dark:border-night-border">
        <div className="flex items-center justify-center">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-ink-300 border-t-iris-500" />
        </div>
      </div>
    );
  }

  const activeConnections = connections?.filter((c) => c.status !== "REVOKED") ?? [];

  return (
    <div className="space-y-3">
      <div className="rounded-card border border-ink-200/70 px-4 py-3.5 dark:border-night-border">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-ink-50 dark:bg-night-raised">
              <MailIcon className="h-5 w-5 text-signal-500" />
            </span>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">Gmail</p>
              {activeConnections.length > 0 ? (
                <p className="text-sm font-semibold text-ink-800 dark:text-ink-100">
                  {activeConnections[0]?.emailAddress}
                </p>
              ) : (
                <p className="text-sm text-ink-400">Not connected</p>
              )}
            </div>
          </div>
          {activeConnections.length === 0 ? (
            <Button variant="secondary" className="!px-3.5 !py-2 text-xs" onClick={() => void connectGmail()}>
              Connect Gmail
            </Button>
          ) : (
            <Badge tone="success">
              <CheckIcon /> Connected
            </Badge>
          )}
        </div>

        {activeConnections.length > 0 && (
          <div className="mt-3 space-y-2 border-t border-ink-100 pt-3 dark:border-night-border">
            {activeConnections.map((conn) => (
              <ConnectionRow
                key={conn.id}
                connection={conn}
                syncing={syncingId === conn.id}
                deleting={deletingId === conn.id}
                onSync={() => void syncConnection(conn.id)}
                onDelete={() => void deleteConnection(conn.id)}
              />
            ))}
          </div>
        )}
      </div>

      {error && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-500/10 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}

function ConnectionRow({
  connection,
  syncing,
  deleting,
  onSync,
  onDelete,
}: {
  connection: MailConnection;
  syncing: boolean;
  deleting: boolean;
  onSync: () => void;
  onDelete: () => void;
}) {
  const statusTone =
    connection.status === "CONNECTED"
      ? "success"
      : connection.status === "NEEDS_REAUTH"
        ? "neutral"
        : "neutral";

  const statusLabel =
    connection.status === "CONNECTED"
      ? "Active"
      : connection.status === "NEEDS_REAUTH"
        ? "Needs re-auth"
        : connection.status === "ERROR"
          ? "Error"
          : connection.status;

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Badge tone={statusTone}>{statusLabel}</Badge>
          {connection.lastSyncedAt && (
            <span className="text-[11px] text-ink-400">
              Synced {relativeTime(connection.lastSyncedAt)}
            </span>
          )}
        </div>
        {connection.statusReason && (
          <p className="mt-1 truncate text-xs text-ink-500 dark:text-ink-400">
            {connection.statusReason}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          className="!px-2 !py-1.5"
          onClick={onSync}
          disabled={syncing || deleting}
          title="Sync now"
        >
          <RefreshIcon className={cx("h-4 w-4", syncing && "animate-spin")} />
        </Button>
        <Button
          variant="ghost"
          className="!px-2 !py-1.5 text-red-500 hover:text-red-600"
          onClick={onDelete}
          disabled={syncing || deleting}
          title="Disconnect"
        >
          <TrashIcon className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
