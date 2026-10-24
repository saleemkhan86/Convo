import type { PrismaClient } from "@prisma/client";
import type { Config } from "./config.js";
import type { EmailProvider } from "./email/index.js";
import type { MediaStorage } from "./media/index.js";
import type { SmsProvider } from "./sms/index.js";
import type { PushTransport } from "./services/push.js";
import type { RealtimeHub } from "./services/realtime.js";
import type { TransportRouter } from "./services/transport.js";

export interface AppDeps {
  config: Config;
  db: PrismaClient;
  email: EmailProvider;
  /** Phone OTP transport — see src/sms/index.ts for what happens when no vendor is wired up. */
  sms: SmsProvider;
  hub: RealtimeHub;
  media: MediaStorage;
  /** Absent when push is not configured, so every call site may stay optional. */
  push?: PushTransport;
  /** Stage 6: transport router for multi-channel message delivery. */
  transport?: TransportRouter;
}
