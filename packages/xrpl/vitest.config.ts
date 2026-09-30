import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "xrpl", include: ["src/**/*.test.ts"], environment: "node", testTimeout: 20000 },
});
