import { defineConfig } from "vitest/config";
import path from "path";

// Standalone config for the carrier test runner. The app's vite.config.ts
// deliberately throws when PORT/BASE_PATH are missing, so tests use this minimal
// config instead. Tests run in the node environment because the asset-wiring
// guards are pure data + filesystem checks (no DOM / WebGL).
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
