/**
 * Offline guard against accidental ship/station appearance regressions.
 *
 * The dev model inspector lets a human eyeball each hull's facing/scale/materials,
 * but nothing stops the asset wiring from silently regressing (a fleet hull losing
 * its yaw override, a station's fitMul drifting, or — the worst, because it fails
 * SILENTLY into the procedural fallback — an asset id pointing at a file that does
 * not exist). These tests pin all of that down so an accidental edit fails loudly.
 *
 * No WebGL is needed: ids are resolved through the game's own `findAsset` catalog
 * (built from the files actually shipped under `lib/assets/models/`) and the model
 * files are parsed with three in Node, following `.agents/memory/
 * offline-3d-model-verification.md`.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { findAsset } from "@workspace/assets";
import { FACTIONS, FACTION_ORDER, type FactionId } from "@workspace/carrier-net";

import {
  FLEET_BY_FACTION,
  FIGHTER_GLB,
  FACTION_STATIONS,
  DEPLOY_ROLES,
  fleetModelFor,
} from "./factionAssets";
import { MOTHERSHIPS, FACTION_ACCENT } from "./motherships";

/**
 * Models that exist on disk and resolve in the catalog but don't parse headless
 * with three in Node (loader limitations / compression we don't decode offline).
 * They're still pinned for resolution + on-disk presence above; we only skip the
 * Node geometry-parse assertion for them. Populated empirically — keep minimal.
 */
const NODE_PARSE_SKIP = new Set<string>([
  // The Hive Queen GLB embeds image textures; GLTFLoader's headless image decode
  // path hits `self is not defined` in Node. It still resolves in the catalog and
  // exists on disk (asserted above) — only the offline geometry-parse is skipped.
  "environment/stations/broodmother-hive-queen/hive_queen",
  // The Brood living fleet: these hulls embed image textures and/or are skinned
  // (rigged), so GLTFLoader's headless decode path hits the same `self is not
  // defined` in Node. They resolve in the catalog + exist on disk (asserted
  // above); only the offline geometry-parse is skipped. (flesh-hive-worm carries
  // no textures and parses fine, so it is intentionally NOT skipped.)
  "vehicles/space/brood/delphi-recon-station",
  "vehicles/space/brood/hytri-cruiser",
  "vehicles/space/brood/bloodvein-frigate",
  "vehicles/space/brood/void-core",
  "vehicles/space/brood/leviathan",
]);

const MODELS_DIR = path.resolve(import.meta.dirname, "../../../../lib/assets/models");
const MODEL_EXTS = ["glb", "gltf", "fbx", "obj"] as const;

