import type { WsServerEvent } from "@convo/shared";

/**
 * Minimal transport surface the hub needs, so tests can stub sockets.
 * Compatible with `ws` WebSocket instances.
 */
export interface SocketLike {
  send(data: string): void;
  readyState: number;
}

const OPEN = 1;

export interface RealtimeHub {
  add(userId: string, socket: SocketLike): void;
  remove(userId: string, socket: SocketLike): void;
  isOnline(userId: string): boolean;
  publishToUsers(userIds: Iterable<string>, event: WsServerEvent): void;
  /** Subscribe a socket to presence transitions of the given users. */
  watch(watcher: SocketLike, userIds: Iterable<string>): void;
  /** Drop all watch subscriptions held by a socket (on disconnect). */
  unwatchAll(watcher: SocketLike): void;
}

function safeSend(socket: SocketLike, event: WsServerEvent): void {
  if (socket.readyState !== OPEN) return;
  try {
    socket.send(JSON.stringify(event));
  } catch {
    // A dead socket will be cleaned up on its close event.
  }
}

/**
 * Single-process in-memory hub. Horizontal scaling requires a pub/sub
 * backend (e.g. Redis); the interface is the seam for that swap (docs/TODO).
 */
export class InMemoryHub implements RealtimeHub {
  private readonly sockets = new Map<string, Set<SocketLike>>();
  private readonly watchersByTarget = new Map<string, Set<SocketLike>>();
  private readonly targetsByWatcher = new Map<SocketLike, Set<string>>();

  add(userId: string, socket: SocketLike): void {
    let set = this.sockets.get(userId);
    if (!set) {
      set = new Set();
      this.sockets.set(userId, set);
    }
    const wasOffline = set.size === 0;
    set.add(socket);
    if (wasOffline) this.emitPresence(userId, true);
  }

  remove(userId: string, socket: SocketLike): void {
    const set = this.sockets.get(userId);
    if (!set) return;
    set.delete(socket);
    if (set.size === 0) {
      this.sockets.delete(userId);
      this.emitPresence(userId, false);
    }
  }

  isOnline(userId: string): boolean {
    const set = this.sockets.get(userId);
    return set !== undefined && set.size > 0;
  }

  publishToUsers(userIds: Iterable<string>, event: WsServerEvent): void {
    for (const userId of userIds) {
      const set = this.sockets.get(userId);
      if (!set) continue;
      for (const socket of set) safeSend(socket, event);
    }
  }

  watch(watcher: SocketLike, userIds: Iterable<string>): void {
    let targets = this.targetsByWatcher.get(watcher);
    if (!targets) {
      targets = new Set();
      this.targetsByWatcher.set(watcher, targets);
    }
    for (const userId of userIds) {
      targets.add(userId);
      let set = this.watchersByTarget.get(userId);
      if (!set) {
        set = new Set();
        this.watchersByTarget.set(userId, set);
      }
      set.add(watcher);
      safeSend(watcher, { type: "presence", userId, online: this.isOnline(userId) });
    }
  }

  unwatchAll(watcher: SocketLike): void {
    const targets = this.targetsByWatcher.get(watcher);
    if (!targets) return;
    for (const userId of targets) {
      const set = this.watchersByTarget.get(userId);
      if (!set) continue;
      set.delete(watcher);
      if (set.size === 0) this.watchersByTarget.delete(userId);
    }
    this.targetsByWatcher.delete(watcher);
  }

  private emitPresence(userId: string, online: boolean): void {
    const watchers = this.watchersByTarget.get(userId);
    if (!watchers) return;
    for (const watcher of watchers) safeSend(watcher, { type: "presence", userId, online });
  }
}
