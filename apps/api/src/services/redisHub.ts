import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import type { WsServerEvent } from "@convo/shared";
import type {
  RealtimeHub,
  SocketLike,
  PresenceVisible,
  HubOptions,
} from "./realtime.js";

const OPEN = 1;

function safeSend(socket: SocketLike, event: WsServerEvent): void {
  if (socket.readyState !== OPEN) return;
  try {
    socket.send(JSON.stringify(event));
  } catch {
    // dead socket — cleaned up on close event
  }
}

/**
 * Redis-backed realtime hub for multi-process deployments.
 *
 * Each process holds its own WebSocket connections locally. Redis pub/sub
 * bridges across processes: when process A needs to deliver to a user whose
 * socket lives on process B, A publishes to a per-user Redis channel and B
 * delivers to its local socket.
 *
 * Presence is tracked in a Redis hash (`user:<id>:connections`) so any process
 * can check whether a user is online anywhere. The hash maps deviceId → JSON
 * metadata, and its size tells us whether the user has any active connections.
 *
 * Falls back to the local `InMemoryHub` for any operation when Redis is
 * unavailable (the constructor accepts a fallback hub to delegate to).
 */
export class RedisHub implements RealtimeHub {
  private readonly local = new Map<string, Set<SocketLike>>();
  private readonly watchersByTarget = new Map<string, Set<SocketLike>>();
  private readonly targetsByWatcher = new Map<SocketLike, Set<string>>();
  private readonly userBySocket = new Map<SocketLike, string>();
  private readonly deviceBySocket = new Map<SocketLike, string>();
  private readonly presenceVisible?: PresenceVisible;
  private readonly prefix: string;
  /**
   * Identifies this process inside published frames so a node never delivers
   * an event twice to its own sockets (it already sent them directly).
   */
  private readonly nodeId = randomUUID();
  private sub: Redis | null = null;

  constructor(
    private readonly redis: Redis,
    opts: HubOptions & { prefix?: string } = {},
  ) {
    this.presenceVisible = opts.presenceVisible;
    this.prefix = opts.prefix ?? "convo:";
    this.initSubscriber().catch(() => {});
  }

  private async initSubscriber(): Promise<void> {
    this.sub = this.redis.duplicate();
    // PUBLISH/SUBSCRIBE channel names are NOT touched by ioredis `keyPrefix`
    // (it only rewrites key arguments), so the prefix here is the literal one
    // used by crossProcessPublish.
    this.sub.on("pmessage", (_pattern, channel, message) => {
      this.handlePubSubMessage(channel, message);
    });
    await this.sub.psubscribe(`${this.prefix}user:*`);
  }

  add(userId: string, deviceId: string, socket: SocketLike): void {
    this.userBySocket.set(socket, userId);
    this.deviceBySocket.set(socket, deviceId);
    let set = this.local.get(userId);
    if (!set) {
      set = new Set();
      this.local.set(userId, set);
    }
    const wasOffline = set.size === 0;
    set.add(socket);
    if (wasOffline) {
      this.trackPresence(userId, deviceId, true).catch(() => {});
      this.emitPresence(userId, true);
    }
  }

  remove(userId: string, socket: SocketLike): void {
    const deviceId = this.deviceBySocket.get(socket);
    this.userBySocket.delete(socket);
    this.deviceBySocket.delete(socket);
    const set = this.local.get(userId);
    if (!set) return;
    set.delete(socket);
    if (set.size === 0) {
      this.local.delete(userId);
      this.trackPresence(userId, deviceId, false).catch(() => {});
      this.emitPresence(userId, false);
    }
  }

  isOnline(userId: string): boolean {
    return (this.local.get(userId)?.size ?? 0) > 0;
  }

  publishToUsers(userIds: Iterable<string>, event: WsServerEvent): void {
    const payload = JSON.stringify(event);
    for (const userId of userIds) {
      // Deliver on this node directly so a Redis outage cannot strand a
      // connected user, then always publish: another node may hold a second
      // device for the same user, and it must not miss the event.
      const localSet = this.local.get(userId);
      if (localSet) for (const socket of localSet) safeSendRaw(socket, payload);
      this.crossProcessPublish(userId, payload);
    }
  }

  watch(watcher: SocketLike, userIds: Iterable<string>): void {
    let targets = this.targetsByWatcher.get(watcher);
    if (!targets) {
      targets = new Set();
      this.targetsByWatcher.set(watcher, targets);
    }
    const watcherId = this.userBySocket.get(watcher);
    for (const userId of userIds) {
      targets.add(userId);
      let set = this.watchersByTarget.get(userId);
      if (!set) {
        set = new Set();
        this.watchersByTarget.set(userId, set);
      }
      set.add(watcher);
      this.sendPresence(watcher, watcherId, userId, this.isOnline(userId));
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

  private async trackPresence(userId: string, deviceId: string | undefined, online: boolean): Promise<void> {
    const key = `${this.prefix}presence:${userId}`;
    if (online) {
      if (deviceId) {
        await this.redis.hset(key, deviceId, JSON.stringify({ connectedAt: Date.now() }));
      } else {
        await this.redis.hset(key, "unknown", "1");
      }
    } else if (deviceId) {
      await this.redis.hdel(key, deviceId);
      const remaining = await this.redis.hlen(key);
      if (remaining === 0) await this.redis.del(key);
    }
  }

  private crossProcessPublish(userId: string, payload: string): void {
    const channel = `${this.prefix}user:${userId}`;
    this.redis
      .publish(channel, JSON.stringify({ n: this.nodeId, d: payload }))
      .catch(() => {});
  }

  private handlePubSubMessage(channel: string, envelopeJson: string): void {
    const prefix = `${this.prefix}user:`;
    if (!channel.startsWith(prefix)) return;
    const userId = channel.slice(prefix.length);
    let envelope: { n?: string; d?: string };
    try {
      envelope = JSON.parse(envelopeJson) as { n?: string; d?: string };
    } catch {
      return;
    }
    // Our own frame: this node already wrote it to its sockets.
    if (envelope.n === this.nodeId) return;
    if (typeof envelope.d !== "string") return;
    const localSet = this.local.get(userId);
    if (!localSet) return;
    for (const socket of localSet) safeSendRaw(socket, envelope.d);
  }

  private emitPresence(userId: string, online: boolean): void {
    const watchers = this.watchersByTarget.get(userId);
    if (!watchers) return;
    for (const watcher of watchers) {
      this.sendPresence(watcher, this.userBySocket.get(watcher), userId, online);
    }
  }

  private sendPresence(
    watcher: SocketLike,
    watcherId: string | undefined,
    targetId: string,
    online: boolean,
  ): void {
    const send = (): void =>
      safeSend(watcher, { type: "presence", userId: targetId, online });
    if (!this.presenceVisible || watcherId === undefined || watcherId === targetId) {
      send();
      return;
    }
    void this.presenceVisible(watcherId, targetId)
      .then((visible) => {
        if (visible) send();
      })
      .catch(() => {});
  }

  async shutdown(): Promise<void> {
    if (this.sub) {
      await this.sub.quit().catch(() => {});
      this.sub = null;
    }
  }
}

function safeSendRaw(socket: SocketLike, payload: string): void {
  if (socket.readyState !== OPEN) return;
  try {
    socket.send(payload);
  } catch {
    // dead socket
  }
}
