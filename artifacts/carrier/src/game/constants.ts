/**
 * Client-only tunables for the Carrier cabinet.
 *
 * Flight/weapon physics live in @workspace/carrier-net (shared with the server).
 * Everything here is presentation-only: camera rig, interpolation delay,
 * accent colours, and the HUD snapshot shape.
 */

import type { EntityKind, FactionId, FleetRole, PlatformKind } from "@workspace/carrier-net";

/** Render-time delay applied to remote ships for interpolation (ms). */
export const INTERP_DELAY_MS = 120;

/** Accent colour per fleet class (used for unit zones + HUD chips). */
export const ROLE_COLORS: Record<Exclude<FleetRole, "none">, string> = {
  miner: "#ffd23f",
  scout: "#88ff00",
  corsair: "#ff6b35",
  frigate: "#c084fc",
  cruiser: "#00d4ff",
  dreadnought: "#ff4d4d",
} as const;

/** Chase-camera framing (defaults = fighter). */
export const CAMERA = {
  distance: 80,
  height: 28,
  lead: 60,
  lerp: 8,
  fov: 65,
  boostFovKick: 10,
  /**
   * Capital-ship framing. Multipliers are applied to the mothership's length so
   * the camera pulls way back + up and looks near the hull centre — the whole
   * ship stays in frame. A softer lerp gives a free-flowing, cinematic follow
   * instead of the snappy fighter chase.
   */
  mother: { distMul: 1.85, heightMul: 0.62, leadMul: 0.12, lerp: 3.2 },
  /** Fleet-unit framing — a touch tighter than the fighter default. */
  fleet: { distance: 55, height: 20, lead: 42, lerp: 9 },
} as const;

/** Visual fit target for the ship model (longest side, world units = metres). */
export const SHIP_FIT = 40;

/**
 * Afterburner heat model. Heat climbs while boosting and bleeds off when idle,
 * both per second, so the HUD gauge reflects how long the player has sustained
 * Shift. Boost is gated on this gauge: when heat tops out the afterburner cuts
 * out (overheat lockout) and can't re-engage until it cools back below
 * `recoverAt`, forcing the player to manage the resource.
 */
export const AFTERBURNER = {
  /** Fraction of the gauge filled per second of sustained boost (0..1). */
  heatPerSec: 0.5,
  /** Fraction bled off per second when not boosting. */
  coolPerSec: 0.35,
  /** Heat fraction above which the gauge reads "overheating". */
  warnAt: 0.85,
  /**
   * Heat fraction the gauge must cool back below before a locked-out
   * afterburner can re-engage. The lockout latches at heat 1.0.
   */
  recoverAt: 0.4,
  /**
   * Duration (ms) of the red screen-edge vignette pulse that fires the moment
   * the afterburner latches into overheat lockout, before it fades out.
   */
  overheatFlashMs: 900,
} as const;

/** Cockpit hull-damage / low-health alert tuning (audio + screen vignette). */
export const HULL_ALERT = {
  /**
   * hp fraction at or below which the persistent critical-hull warning engages
   * (pulsing red edge + repeating klaxon), clearing once hp recovers above it.
   */
  lowHpFrac: 0.3,
  /** Milliseconds between repeated low-health warning beeps while critical. */
  warnIntervalMs: 1100,
  /** Duration (ms) of the red screen-edge flash that fires on each hull hit. */
  hitFlashMs: 450,
  /**
   * Minimum gap (ms) between hit cues so a burst of rapid damage doesn't spam
   * the sound — the flash still retriggers, only the audio is throttled.
   */
  hitSoundThrottleMs: 110,
} as const;

/** Accent colour per platform kind (mesh, HUD chips, map blips). */
export const PLATFORM_COLORS: Record<PlatformKind, string> = {
  turret: "#ff6b35",
  production: "#ffd23f",
  utility: "#44ddff",
} as const;

/** Per-ship-type accent colours, index 0..5. */
export const SHIP_ACCENTS = [
  "#00d4ff",
  "#88ff00",
  "#ff6b35",
  "#c084fc",
  "#ffd23f",
  "#ff5d8f",
] as const;

export type ConnStatus = "connecting" | "connected" | "error" | "disconnected";

export interface ScoreRow {
  id: string;
  name: string;
  kills: number;
  deaths: number;
  you: boolean;
}

/** One deployable role button in the HUD deploy panel. */
export interface DeployOption {
  role: Exclude<FleetRole, "none">;
  label: string;
  cost: number;
  /** Whether the commander can currently afford + has cap room for this unit. */
  available: boolean;
}

/** One owned fleet unit in the roster list. */
export interface FleetRow {
  id: string;
  role: Exclude<FleetRole, "none">;
  label: string;
  hpPct: number;
  /** Deflector charge fraction (0..1); 0 when the unit has no shield. */
  shieldPct: number;
}

