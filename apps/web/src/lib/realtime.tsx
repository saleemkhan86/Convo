import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { WsClientEvent, WsServerEvent } from "@convo/shared";
import { currentAccessToken, realtimeUrl, tryRefresh } from "./api";

type Listener = (event: WsServerEvent) => void;

interface RealtimeValue {
  status: "connecting" | "open" | "closed";
  subscribe: (listener: Listener) => () => void;
  send: (event: WsClientEvent) => void;
}

const RealtimeContext = createContext<RealtimeValue | null>(null);

const KEEPALIVE_MS = 25_000;
const MAX_BACKOFF_MS = 20_000;

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<RealtimeValue["status"]>("closed");
  const wsRef = useRef<WebSocket | null>(null);
  const listeners = useRef(new Set<Listener>());
  const retry = useRef(0);
  const closedByUs = useRef(false);
  const keepalive = useRef<number | null>(null);

  const subscribe = useCallback((listener: Listener) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  const send = useCallback((event: WsClientEvent) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
  }, []);

  useEffect(() => {
    closedByUs.current = false;

    function clearKeepalive() {
      if (keepalive.current !== null) {
        window.clearInterval(keepalive.current);
        keepalive.current = null;
      }
    }

    function scheduleReconnect() {
      clearKeepalive();
      if (closedByUs.current) return;
      const delay = Math.min(1000 * 2 ** retry.current, MAX_BACKOFF_MS);
      retry.current += 1;
      window.setTimeout(connect, delay);
    }

    function connect() {
      if (!currentAccessToken()) {
        setStatus("closed");
        return;
      }
      const url = realtimeUrl();
      if (!url) return;
      setStatus("connecting");
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        retry.current = 0;
        setStatus("open");
        clearKeepalive();
        keepalive.current = window.setInterval(() => send({ type: "ping" }), KEEPALIVE_MS);
      };
      ws.onmessage = (raw) => {
        try {
          const event = JSON.parse(raw.data as string) as WsServerEvent;
          for (const listener of listeners.current) listener(event);
        } catch {
          // ignore malformed frames
        }
      };
      ws.onclose = (evt) => {
        wsRef.current = null;
        clearKeepalive();
        if (closedByUs.current) {
          setStatus("closed");
          return;
        }
        // 4401 = token expired/invalid → refresh once, then reconnect.
        if (evt.code === 4401) {
          setStatus("closed");
          void tryRefresh().then((ok) => {
            if (ok && !closedByUs.current) connect();
          });
          return;
        }
        setStatus("closed");
        scheduleReconnect();
      };
      ws.onerror = () => {
        ws.close();
      };
    }

    connect();

    return () => {
      closedByUs.current = true;
      clearKeepalive();
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws) {
        if (ws.readyState === WebSocket.CONNECTING) {
          // Closing a still-connecting socket logs a browser warning; wait for
          // it to open, then close cleanly.
          ws.onopen = () => ws.close();
        } else {
          ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
          ws.close();
        }
      }
    };
  }, [send]);

  const value = useMemo(() => ({ status, subscribe, send }), [status, subscribe, send]);
  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtime(): RealtimeValue {
  const ctx = useContext(RealtimeContext);
  if (!ctx) throw new Error("useRealtime must be used within RealtimeProvider");
  return ctx;
}

/** Subscribe to realtime events for the lifetime of the calling component. */
export function useRealtimeSubscription(listener: Listener): void {
  const { subscribe } = useRealtime();
  const ref = useRef(listener);
  ref.current = listener;
  useEffect(() => subscribe((event) => ref.current(event)), [subscribe]);
}
