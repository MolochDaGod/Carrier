/**
 * Loader and typed surface for Puter.js (https://js.puter.com/v2/).
 *
 * Puter provides free, no-API-key auth plus a per-user key/value store. The v2
 * script is loaded lazily from the CDN and wrapped in a small typed surface so
 * the rest of the platform never touches the untyped global directly.
 *
 * This is the single shared copy used by GRUDOX and every game/editor artifact:
 * because all artifacts are served from one proxy origin, they share the same
 * Puter session (and therefore the same Grudge ID) automatically.
 */

/** The subset of the Puter global we rely on. */
export interface PuterUser {
  /** Stable unique id for the account (including guest accounts). */
  uuid: string;
  username: string;
  email_confirmed?: boolean;
  /** True when this is a temporary "guest" account (no signup yet). */
  is_temp?: boolean;
}

/** Options accepted by `puter.auth.signIn()`. */
export interface PuterSignInOptions {
  /**
   * When true, Puter silently provisions a temporary guest account instead of
   * requiring the user to sign up. The guest can convert to a full account
   * later by signing in normally.
   */
  attempt_temp_user_creation?: boolean;
}

/** Result resolved by `puter.auth.signIn()`. */
export interface PuterSignInResult {
  success?: boolean;
  username?: string;
  error?: string;
}

export interface PuterClient {
  auth: {
    isSignedIn: () => boolean;
    getUser: () => Promise<PuterUser>;
    signIn: (options?: PuterSignInOptions) => Promise<PuterSignInResult>;
    signOut: () => void;
  };
  kv: {
    get: (key: string) => Promise<string | null>;
    set: (key: string, value: string) => Promise<boolean>;
    del: (key: string) => Promise<boolean>;
  };
}

declare global {
  interface Window {
    puter?: PuterClient;
  }
}

const PUTER_SRC = "https://js.puter.com/v2/";
let loadPromise: Promise<PuterClient> | null = null;

/**
 * Ensure the Puter SDK is loaded and return the client. The promise is cached
 * so concurrent callers share a single script-injection.
 */
export function loadPuter(): Promise<PuterClient> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Puter can only load in the browser"));
  }
  if (window.puter) return Promise.resolve(window.puter);
  if (loadPromise) return loadPromise;

  const attempt = new Promise<PuterClient>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${PUTER_SRC}"]`);
    const onReady = () => {
      if (window.puter) resolve(window.puter);
      else reject(new Error("Puter SDK loaded but window.puter is undefined"));
    };

    if (existing) {
      if (window.puter) resolve(window.puter);
      else existing.addEventListener("load", onReady, { once: true });
      existing.addEventListener("error", () => reject(new Error("Failed to load Puter SDK")), {
        once: true,
      });
      return;
    }

    const script = document.createElement("script");
    script.src = PUTER_SRC;
    script.async = true;
    script.addEventListener("load", onReady, { once: true });
    script.addEventListener("error", () => reject(new Error("Failed to load Puter SDK")), {
      once: true,
    });
    document.head.appendChild(script);
  });

  // Reset the cached promise on failure so a later call can retry, while
  // concurrent callers still share this single in-flight attempt.
  loadPromise = attempt.catch((err) => {
    loadPromise = null;
    throw err;
  });

  return loadPromise;
}

/**
 * Resolve the per-user key/value store when a user is signed in (including
 * temporary guest accounts), or `null` when not signed in or the SDK is
 * unavailable. Callers use this to sync data per-user across devices while
 * falling back to device-local storage when it returns `null`.
 */
export async function signedInKv(): Promise<PuterClient["kv"] | null> {
  try {
    const puter = await loadPuter();
    if (!puter.auth.isSignedIn()) return null;
    return puter.kv;
  } catch {
    return null;
  }
}
