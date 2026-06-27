/**
 * Tiny self-contained WebAudio cue layer for Carrier. No asset files — every
 * sound is synthesised from oscillators with a short gain envelope, so it is
 * zero-dependency and safe to fire from the React HUD. A single AudioContext is
 * created lazily on first use (after the player has already interacted with the
 * page, so autoplay policies don't block it) and resumed if suspended.
 */

let ctx: AudioContext | null = null;

/**
 * Shared master mute/volume state for every cue. Persisted to localStorage so
 * the choice follows the player across sessions, and exposed as a tiny
 * subscribe/getSnapshot store so the HUD can drive it with useSyncExternalStore.
 */
const STORAGE_KEY = "carrier:audio";
const VOLUME_DEFAULT = 0.8;

type AudioPrefs = { muted: boolean; volume: number };

function clampVolume(v: number): number {
  if (!Number.isFinite(v)) return VOLUME_DEFAULT;
  return Math.max(0, Math.min(1, v));
}

function loadPrefs(): AudioPrefs {
  if (typeof localStorage === "undefined") {
    return { muted: false, volume: VOLUME_DEFAULT };
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { muted: false, volume: VOLUME_DEFAULT };
    const parsed = JSON.parse(raw) as Partial<AudioPrefs>;
    return {
      muted: parsed.muted === true,
      volume: clampVolume(parsed.volume ?? VOLUME_DEFAULT),
    };
  } catch {
    return { muted: false, volume: VOLUME_DEFAULT };
  }
}

let prefs: AudioPrefs = loadPrefs();
const listeners = new Set<() => void>();
let snapshot: AudioPrefs = prefs;

function persist(): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* storage full / unavailable — keep the in-memory value */
  }
}

function emit(): void {
  snapshot = { ...prefs };
  for (const l of listeners) l();
}

/** Subscribe to mute/volume changes (for React's useSyncExternalStore). */
export function subscribeAudio(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Current mute/volume snapshot (stable reference until a change). */
export function getAudioPrefs(): AudioPrefs {
  return snapshot;
}

export function setAudioMuted(muted: boolean): void {
  if (prefs.muted === muted) return;
  prefs = { ...prefs, muted };
  persist();
  emit();
}

export function setAudioVolume(volume: number): void {
  const v = clampVolume(volume);
  if (prefs.volume === v) return;
  prefs = { ...prefs, volume: v };
  persist();
  emit();
}

/** Effective gain multiplier applied to every cue (0 when muted). */
function masterGain(): number {
  return prefs.muted ? 0 : prefs.volume;
}

function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  try {
    if (!ctx) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
    }
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/**
 * One short oscillator beep with an attack/decay envelope.
 * @param freq    frequency in Hz
 * @param start   delay (seconds) before the beep begins
 * @param dur     beep length in seconds
 * @param type    oscillator waveform
 * @param peak    peak gain (0..1)
 */
function beep(
  ac: AudioContext,
  freq: number,
  start: number,
  dur: number,
  type: OscillatorType,
  peak: number,
): void {
  const scaledPeak = peak * masterGain();
  if (scaledPeak <= 0.0001) return;
  const t0 = ac.currentTime + start;
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(scaledPeak, t0 + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain).connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

/**
 * Harsh two-tone klaxon for the afterburner overheat lockout — an unmistakable
 * "you cut out" alarm.
 */
export function playOverheatAlarm(): void {
  const ac = audio();
  if (!ac) return;
  beep(ac, 660, 0, 0.16, "sawtooth", 0.22);
  beep(ac, 440, 0.18, 0.22, "sawtooth", 0.22);
}

/**
 * Soft rising chirp when a locked-out afterburner cools and re-engages.
 */
export function playBoostReadyChirp(): void {
  const ac = audio();
  if (!ac) return;
  beep(ac, 520, 0, 0.09, "sine", 0.12);
  beep(ac, 780, 0.08, 0.12, "sine", 0.12);
}

/**
 * Sharp descending two-tone "thunk" when the hull takes a hit — quick and
 * percussive so damage reads instantly without drowning out the action.
 */
export function playHitCue(): void {
  const ac = audio();
  if (!ac) return;
  beep(ac, 260, 0, 0.07, "square", 0.18);
  beep(ac, 150, 0.04, 0.11, "square", 0.15);
}

/**
 * Low, urgent two-tone pulse for the critical-hull warning. The HUD repeats it
 * on a timer while hp stays under the danger threshold, and stops on recovery.
 */
export function playLowHealthWarning(): void {
  const ac = audio();
  if (!ac) return;
  beep(ac, 330, 0, 0.15, "triangle", 0.13);
  beep(ac, 300, 0.16, 0.2, "triangle", 0.11);
}
