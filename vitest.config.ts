import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.ts"],
    pool: "forks",
    testTimeout: 10000,
    passWithNoTests: true,
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, ".") },
  },
});
