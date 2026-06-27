/**
 * Last-known Grudge ID profile cache (localStorage).
 *
 * The auth bootstrap is async: it loads the Puter SDK, restores/provisions a
 * session, then fetches the profile from KV. On a repeat visit that round-trip
 * leaves the header and Account page momentarily empty. To avoid that flash we
 * persist the most recently resolved profile in localStorage and seed the auth
 * context's initial state from it, then reconcile once the real profile resolves
 * (which overwrites the cache, or clears it on sign-out).
 *
 * This is a render hint only — never a source of truth. It is keyed globally
 * (single-user device assumption); if the resolved account differs, the fresh
 * profile simply replaces the seeded one.
 */

import type { GrudgeProfile } from "./profile.js";

const CACHE_KEY = "grudge:profile:cache";

/** Read the cached profile, or null when absent / unavailable / malformed. */
export function readCachedProfile(): GrudgeProfile | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as GrudgeProfile;
    if (!parsed || typeof parsed.grudgeId !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Persist the latest resolved profile (best-effort). */
export function writeCachedProfile(profile: GrudgeProfile): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(CACHE_KEY, JSON.stringify(profile));
  } catch {
    // ignore quota / serialization errors
  }
}

/** Drop the cached profile (e.g. on sign-out). */
export function clearCachedProfile(): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.removeItem(CACHE_KEY);
  } catch {
    // ignore
  }
}
