import { defineConfig } from "vitest/config";

/**
 * Default config = UNIT ONLY.
 *
 * `test/integration/**` calls `deleteMany()` on the real tables in `beforeAll`,
 * and `TEST_DATABASE_URL` is currently byte-identical to `DATABASE_URL` — so an
 * integration run wipes the development database, not a throwaway one. Vitest
 * loads `apps/api/.env` the way Vite does, which means the plain presence of
 * `TEST_DATABASE_URL` in that file is enough to arm those suites. Excluding the
 * directory here keeps `pnpm test` / bare `vitest run` safe no matter what the
 * environment contains.
 *
 * Deliberate integration runs use the separate config:
 *   pnpm test:integration:wipes-shared-db
 */
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "test/integration/**"],
    // Integration tests may run against a remote cloud database.
    // Round-trips to the pooled DB spike past 30s, so allow generous margins.
    testTimeout: 180_000,
    hookTimeout: 240_000,
    // Integration files wipe shared tables in beforeAll; never run them concurrently.
    fileParallelism: false,
  },
});
