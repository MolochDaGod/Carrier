/**
 * zombieCabinetEffects.test.ts
 * ----------------------------
 * Catches combat effects that silently fail to show.
 *
 * `VfxManager.play()`/`track()` no-op when an effect key wasn't loaded, so a
 * typo or a forgotten entry in the zombie cabinet's `vfx.load([...])` list makes
 * a combat effect simply never appear — with no error anywhere. This test reads
 * the cabinet source statically and asserts every effect key it triggers via
 * `play()`/`track()` is (a) a valid `EffectKey` and (b) present in the list
 * passed to `vfx.load(...)`.
 *
 * It parses source text rather than running the engine, so it needs no WebGL
 * context (and never instantiates the three.quarks-backed manager).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

import { ALL_EFFECT_KEYS, type EffectKey } from "./effects.js";

const ZOMBIE_GAME_PATH = path.resolve(
  import.meta.dirname,
  "../../../artifacts/arcade/src/games/zombie/ZombieGame.ts",
);

const source = readFileSync(ZOMBIE_GAME_PATH, "utf8");

/** Effect keys passed to a `.method("key", ...)` call (first string-literal arg). */
function extractCalledKeys(method: "play" | "track"): string[] {
  const re = new RegExp(`\\.${method}\\(\\s*["'\`]([^"'\`]+)["'\`]`, "g");
  const keys = new Set<string>();
  for (const m of source.matchAll(re)) keys.add(m[1]);
  return [...keys];
}

/** The single array literal passed to `vfx.load([...])`. */
function extractLoadList(): string[] {
  const m = source.match(/\.load\(\s*\[([\s\S]*?)\]/);
  if (!m) throw new Error("Could not find a vfx.load([...]) call in ZombieGame.ts");
  const keys = new Set<string>();
  for (const lit of m[1].matchAll(/["'`]([^"'`]+)["'`]/g)) keys.add(lit[1]);
  return [...keys];
}

const validKeys = new Set<EffectKey>(ALL_EFFECT_KEYS);
const triggeredKeys = [...new Set([...extractCalledKeys("play"), ...extractCalledKeys("track")])];
const loadedKeys = extractLoadList();

describe("zombie cabinet VFX load list", () => {
  it("triggers at least one effect (sanity: the parser actually found calls)", () => {
    expect(triggeredKeys.length).toBeGreaterThan(0);
    expect(loadedKeys.length).toBeGreaterThan(0);
  });

  it("only triggers keys that are valid EffectKeys", () => {
    const invalid = triggeredKeys.filter((k) => !validKeys.has(k as EffectKey));
    expect(invalid).toEqual([]);
  });

  it("only lists valid EffectKeys in vfx.load(...)", () => {
    const invalid = loadedKeys.filter((k) => !validKeys.has(k as EffectKey));
    expect(invalid).toEqual([]);
  });

  it("loads every effect key it triggers (no silent no-op play/track)", () => {
    const loadedSet = new Set(loadedKeys);
    const missing = triggeredKeys.filter((k) => !loadedSet.has(k));
    expect(missing).toEqual([]);
  });
});
