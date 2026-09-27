import type { PrismaClient } from "@prisma/client";
import type { Config } from "./config.js";
import type { EmailProvider } from "./email/index.js";
import type { RealtimeHub } from "./services/realtime.js";

export interface AppDeps {
  config: Config;
  db: PrismaClient;
  email: EmailProvider;
  hub: RealtimeHub;
}
