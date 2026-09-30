import type { PrismaClient } from "@prisma/client";
import type { Config } from "./config.js";
import type { EmailProvider } from "./email/index.js";
import type { MediaStorage } from "./media/index.js";
import type { PushTransport } from "./services/push.js";
import type { RealtimeHub } from "./services/realtime.js";

export interface AppDeps {
  config: Config;
  db: PrismaClient;
  email: EmailProvider;
  hub: RealtimeHub;
  media: MediaStorage;
  /** Absent when push is not configured, so every call site may stay optional. */
  push?: PushTransport;
}
