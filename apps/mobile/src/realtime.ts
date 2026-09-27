import { useEffect, useRef, useSyncExternalStore } from "react";
import type { WsClientEvent, WsServerEvent } from "@convo/shared";
import { currentAccessToken, realtimeUrl, tryRefresh } from "./api";

type Listener = (event: WsServerEvent) => void;
type Status = "connecting" | "open" | "closed";

const KEEPALIVE_MS = 25_000;
const MAX_BACKOFF_MS = 20_000;

let ws: WebSocket | null = null;
let status: Status = "closed";
let retry = 0;
let closedByUs = true;
let keepalive: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

const listeners = new Set<Listener>();
const statusListeners = new Set<() => void>();

function setStatus(next: Status) {
  if (status === next) return;
  status = next;
  for (const cb of statusListeners) cb();
}

function clearKeepalive() {
  if (keepalive !== null) {
    clearInterval(keepalive);
    keepalive = null;
  }
}

function send(event: WsClientEvent) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
}

function scheduleReconnect() {
  clearKeepalive();
  if (closedByUs || reconnectTimer) return;
  const delay = Math.min(1000 * 2 ** retry, MAX_BACKOFF_MS);
  retry += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function connect() {
  if (!currentAccessToken()) {
    setStatus("closed");
    return;
  }
  const url = realtimeUrl();
  if (!url) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  setStatus("connecting");
  const sock = new WebSocket(url);
  ws = sock;

  sock.onopen = () => {
    if (ws !== sock) return;
    retry = 0;
    setStatus("open");
    clearKeepalive();
    keepalive = setInterval(() => send({ type: "ping" }), KEEPALIVE_MS);
  };
  sock.onmessage = (raw) => {
    if (ws !== sock) return;
    try {
      const event = JSON.parse(String(raw.data)) as WsServerEvent;
      for (const listener of listeners) listener(event);
    } catch {
      // ignore malformed frames
    }
  };
  sock.onclose = (evt) => {
    if (ws !== sock) return;
    ws = null;
    clearKeepalive();
    if (closedByUs) {
      setStatus("closed");
      return;
    }
    if (evt.code === 4401) {
      setStatus("closed");
      void tryRefresh().then((ok) => {
        if (ok && !closedByUs) connect();
      });
      return;
    }
    setStatus("closed");
    scheduleReconnect();
  };
  sock.onerror = () => {
    if (ws !== sock) return;
    sock.close();
  };
}

/** Open the realtime connection (idempotent). Call once while authenticated. */
export function connectRealtime() {
  closedByUs = false;
  connect();
}

/** Close the realtime connection and stop reconnecting. */
export function disconnectRealtime() {
  closedByUs = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  clearKeepalive();
  const sock = ws;
  ws = null;
  if (sock) {
    if (sock.readyState === WebSocket.CONNECTING) {
      sock.onopen = () => sock.close();
    } else {
      sock.onopen = sock.onmessage = sock.onerror = sock.onclose = null;
      sock.close();
    }
  }
  setStatus("closed");
}

function subscribeStatus(cb: () => void) {
  statusListeners.add(cb);
  return () => statusListeners.delete(cb);
}

function getStatus(): Status {
  return status;
}

/** Reactive realtime connection status. */
export function useRealtimeStatus(): Status {
  return useSyncExternalStore(subscribeStatus, getStatus, getStatus);
}

/** Subscribe to realtime events for the lifetime of the calling component. */
export function useRealtimeEvents(listener: Listener): void {
  const ref = useRef(listener);
  ref.current = listener;
  useEffect(() => {
    const wrapped: Listener = (event) => ref.current(event);
    listeners.add(wrapped);
    return () => {
      listeners.delete(wrapped);
    };
  }, []);
}

export { send as sendRealtime };
