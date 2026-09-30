import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests may run against a remote cloud database.
    // Round-trips to the pooled DB spike past 30s, so allow generous margins.
    testTimeout: 180_000,
    hookTimeout: 240_000,
    // Integration files wipe shared tables in beforeAll; never run them concurrently.
    fileParallelism: false,
  },
});
