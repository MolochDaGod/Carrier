/**
 * Lightweight load-queue bookkeeping for hangar warmup / HUD debug.
 * Real decode concurrency is owned by `preloadAssets({ concurrency })`.
 */

let concurrency = 4;
let stats = { queued: 0, active: 0, done: 0, failed: 0 };

/** Prefer CDN asset URLs when available (carrier hangar badge). */
export function isCdnPreferred(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const q = new URLSearchParams(window.location.search);
    if (q.get("cdn") === "0") return false;
    if (q.get("cdn") === "1") return true;
  } catch {
    /* ignore */
  }
  // Default on for production hosts.
  return /grudge-studio\.com$|vercel\.app$/.test(window.location.hostname);
}

export function setLoadConcurrency(n: number): void {
  concurrency = Math.max(1, Math.min(16, n | 0));
}

export function getLoadConcurrency(): number {
  return concurrency;
}

export function resetLoadQueueStats(): void {
  stats = { queued: 0, active: 0, done: 0, failed: 0 };
}

export function getLoadQueueStats(): {
  queued: number;
  active: number;
  done: number;
  failed: number;
  concurrency: number;
} {
  return { ...stats, concurrency };
}

export function noteLoadQueueEvent(
  kind: "queued" | "active" | "done" | "failed",
): void {
  if (kind === "queued") stats.queued++;
  else if (kind === "active") stats.active++;
  else if (kind === "done") {
    stats.done++;
    stats.active = Math.max(0, stats.active - 1);
  } else if (kind === "failed") {
    stats.failed++;
    stats.active = Math.max(0, stats.active - 1);
  }
}
