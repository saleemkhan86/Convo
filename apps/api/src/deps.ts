import type { PrismaClient } from "@prisma/client";
import type { Config } from "./config.js";
import type { EmailProvider } from "./email/index.js";

export interface AppDeps {
  config: Config;
  db: PrismaClient;
  email: EmailProvider;
}