/** One controllable unit (carrier / fighter / fleet unit) in the command roster. */
export interface RosterRow {
  /** Entity id used as the `become` target. */
  id: string;
  /** Display label, e.g. "Carrier", "Fighter", "Defender". */
  label: string;
  /** Coarse kind for grouping + icon. */
  kind: EntityKind;
  hpPct: number;
  /** Deflector charge fraction (0..1); 0 when the unit has no shield. */
  shieldPct: number;
  /** Whether this unit is the one currently under direct control. */
  active: boolean;
  /** Whether the commander can summon/escort this unit (owned fleet unit, not piloted). */
  summonable: boolean;
  /** Whether this unit is currently flying escort on the commander (optimistic). */
  escorting: boolean;
}

/** One build-platform option in the command UI. */
export interface BuildOption {
  kind: PlatformKind;
  label: string;
  cost: number;
  blurb: string;
  /** Affordable + under the per-commander cap right now. */
  available: boolean;
}

/** One built platform in the HUD list. */
export interface PlatformRow {
  id: string;
  kind: PlatformKind;
  label: string;
  hpPct: number;
}

/** A single blip on the strategic map overlay. */
export interface MapBlip {
  x: number;
  /** Projected map Y (from world Z). */
  y: number;
  kind: "self" | "carrier" | "fleet" | "platform" | "enemy" | "reward" | "rock" | "outpost";
  color: string;
}

/** A HUD "ping": an AI mining outpost the local commander can fly to + contest. */
export interface OutpostPing {
  id: string;
  /** Distance from the local commander's controlled unit (m). */
  distance: number;
  /** Pirates still alive defending it. */
  garrisonAlive: number;
  /** Total garrison size. */
  garrisonTotal: number;
  /** True once cleared — its reward cache is unlocked. */
  cleared: boolean;
  /** Credits in the guarded reward cache. */
  rewardAmount: number;
}

export interface CarrierHudState {
  status: ConnStatus;
  /** The local commander's chosen faction identity (id + name + accent colour). */
  faction: { id: FactionId; name: string; color: string } | null;
  players: number;
  hp: number;
  maxHp: number;
  /** Deflector shield of the controlled unit (absorbs hits before hull). */
  shield: number;
  /** Maximum deflector shield of the controlled unit (0 = no shield). */
  maxShield: number;
  alive: boolean;
  respawnIn: number;
  kills: number;
  deaths: number;
  speed: number;
  boost: boolean;
  /** Afterburner heat charge (0..1) — climbs while boosting, bleeds when idle. */
  boostHeat: number;
  /**
   * True while the afterburner is overheated and locked out — it can't re-engage
   * until heat cools back below `AFTERBURNER.recoverAt`.
   */
  boostLocked: boolean;
  /**
   * Monotonic counter bumped each time the afterburner latches into overheat
   * lockout (false→true). The HUD watches it to fire the alarm + red flash.
   */
  overheatPulse: number;
  /**
   * Monotonic counter bumped each time a locked-out afterburner cools back
   * below `recoverAt` and re-engages. Drives the softer "ready again" chirp.
   */
  boostReadyPulse: number;
  /**
   * Monotonic counter bumped each time the controlled unit's hull takes damage
   * (hp decreases). The HUD watches it to fire a throttled hit cue + red flash.
   */
  damagePulse: number;
  /** Spendable credits banked by the local commander (reward boxes + mining). */
  credits: number;
  scoreboard: ScoreRow[];
  /** Deployable role options (cost + availability). */
  deployOptions: DeployOption[];
  /** The local commander's deployed fleet. */
  fleet: FleetRow[];
  /** Entity id currently under direct control (carrier / fighter / fleet unit). */
  controlledEntityId: string | null;
  /** Every controllable unit the commander owns (for the become roster). */
  roster: RosterRow[];
  /** Buildable platform options (cost + availability). */
  buildOptions: BuildOption[];
  /** The local commander's built platforms. */
  platforms: PlatformRow[];
  /** Strategic-map blips (normalised to [-1,1] per axis). */
  mapBlips: MapBlip[];
  /** AI mining outposts ("pings") to fly to + contest, nearest first. */
  outposts: OutpostPing[];
  /** Active mothership camera mode (only meaningful while controlling a carrier). */
  camMode: CamMode;
  /** True while the controlled unit is a mothership (camera modes are available). */
  controllingMother: boolean;
  /** True while the opening fly-around cinematic is playing (suppresses gameplay HUD). */
  cinematic: boolean;
  /** Active onboarding tutorial prompt, or null when not training / finished. */
  hint: TutorialHint | null;
}

/** Mothership camera modes: chase-flight, orbit/survey, free-fly, and the opening cinematic. */
export type CamMode = "follow" | "orbit" | "free" | "intro";

/** A single step of the opening flight-training onboarding sequence. */
export interface TutorialHint {
  /** Short headline, e.g. "Throttle". */
  title: string;
  /** Instructional body line. */
  body: string;
  /** 1-based index of the current step. */
  step: number;
  /** Total number of steps in the sequence. */
  total: number;
}
