import { defineConfig } from "vitest/config";

/**
 * Integration config — DESTRUCTIVE. Exists only so `pnpm test` can never reach
 * these suites by accident; you have to name this config to run them.
 *
 * These files truncate users, conversations, messages, contacts, refresh tokens
 * and audit log rows in `beforeAll`. `TEST_DATABASE_URL` in `apps/api/.env` is
 * the same database as `DATABASE_URL`, so this wipes development data. Create a
 * genuinely separate database (or drop the variable) before running it.
 */
export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 240_000,
    fileParallelism: false,
  },
});
