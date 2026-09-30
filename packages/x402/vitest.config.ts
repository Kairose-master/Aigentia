import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "x402", include: ["src/**/*.test.ts"], environment: "node", testTimeout: 20000 },
});