/** Locate the on-disk model file backing a catalog id, or undefined if missing. */
function diskPathFor(id: string): string | undefined {
  for (const ext of MODEL_EXTS) {
    const p = path.join(MODELS_DIR, `${id}.${ext}`);
    if (existsSync(p)) return p;
  }
  return undefined;
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/** Parse a model file with three in Node and return its scene graph root. */
async function parseModel(diskPath: string): Promise<THREE.Object3D> {
  const ext = path.extname(diskPath).slice(1).toLowerCase();
  if (ext === "obj") {
    return new OBJLoader().parse(readFileSync(diskPath, "utf8"));
  }
  if (ext === "fbx") {
    return new FBXLoader().parse(toArrayBuffer(readFileSync(diskPath)), "") as unknown as THREE.Object3D;
  }
  // glb / gltf
  const ab = toArrayBuffer(readFileSync(diskPath));
  return new Promise<THREE.Object3D>((resolve, reject) =>
    new GLTFLoader().parse(ab, "", (g) => resolve(g.scene), reject),
  );
}

/** Count vertices across every Mesh in a scene graph. */
function vertexCount(root: THREE.Object3D): number {
  let total = 0;
  root.traverse((o) => {
    if (o instanceof THREE.Mesh) total += o.geometry.getAttribute("position")?.count ?? 0;
  });
  return total;
}

/** Every distinct asset id referenced by the faction wiring, with a label. */
const allAssetRefs: { label: string; id: string }[] = [
  ...FACTION_ORDER.flatMap((faction) =>
    DEPLOY_ROLES.map((role) => ({
      label: `FLEET_BY_FACTION.${faction}.${role}`,
      id: FLEET_BY_FACTION[faction][role].id,
    })),
  ),
  ...Object.entries(FIGHTER_GLB).map(([k, m]) => ({ label: `FIGHTER_GLB.${k}`, id: m.id })),
  ...Object.entries(FACTION_STATIONS).flatMap(([faction, s]) =>
    s.parts.map((id, i) => ({ label: `FACTION_STATIONS.${faction}.parts[${i}]`, id })),
  ),
  ...MOTHERSHIPS.map((m) => ({ label: `MOTHERSHIPS.${m.name}.hull`, id: m.hull })),
];

describe("faction asset wiring", () => {
  describe("every referenced id resolves to a real asset file", () => {
    for (const { label, id } of allAssetRefs) {
      it(`${label} -> ${id}`, () => {
        // The game's own resolver (catalog built from shipped files) must know it.
        // A miss here means the id silently degrades to the procedural fallback.
        expect(findAsset(id), `${id} is not in the asset catalog`).toBeDefined();

        // ...and it must point at an actual file on disk, not an empty stub.
        const disk = diskPathFor(id);
        expect(disk, `${id} has no backing file under lib/assets/models`).toBeDefined();
        expect(statSync(disk!).size, `${id} backing file is empty`).toBeGreaterThan(0);
      });
    }
  });

  describe("every referenced model parses to non-empty geometry", () => {
    for (const { label, id } of allAssetRefs) {
      const skipped = NODE_PARSE_SKIP.has(id);
      it.skipIf(skipped)(`${label} -> ${id}`, async () => {
        const disk = diskPathFor(id);
        expect(disk, `${id} has no backing file`).toBeDefined();
        const root = await parseModel(disk!);
        expect(vertexCount(root), `${id} parsed to zero vertices`).toBeGreaterThan(0);
      });
    }
  });

  it("each faction fields six distinct fleet hulls", () => {
    // T002 guarantee: no hull is reused within a faction's deploy set, so each
    // class reads as its own silhouette. (Hulls MAY repeat across factions only
    // where the pool forces it; within one faction they must all differ.)
    for (const faction of FACTION_ORDER) {
      const ids = DEPLOY_ROLES.map((role) => fleetModelFor(faction, role).id);
      expect(new Set(ids).size, `${faction} must field ${DEPLOY_ROLES.length} distinct hulls`).toBe(
        DEPLOY_ROLES.length,
      );
    }
  });

  it("ship orient modes are pinned (auto vs explicit yaw)", () => {
    // "auto" = taper auto-orientation; a number = forced Y-rotation (radians).
    // Removing a yaw override (e.g. the skimmer / player would fly tail-first) or
    // adding a stray one must fail this snapshot. Almost every hull auto-orients;
    // only the authored-backwards ones carry a forced yaw. Rather than pin all 30
    // fleet entries, we pin the COMPLETE set of yaw overrides — any added/removed
    // override fails loudly.
    const fleetOverrides: [string, number][] = [];
    for (const faction of FACTION_ORDER) {
      for (const role of DEPLOY_ROLES) {
        const yaw = FLEET_BY_FACTION[faction][role].yaw;
        if (yaw !== undefined) fleetOverrides.push([`${faction}.${role}`, yaw]);
      }
    }

    // The only fleet hull authored nose-toward local -Z is the scavengers skimmer.
    expect(fleetOverrides).toEqual([["scavengers.miner", Math.PI]]);

    // Fighters: the player hull is authored backwards (forced half-turn); the
    // enemy interceptor auto-orients.
    expect(FIGHTER_GLB.player.yaw).toBe(Math.PI);
    expect(FIGHTER_GLB.enemy.yaw).toBeUndefined();
  });

  it("mothership class hull ids are pinned and distinct", () => {
    // Each class must keep its OWN hull id; a stray re-point (or two classes
    // sharing one hull again) must fail. The showcase fits + spins the hull on a
    // platform without auto-orient, so only the id is pinned here.
    const hulls = Object.fromEntries(MOTHERSHIPS.map((m) => [m.name, m.hull]));

    expect(hulls).toEqual({
      Miner: "vehicles/space/capital/destroyer-02",
      Scout: "vehicles/space/raiders/swordfish",
      Corsair: "vehicles/space/capital/cruiser-03",
      Frigate: "vehicles/space/capital/destroyer-01",
      Cruiser: "vehicles/space/capital/cruiser-01",
      Dreadnought: "vehicles/space/capital/cruiser-02",
    });

    const unique = new Set(MOTHERSHIPS.map((m) => m.hull));
    expect(unique.size, "every mothership class must use a distinct hull").toBe(
      MOTHERSHIPS.length,
    );
  });

  it("shared netcode faction colours are unchanged (neon palette)", () => {
    // These bright neon hues drive in-match HUD/intro readability AND the
    // in-match small-fighter tint. The muted preview palette below is a separate
    // derivation; an edit here must be deliberate, so the values are pinned.
    const colors = Object.fromEntries(
      FACTION_ORDER.map((id) => [id, FACTIONS[id].color]),
    );

    expect(colors).toEqual({
      scavengers: "#ff4d4d",
      hollow: "#4488ff",
      network: "#ffd23f",
      brood: "#c084fc",
      prospector: "#5dff9b",
    });
  });

  describe("muted preview palette stays distinct from the neon netcode palette", () => {
    // FACTION_ACCENT is the client-only MUTED palette for the lit GLB previews;
    // FACTIONS[id].color is the BRIGHT neon netcode palette. A regression that
    // points the previews back at the neon hues (re-introducing the old glowing
    // wash) must fail. We compare in HSV: each accent must be meaningfully less
    // saturated AND less bright, keeping the muted, painted-metal look.
    function hexToHsv(hex: string): { s: number; v: number } {
      const m = hex.replace("#", "");
      const r = parseInt(m.slice(0, 2), 16) / 255;
      const g = parseInt(m.slice(2, 4), 16) / 255;
      const b = parseInt(m.slice(4, 6), 16) / 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const s = max === 0 ? 0 : (max - min) / max;
      return { s, v: max };
    }

    it("has exactly one entry per FactionId", () => {
      expect(Object.keys(FACTION_ACCENT).sort()).toEqual([...FACTION_ORDER].sort());
    });

    for (const id of FACTION_ORDER) {
      it(`${id} accent is more muted than its neon colour`, () => {
        const neon = hexToHsv(FACTIONS[id].color);
        const accent = hexToHsv(FACTION_ACCENT[id as FactionId]);

        // Each accent pulls BOTH saturation and value down off the neon hue.
        expect(accent.s, `${id} accent must be less saturated than neon`).toBeLessThan(
          neon.s,
        );
        expect(accent.v, `${id} accent must be darker than neon`).toBeLessThan(neon.v);

        // ...and the combined perceived intensity (sat * value) must drop by a
        // clear margin, not a hair — otherwise the muting isn't meaningful.
        const neonIntensity = neon.s * neon.v;
        const accentIntensity = accent.s * accent.v;
        expect(
          accentIntensity,
          `${id} accent intensity (${accentIntensity.toFixed(3)}) must be << neon (${neonIntensity.toFixed(3)})`,
        ).toBeLessThan(neonIntensity * 0.75);
      });
    }
  });

  it("station part counts and fitMul are pinned", () => {
    const stations = Object.fromEntries(
      Object.entries(FACTION_STATIONS).map(([faction, s]) => [
        faction,
        { partCount: s.parts.length, fitMul: s.fitMul },
      ]),
    );

    expect(stations).toEqual({
      scavengers: { partCount: 1, fitMul: 1.1 },
      hollow: { partCount: 2, fitMul: 1.25 },
      network: { partCount: 3, fitMul: 1.0 },
      brood: { partCount: 1, fitMul: 1.2 },
      prospector: { partCount: 2, fitMul: 1.3 },
    });
  });
});
