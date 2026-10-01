import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "scripts/**/*.test.ts"],
    exclude: ["**/node_modules/**", "e2e/**"],
    // Database tests share one PostgreSQL server; files run in parallel but each test file owns its own database.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
