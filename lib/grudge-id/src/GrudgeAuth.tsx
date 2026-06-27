/**
 * Grudge ID authentication context.
 *
 * Wraps the lazily-loaded Puter SDK in a React context that exposes the current
 * user, the resolved Grudge ID profile, loading/sign-in state, and
 * sign-in/upgrade/out actions. This is the single shared identity used by GRUDOX
 * and every game/editor artifact, so the same account (and Grudge ID) is
 * recognised everywhere with no second login.
 *
 * Behaviour is guest-first: on mount a one-shot bootstrap restores an existing
 * session or silently provisions a temporary guest account (no popup, no
 * gesture). A plain `signIn()` upgrades a guest in place, keeping its KV data.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { loadPuter, type PuterUser } from "./puter.js";
import { ensureProfile, loadProfile, type GrudgeProfile } from "./profile.js";
import { clearCachedProfile, readCachedProfile, writeCachedProfile } from "./cache.js";

export interface GrudgeAuthValue {
  /** The signed-in user (guest or full), or null when signed out. */
  user: PuterUser | null;
  /** The resolved Grudge ID profile for the current user, or null. */
  profile: GrudgeProfile | null;
  /** True when the current user is a temporary guest account. */
  isGuest: boolean;
  /** True until the initial session check resolves. */
  loading: boolean;
  /** True while a sign-in / guest-entry request is in flight. */
  signingIn: boolean;
  /** Non-null when the SDK failed to load or sign-in failed. */
  error: string | null;
  /** Enter instantly as a guest (provisions a temporary Puter account). */
  enterAsGuest: () => Promise<void>;
  /**
   * Sign in with a full Puter account. Also used to upgrade a guest: signing in
   * converts the temporary account into a permanent one, keeping its data.
   */
  signIn: () => Promise<void>;
  signOut: () => void;
  /** Re-read the profile from the store (after recording activity, etc.). */
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<GrudgeAuthValue | null>(null);

/**
 * One-shot session bootstrap: restore an existing Puter session, or quietly
 * provision a temporary guest account when none exists. Memoised in module scope
 * so it runs at most once even when React StrictMode double-invokes effects in
 * development, preventing duplicate / racing sign-in calls.
 */
let bootstrapPromise: Promise<PuterUser | null> | null = null;

function bootstrapSession(): Promise<PuterUser | null> {
  if (!bootstrapPromise) {
    bootstrapPromise = (async () => {
      const puter = await loadPuter();
      if (!puter.auth.isSignedIn()) {
        const result = await puter.auth.signIn({ attempt_temp_user_creation: true });
        if (result && result.success === false) {
          throw new Error(result.error || "Could not start a guest session");
        }
      }
      return puter.auth.getUser();
    })();
  }
  return bootstrapPromise;
}

export function GrudgeAuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PuterUser | null>(null);
  // Seed from the last-known profile so the header / Account render instantly on
  // repeat visits instead of flashing empty while the async bootstrap resolves.
  const [profile, setProfile] = useState<GrudgeProfile | null>(() => readCachedProfile());
  const [loading, setLoading] = useState(true);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // On mount, run the one-shot session bootstrap (restore an existing session or
  // quietly provision a guest). Guest provisioning needs no popup or user
  // gesture, so the whole flow stays behind the host's loading screen — the
  // player never sees a sign-in prompt and lands straight in once everything is
  // ready. The error-only fallback (see each host's gate) is reached only if
  // this fails. The `cancelled` flag guards state writes after unmount.
  useEffect(() => {
    let cancelled = false;
    bootstrapSession()
      .then((u) => {
        if (!cancelled) setUser(u);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Authentication unavailable");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Whenever the user changes, resolve (and seed-on-first-sight) their profile.
  useEffect(() => {
    if (!user) {
      setProfile(null);
      return;
    }
    let cancelled = false;
    ensureProfile(user)
      .then((p) => {
        if (!cancelled) {
          setProfile(p);
          writeCachedProfile(p);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [user]);

  const refreshProfile = useCallback(async () => {
    if (!user) return;
    const p = await loadProfile(user).catch(() => null);
    if (p) {
      setProfile(p);
      writeCachedProfile(p);
    }
  }, [user]);

  // Shared sign-in path. `asGuest` provisions a temporary account silently;
  // otherwise Puter opens its popup for a full account (and converts an existing
  // guest in place). Either way we refresh the user object afterwards.
  const runSignIn = useCallback(async (asGuest: boolean) => {
    setSigningIn(true);
    setError(null);
    try {
      const puter = await loadPuter();
      const result = await puter.auth.signIn(
        asGuest ? { attempt_temp_user_creation: true } : undefined,
      );
      // The SDK can resolve with a failure result instead of throwing; surface it.
      if (result && result.success === false) {
        throw new Error(result.error || "Sign-in failed");
      }
      const u = await puter.auth.getUser();
      setUser(u);
    } catch (e: unknown) {
      // A user closing the popup rejects the promise; treat as a soft cancel.
      const message = e instanceof Error ? e.message : "Sign-in failed";
      if (!/cancel|close|abort/i.test(message)) setError(message);
    } finally {
      setSigningIn(false);
    }
  }, []);

  const enterAsGuest = useCallback(() => runSignIn(true), [runSignIn]);
  const signIn = useCallback(() => runSignIn(false), [runSignIn]);

  const signOut = useCallback(() => {
    void loadPuter()
      .then((puter) => puter.auth.signOut())
      .catch(() => undefined)
      .finally(() => {
        setUser(null);
        setProfile(null);
        clearCachedProfile();
      });
  }, []);

  const value = useMemo<GrudgeAuthValue>(
    () => ({
      user,
      profile,
      isGuest: user?.is_temp === true,
      loading,
      signingIn,
      error,
      enterAsGuest,
      signIn,
      signOut,
      refreshProfile,
    }),
    [user, profile, loading, signingIn, error, enterAsGuest, signIn, signOut, refreshProfile],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** Backwards-compatible alias so existing artifacts can drop in the provider. */
export const PuterAuthProvider = GrudgeAuthProvider;

export function useAuth(): GrudgeAuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within a GrudgeAuthProvider");
  return ctx;
}

/** Convenience accessor for just the resolved profile. */
export function useProfile(): GrudgeProfile | null {
  return useAuth().profile;
}
