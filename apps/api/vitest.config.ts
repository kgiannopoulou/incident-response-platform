import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Integration tests share one Postgres test database, so files run one at a time.
export default defineConfig({
  resolve: {
    // Test the SDK from source (its package exports point at the built dist/).
    alias: { "@incident-platform/sdk": fileURLToPath(new URL("../../packages/alert-sdk/src/index.ts", import.meta.url)) },
  },
  test: {
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
