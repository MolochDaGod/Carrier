import { defineConfig } from "vitest/config";
import path from "path";

// Standalone config for the test runner, mirroring the voxel-engine setup. The
// VfxManager lifecycle tests mock three.quarks, so they run in the node
// environment without a real WebGL context.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
