/**
 * Grudge ID profile + cross-app per-user store.
 *
 * Every signed-in (or guest) player has one Grudge ID — a stable identity
 * derived from their Puter account uuid — and one shared profile persisted in
 * the Puter key/value store under a single namespaced key. The profile holds a
 * display name, a deterministic crest, lightweight cross-app stats (projects
 * created, games played, last played) and a short recent-activity feed.
 *
 * This store lives ALONGSIDE the existing game-specific keys (studio:* projects,
 * arcade:highscore:* scores) and never touches them.
 */

import { loadPuter, type PuterUser } from "./puter.js";

/** Lightweight cross-app counters shown on the Account page. */
export interface GrudgeStats {
  projectsCreated: number;
  gamesPlayed: number;
  lastPlayed?: { gameId: string; title: string; at: number };
}

/** A single recent-activity row. */
export interface ActivityEntry {
  id: string;
  kind: "game" | "project" | "account";
  label: string;
  detail?: string;
  at: number;
}

/** The full shared profile for one Grudge ID. */
export interface GrudgeProfile {
  /** Human-friendly, stable id derived from the account uuid. */
  grudgeId: string;
  /** The Puter username (live). */
  username: string;
  /** True while the account is still a temporary guest. */
  isGuest: boolean;
  /** Editable display name (defaults to the username). */
  displayName: string;
  /** Deterministic crest token used for the avatar accent. */
  crest: string;
  createdAt: number;
  updatedAt: number;
  stats: GrudgeStats;
  activity: ActivityEntry[];
}

const PROFILE_KEY = "grudge:profile";
const MAX_ACTIVITY = 20;

/** Deterministic crest palette tokens (consumed by the UI for accent colours). */
export const CRESTS = ["ember", "frost", "gold", "jade", "void", "rose"] as const;
export type Crest = (typeof CRESTS)[number];

/** Stable hash of a string → unsigned 32-bit int. */
function hash(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i += 1) {
    h = (h * 31 + input.charCodeAt(i)) >>> 0;
  }
  return h;
}

/**
 * Derive the human-friendly Grudge ID from a Puter account. Deterministic, so
 * the same account always shows the same id across every artifact.
 */
export function grudgeIdFor(user: Pick<PuterUser, "uuid">): string {
  const hex = user.uuid.replace(/[^a-z0-9]/gi, "").toUpperCase();
  const a = hex.slice(0, 4).padEnd(4, "0");
  const b = hex.slice(4, 8).padEnd(4, "0");
  return `GX-${a}-${b}`;
}

/** Deterministic crest token for an account. */
export function crestFor(user: Pick<PuterUser, "uuid">): Crest {
  return CRESTS[hash(user.uuid) % CRESTS.length];
}

function randomId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }
}

/** Build a fresh default profile for a user (used as a merge base). */
function defaultProfile(user: PuterUser): GrudgeProfile {
  const now = Date.now();
  return {
    grudgeId: grudgeIdFor(user),
    username: user.username,
    isGuest: user.is_temp === true,
    displayName: user.username,
    crest: crestFor(user),
    createdAt: now,
    updatedAt: now,
    stats: { projectsCreated: 0, gamesPlayed: 0 },
    activity: [],
  };
}

/**
 * Load the stored profile for a user, merged onto fresh defaults. Live identity
 * fields (grudgeId/username/isGuest) always reflect the current account, while
 * stored fields (displayName/crest/stats/activity) are preserved.
 */
export async function loadProfile(user: PuterUser): Promise<GrudgeProfile> {
  const base = defaultProfile(user);
  try {
    const puter = await loadPuter();
    if (!puter.auth.isSignedIn()) return base;
    const raw = await puter.kv.get(PROFILE_KEY);
    if (!raw) return base;
    const stored = JSON.parse(raw) as Partial<GrudgeProfile>;
    return {
      ...base,
      displayName: stored.displayName?.trim() || base.displayName,
      crest: stored.crest || base.crest,
      createdAt: stored.createdAt ?? base.createdAt,
      stats: { ...base.stats, ...(stored.stats ?? {}) },
      activity: Array.isArray(stored.activity)
        ? stored.activity.slice(0, MAX_ACTIVITY)
        : [],
    };
  } catch {
    return base;
  }
}

/** Persist a profile (no-op when signed out / unavailable). */
async function saveProfile(profile: GrudgeProfile): Promise<void> {
  const puter = await loadPuter();
  if (!puter.auth.isSignedIn()) return;
  profile.updatedAt = Date.now();
  await puter.kv.set(PROFILE_KEY, JSON.stringify(profile));
}

/**
 * Ensure a profile exists for the user, writing the default through on first
 * sight so later visits render from a real stored record.
 */
export async function ensureProfile(user: PuterUser): Promise<GrudgeProfile> {
  const profile = await loadProfile(user);
  await saveProfile(profile).catch(() => undefined);
  return profile;
}

/**
 * Read-modify-write helper. Loads the current profile, applies `fn`, trims the
 * activity feed, and persists. Returns the updated profile, or null when there
 * is no signed-in user or the store is unavailable.
 */
async function mutate(fn: (p: GrudgeProfile) => void): Promise<GrudgeProfile | null> {
  try {
    const puter = await loadPuter();
    if (!puter.auth.isSignedIn()) return null;
    const user = await puter.auth.getUser();
    const profile = await loadProfile(user);
    fn(profile);
    if (profile.activity.length > MAX_ACTIVITY) {
      profile.activity = profile.activity.slice(0, MAX_ACTIVITY);
    }
    await saveProfile(profile);
    return profile;
  } catch {
    return null;
  }
}

function pushActivity(p: GrudgeProfile, entry: Omit<ActivityEntry, "id" | "at">): void {
  p.activity.unshift({ id: randomId(), at: Date.now(), ...entry });
}

/** Record that the player launched a game (bumps gamesPlayed + lastPlayed). */
export function recordGamePlayed(gameId: string, title: string): Promise<GrudgeProfile | null> {
  return mutate((p) => {
    p.stats.gamesPlayed += 1;
    p.stats.lastPlayed = { gameId, title, at: Date.now() };
    pushActivity(p, { kind: "game", label: `Played ${title}` });
  });
}

/** Record that the player created a Studio project. */
export function recordProjectCreated(name: string): Promise<GrudgeProfile | null> {
  return mutate((p) => {
    p.stats.projectsCreated += 1;
    pushActivity(p, { kind: "project", label: `Created project "${name}"` });
  });
}

/** Update the editable display name. */
export function updateDisplayName(name: string): Promise<GrudgeProfile | null> {
  return mutate((p) => {
    const clean = name.trim();
    if (clean) p.displayName = clean;
  });
}
