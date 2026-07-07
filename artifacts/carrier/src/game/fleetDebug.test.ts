import { describe, it, expect, beforeEach } from "vitest";
import { fleetDebug } from "./fleetDebug";

describe("fleetDebug bus", () => {
  beforeEach(() => {
    fleetDebug.remove("test-1");
    fleetDebug.remove("test-2");
  });

  it("tracks load lifecycle", () => {
    fleetDebug.start({
      key: "test-1",
      assetId: "vehicles/space/brood/void-core",
      faction: "brood",
      role: "corsair",
      source: "match",
      label: "Void Core",
    });
    expect(fleetDebug.get("test-1")?.phase).toBe("pending");
    fleetDebug.success("test-1");
    expect(fleetDebug.get("test-1")?.phase).toBe("glb");
    fleetDebug.start({
      key: "test-2",
      assetId: "vehicles/space/brood/void-core",
      faction: "brood",
      role: "corsair",
      source: "roster",
    });
    fleetDebug.fallback("test-2", "missing");
    expect(fleetDebug.get("test-2")?.phase).toBe("fallback");
  });
});