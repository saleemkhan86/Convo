import { describe, expect, it } from "vitest";
import { RedisHub } from "../src/services/redisHub";
import type { WsServerEvent } from "@convo/shared";
import type { Redis } from "ioredis";
import type { SocketLike } from "./realtime";

const OPEN = 1;

class FakeSocket implements SocketLike {
  readyState = OPEN;
  sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
}

interface Harness {
  hub: RedisHub;
  published: Array<{ channel: string; message: string }>;
  patterns: string[];
  onPMessage: (channel: string, message: string) => void;
}

/**
 * Stands in for a second ioredis connection: captures the psubscribe pattern
 * and the message handler so tests can simulate a frame arriving from another
 * node.
 */
function makeHub(prefix = "convo:"): Harness {
  const published: Array<{ channel: string; message: string }> = [];
  const patterns: string[] = [];
  let handler: ((pattern: string, channel: string, message: string) => void) | undefined;

  const sub = {
    on(_event: string, cb: (pattern: string, channel: string, message: string) => void) {
      if (_event === "pmessage") handler = cb;
      return sub;
    },
    psubscribe: async (pattern: string) => {
      patterns.push(pattern);
      return 1;
    },
    quit: async () => "OK",
  };
  const redis = {
    duplicate: () => sub,
    publish: async (channel: string, message: string) => {
      published.push({ channel, message });
      return 1;
    },
    hset: async () => 1,
    hdel: async () => 1,
    hlen: async () => 0,
    del: async () => 1,
  } as unknown as Redis;

  const hub = new RedisHub(redis, { prefix });
  return {
    hub,
    published,
    patterns,
    onPMessage: (channel, message) => handler?.(`${prefix}user:*`, channel, message),
  };
}

const event: WsServerEvent = { type: "ready", userId: "u1" } as WsServerEvent;

describe("RedisHub subscriptions", () => {
  it("actually subscribes to the per-user channel pattern", async () => {
    const { patterns } = makeHub();
    await Promise.resolve();
    expect(patterns).toEqual(["convo:user:*"]);
  });

  it("uses a custom prefix on both sides", async () => {
    const { patterns, hub, published } = makeHub("app2:");
    const socket = new FakeSocket();
    hub.add("u1", "d1", socket);
    hub.publishToUsers(["u1"], event);
    expect(patterns).toEqual(["app2:user:*"]);
    expect(published[0]?.channel).toBe("app2:user:u1");
  });
});

describe("RedisHub delivery", () => {
  it("publishes even when the user is connected here, so peer nodes are not starved", () => {
    const { hub, published } = makeHub();
    hub.add("u1", "d1", new FakeSocket());
    hub.publishToUsers(["u1"], event);
    expect(published).toHaveLength(1);
  });

  it("delivers to local sockets immediately", () => {
    const { hub } = makeHub();
    const socket = new FakeSocket();
    hub.add("u1", "d1", socket);
    hub.publishToUsers(["u1"], event);
    expect(socket.sent).toEqual([JSON.stringify(event)]);
  });

  it("delivers a frame from another node to that user's local sockets", () => {
    const { hub, published, onPMessage } = makeHub();
    const socket = new FakeSocket();
    hub.add("u1", "d1", socket);
    // A different process publishes for u1.
    const foreign = { n: "other-node", d: JSON.stringify({ type: "ready", userId: "other" }) };
    onPMessage("convo:user:u1", JSON.stringify(foreign));
    expect(socket.sent).toEqual([foreign.d]);
    expect(published).toHaveLength(0);
  });

  it("ignores its own echoed frame so a socket never receives twice", () => {
    const { hub, published, onPMessage } = makeHub();
    const socket = new FakeSocket();
    hub.add("u1", "d1", socket);
    hub.publishToUsers(["u1"], event);
    onPMessage("convo:user:u1", published[0]!.message);
    expect(socket.sent).toHaveLength(1);
  });

  it("drops malformed frames and frames for a user with no local socket", () => {
    const { hub, onPMessage } = makeHub();
    const socket = new FakeSocket();
    hub.add("u1", "d1", socket);
    onPMessage("convo:user:u1", "not json");
    onPMessage("convo:user:u2", JSON.stringify({ n: "x", d: "{}" }));
    onPMessage("unrelated:channel", JSON.stringify({ n: "x", d: "{}" }));
    expect(socket.sent).toEqual([]);
  });
});
