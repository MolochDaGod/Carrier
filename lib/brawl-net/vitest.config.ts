import { defineConfig } from "vitest/config";

// Standalone config for the brawl-net test runner, mirroring carrier-net.
// The sim is pure (no three/ws/node deps), so tests run in the node environment.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
