import { Redis } from "ioredis";
import type { Config } from "./config.js";

let redis: Redis | null = null;

export function getRedis(config: Config): Redis | null {
  if (!config.REDIS_URL) return null;
  if (redis) return redis;
  redis = new Redis(config.REDIS_URL, {
    keyPrefix: config.REDIS_PREFIX,
    lazyConnect: true,
    maxRetriesPerRequest: 3,
    retryStrategy(times: number) {
      if (times > 10) return null;
      return Math.min(times * 200, 5000);
    },
  });
  redis.on("error", (err: Error) => {
    console.error("[redis] connection error:", err.message);
  });
  return redis;
}

export async function disconnectRedis(): Promise<void> {
  if (redis) {
    await redis.quit().catch(() => {});
    redis = null;
  }
}
