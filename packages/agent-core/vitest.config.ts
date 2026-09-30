import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "agent-core",
    include: ["src/**/*.test.ts"],
    environment: "node",
    testTimeout: 20000,
  },
});
