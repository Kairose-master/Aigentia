import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "api", include: ["src/**/*.test.ts"], environment: "node", testTimeout: 30000 },
});
