import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { disconnectDb, getDb } from "./db.js";
import { createEmailProvider } from "./email/index.js";
import { createSmsProvider } from "./sms/index.js";
import { createMediaStorage } from "./media/index.js";
import { InMemoryHub } from "./services/realtime.js";
import { RedisHub } from "./services/redisHub.js";
import { fieldVisibleToUser } from "./services/privacy.js";
import { sweepAllExpired } from "./services/conversations.js";
import { sweepExpiredFeedPosts } from "./services/feed.js";
import { callService, sweepStuckRings } from "./services/calls.js";
import { sweepExpiredAccounts } from "./services/security.js";
import { createPushTransport } from "./services/push.js";
import { notifyUser } from "./services/notifications.js";
import { getRedis, disconnectRedis } from "./redis.js";
import { TransportRouter } from "./services/transport.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const db = getDb();
  const media = createMediaStorage(config);
  const redis = getRedis(config);
  const hub = redis
    ? new RedisHub(redis, {
        prefix: config.REDIS_PREFIX,
        presenceVisible: (watcherId, targetId) =>
          db.user
            .findUnique({ where: { id: targetId } })
            .then((user) =>
              user === null ? false : fieldVisibleToUser(db, watcherId, user, "online"),
            ),
      })
    : new InMemoryHub({
        presenceVisible: (watcherId, targetId) =>
          db.user
            .findUnique({ where: { id: targetId } })
            .then((user) =>
              user === null ? false : fieldVisibleToUser(db, watcherId, user, "online"),
            ),
      });
  if (redis) {
    console.log("[redis] connected — multi-process realtime enabled");
  } else {
    console.log("[redis] REDIS_URL not set — using in-memory hub (single-process only)");
  }
  const push = createPushTransport(db, config);
  // Stage 6: transport router for multi-channel delivery. For now, only
  // WebSocket is fully implemented. Push and email transports are stubs that
  // can be enabled when the push/email services are adapted for message delivery.
  const transport = new TransportRouter(hub, db);
  const app = await buildApp({
    config,
    db,
    email: createEmailProvider(config),
    sms: createSmsProvider(config),
    hub,
    media,
    push,
    transport,
  });

  // Background sweeps (5C): expired disappearing messages + finished account
  // deletions. Opportunistic per-chat sweeps still run inside the read paths,
  // so chats nobody opens still drain.
  const notifySvc = { db, hub, push };
  const timers: ReturnType<typeof setInterval>[] = [
    setInterval(() => {
      void sweepAllExpired({ db, hub }).catch(() => {});
    }, config.EPHEMERAL_SWEEP_SECONDS * 1000),
    setInterval(() => {
      void sweepExpiredAccounts({ db, config }).catch(() => {});
    }, config.DELETION_SWEEP_SECONDS * 1000),
    // 5F: a ring nobody answered becomes a missed call, even if the caller's
    // client died before it could cancel. Phase 5G: also notify each peer.
    setInterval(() => {
      void sweepStuckRings({
        ...callService({ db, hub, config }),
        notifyRecipient: (userId, type, title, body, actorId, conversationId, callId) =>
          notifyUser(notifySvc, { userId, type, title, body, actorId, conversationId, callId }),
      }).catch(() => {});
    }, config.CALL_SWEEP_SECONDS * 1000),
    // Feed: prune expired posts and their media objects every hour.
    setInterval(() => {
      void sweepExpiredFeedPosts(db, media).catch(() => {});
    }, config.FEED_SWEEP_SECONDS * 1000),
  ];

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      app.log.info(`${signal} received, shutting down`);
      for (const t of timers) clearInterval(t);
      void app.close().then(async () => {
        if (hub instanceof RedisHub) await hub.shutdown();
        await disconnectRedis();
        await disconnectDb();
        process.exit(0);
      });
    });
  }

  await app.listen({ port: config.PORT, host: config.HOST });
}

main().catch((err) => {
  console.error("Failed to start Convo API:", err);
  process.exit(1);
});
