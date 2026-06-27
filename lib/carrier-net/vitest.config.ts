import { defineConfig } from "vitest/config";

// Standalone config for the carrier-net test runner, mirroring the vfx setup.
// The sim is pure (no three/ws/node deps), so tests run in the node environment.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
