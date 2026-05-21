import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.integration.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    // Container startup eats most of the budget. The default 5s is too tight.
    testTimeout: 30_000,
    hookTimeout: 180_000,
    // One container per file — run files sequentially to avoid Docker
    // resource contention on small CI runners.
    fileParallelism: false,
  },
});
