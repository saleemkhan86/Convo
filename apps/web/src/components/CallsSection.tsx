import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { CallSummary } from "@convo/shared";
import { useCall, callPeerLabel, formatCallDuration } from "../lib/calls";
import { api } from "../lib/api";
import { useRealtimeSubscription } from "../lib/realtime";
import {
  CallIncomingIcon,
  CallOutgoingIcon,
  PhoneIcon,
  VideoIcon,
} from "./icons";
import { Spinner, cx } from "./ui";

/**
 * The call log (Phase 5F), WhatsApp-style: one row per call attempt, missed
 * ones first-class, with the two dial buttons that start a fresh call into the
 * same chat. It reads the server's records rather than local state, so a call
 * that happened on the phone shows up here after a reload.
 */
export function CallsSection() {
  const [calls, setCalls] = useState<CallSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [missedOnly, setMissedOnly] = useState(false);
  const [missed, setMissed] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { start, phase } = useCall();

  const load = useCallback(
    async (replace: boolean) => {
      setLoading(true);
      setError(null);
      try {
        const [page, count] = await Promise.all([
          api.callHistory({
            missedOnly,
            cursor: replace ? undefined : (cursor ?? undefined),
          }),
          api.missedCallCount(),
        ]);
        setCalls((prev) => (replace ? page.items : [...prev, ...page.items]));
        setCursor(page.nextCursor);
        setMissed(count.count);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load your calls.");
      } finally {
        setLoading(false);
      }
    },
    [cursor, missedOnly],
  );

  useEffect(() => {
    void load(true);
    // Only the filter (and the mount) reloads; paging is driven by the button.
  }, [missedOnly]);

  // A call that just ended belongs in the log immediately, and the missed
  // badge has to drop when the ring resolves either way.
  useRealtimeSubscription(
    useCallback((event) => {
      if (event.type === "call.ended" || event.type === "call.incoming") void load(true);
    }, [load]),
  );

  const calling = phase !== "idle" && phase !== "ended";

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-ink-200/70 px-4 py-3 dark:border-night-border">
        <h2 className="text-sm font-bold text-ink-900 dark:text-white">Calls</h2>
        <div className="ml-auto flex items-center gap-1 rounded-full bg-ink-100 p-1 dark:bg-night-raised">
          <FilterChip active={!missedOnly} onClick={() => setMissedOnly(false)}>
            All
          </FilterChip>
          <FilterChip active={missedOnly} onClick={() => setMissedOnly(true)}>
            Missed{missed > 0 ? ` (${missed})` : ""}
          </FilterChip>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && <p className="px-4 py-3 text-xs text-rose-600">{error}</p>}
        {!error && calls.length === 0 && !loading && (
          <p className="px-4 py-10 text-center text-sm text-ink-400">
            {missedOnly ? "No missed calls." : "No calls yet. Start one from any chat."}
          </p>
        )}
        <ul>
          {calls.map((call) => (
            <CallRow
              key={call.id}
              call={call}
              disabled={calling}
              onCall={(mediaType) => void start(call.conversationId, mediaType)}
            />
          ))}
        </ul>
        {loading && (
          <div className="flex justify-center py-4">
            <Spinner className="h-5 w-5 text-iris-500" />
          </div>
        )}
        {!loading && cursor && (
          <div className="flex justify-center py-4">
            <button
              onClick={() => void load(false)}
              className="rounded-full px-4 py-1.5 text-xs font-semibold text-iris-600 hover:bg-iris-50 dark:text-iris-300 dark:hover:bg-night-raised"
            >
              Load earlier calls
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cx(
        "rounded-full px-3 py-1 text-xs font-semibold transition-colors",
        active
          ? "bg-white text-ink-900 shadow-sm dark:bg-night-surface dark:text-white"
          : "text-ink-500 dark:text-ink-400",
      )}
    >
      {children}
    </button>
  );
}

function CallRow({
  call,
  disabled,
  onCall,
}: {
  call: CallSummary;
  disabled: boolean;
  onCall: (mediaType: "VOICE" | "VIDEO") => void;
}) {
  const missedCall = call.status === "MISSED";
  const outgoing = call.direction === "OUTGOING";
  const DirectionIcon = outgoing ? CallOutgoingIcon : CallIncomingIcon;
  return (
    <li className="flex items-center gap-3 border-b border-ink-100 px-4 py-3 last:border-0 dark:border-night-border">
      <span
        className={cx(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
          missedCall ? "bg-rose-500/15 text-rose-500" : "bg-ink-100 text-ink-500 dark:bg-night-raised dark:text-ink-300",
        )}
      >
        <DirectionIcon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-ink-900 dark:text-white">
          {callPeerLabel(call) || "Your contact"}
        </p>
        <p
          className={cx(
            "truncate text-xs",
            missedCall ? "font-semibold text-rose-500" : "text-ink-400",
          )}
        >
          {callLabel(call)} · {relativeTime(call.createdAt)}
        </p>
      </div>
      <button
        onClick={() => onCall("VOICE")}
        disabled={disabled}
        title="Voice call"
        aria-label="Voice call"
        className="rounded-full p-2 text-iris-600 transition-colors hover:bg-iris-50 disabled:opacity-40 dark:text-iris-300 dark:hover:bg-night-raised"
      >
        <PhoneIcon className="h-4 w-4" />
      </button>
      <button
        onClick={() => onCall("VIDEO")}
        disabled={disabled}
        title="Video call"
        aria-label="Video call"
        className="rounded-full p-2 text-iris-600 transition-colors hover:bg-iris-50 disabled:opacity-40 dark:text-iris-300 dark:hover:bg-night-raised"
      >
        <VideoIcon className="h-4 w-4" />
      </button>
    </li>
  );
}

/** The one line under a contact's name: what happened, and for how long. */
export function callLabel(call: CallSummary): string {
  const kind = call.mediaType === "VIDEO" ? "video" : "voice";
  switch (call.status) {
    case "ENDED":
      return `Call ${call.durationSeconds !== null ? formatCallDuration(call.durationSeconds) : "ended"}`;
    case "MISSED":
      return `Missed ${kind} call`;
    case "DECLINED":
      return outgoingText(call, "declined");
    case "CANCELED":
      return `Canceled ${kind} call`;
    case "BUSY":
      return `Busy ${kind} call`;
    case "FAILED":
      return `Failed ${kind} call`;
    case "RINGING":
      return `Ringing ${kind} call`;
    case "CONNECTED":
      return `Ongoing ${kind} call`;
    default:
      return `${kind} call`;
  }
}

function outgoingText(call: CallSummary, word: string): string {
  return call.direction === "OUTGOING"
    ? `${word} ${call.mediaType === "VIDEO" ? "video" : "voice"} call`
    : `You ${word} the ${call.mediaType === "VIDEO" ? "video" : "voice"} call`;
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const minutes = Math.round((Date.now() - then) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
