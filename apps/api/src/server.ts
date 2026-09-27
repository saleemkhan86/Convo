import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { disconnectDb, getDb } from "./db.js";
import { createEmailProvider } from "./email/index.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildApp({
    config,
    db: getDb(),
    email: createEmailProvider(config),
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      app.log.info(`${signal} received, shutting down`);
      void app.close().then(async () => {
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
