import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests may run against a remote cloud database.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // Integration files wipe shared tables in beforeAll; never run them concurrently.
    fileParallelism: false,
  },
});
