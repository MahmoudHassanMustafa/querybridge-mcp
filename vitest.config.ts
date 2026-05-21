import { defineConfig } from "vitest/config";

// Default config excludes integration tests so `pnpm test` stays fast
// and doesn't require Docker. Integration suite uses vitest.integration.config.ts.
export default defineConfig({
  test: {
    exclude: [
      "dist/**",
      "node_modules/**",
      "**/*.integration.test.ts",
    ],
  },
});
