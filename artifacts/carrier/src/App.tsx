import { CarrierLauncher } from "@/game/CarrierLauncher";
import { PuterAuthProvider, useAuth } from "@/auth/PuterAuth";
import { MothershipInspectorView } from "@/game/MothershipInspectorView";

/** Hidden dev flag — `?inspect` in the URL opens the mothership inspector. */
const INSPECT = new URLSearchParams(window.location.search).has("inspect");

/**
 * Carrier root.
 *
 * Wraps the cabinet in the standard Puter game auth used across the studio
 * games. On arrival the provider silently restores an existing session (so a
 * player who already signed in elsewhere drops straight in) or quietly
 * provisions a guest — no prompt unless that fails.
 */
export default function App() {
  // Dev-only mothership inspector: bypasses the Puter gate entirely so station
  // sizing can be confirmed by eye without an account or a live match.
  if (INSPECT) {
    return (
      <div className="fixed inset-0 bg-[#05070f]">
        <MothershipInspectorView />
      </div>
    );
  }

  return (
    <PuterAuthProvider>
      <div className="fixed inset-0 bg-[#010208]">
        <AuthGate />
      </div>
    </PuterAuthProvider>
  );
}

function AuthGate() {
  const { loading, error, user, signIn, enterAsGuest, signingIn } = useAuth();

  if (loading) {
    return (
      <div className="fixed inset-0 grid place-items-center bg-[#04060f] text-white">
        <div className="text-center">
          <div className="text-xs uppercase tracking-[0.45em] text-[#00d4ff]/70">
            Online space combat
          </div>
          <div className="mt-2 text-4xl font-bold uppercase tracking-[0.3em] text-[#00d4ff] drop-shadow-[0_0_18px_rgba(0,212,255,0.45)]">
            Carrier
          </div>
          <div className="mt-6 text-xs uppercase tracking-[0.4em] text-white/40">
            Establishing uplink…
          </div>
        </div>
      </div>
    );
  }

  // Error-only fallback: the silent bootstrap failed, so offer a manual retry.
  if (!user) {
    return (
      <div className="fixed inset-0 grid place-items-center bg-[#04060f] px-6 text-center text-white">
        <div className="flex max-w-sm flex-col items-center gap-5">
          <div>
            <div className="text-xs uppercase tracking-[0.45em] text-[#00d4ff]/70">
              Online space combat
            </div>
            <h1 className="mt-1 text-5xl font-bold uppercase tracking-[0.3em] text-[#00d4ff] drop-shadow-[0_0_18px_rgba(0,212,255,0.45)]">
              Carrier
            </h1>
          </div>
          {error && <p className="text-sm text-red-400/80">{error}</p>}
          <button
            onClick={enterAsGuest}
            disabled={signingIn}
            className="w-full rounded-md border-2 border-[#00d4ff] bg-[#00d4ff]/15 px-8 py-2.5 text-sm font-bold uppercase tracking-[0.25em] text-[#00d4ff] hover:bg-[#00d4ff]/25 disabled:opacity-50"
          >
            {signingIn ? "Linking…" : "Play as guest"}
          </button>
          <button
            onClick={signIn}
            disabled={signingIn}
            className="text-xs uppercase tracking-widest text-white/50 hover:text-white/80 disabled:opacity-50"
          >
            Sign in with Puter
          </button>
        </div>
      </div>
    );
  }

  return <CarrierLauncher onExit={() => { /* standalone app — no lobby to return to */ }} />;
}
