/**
 * @workspace/grudge-id
 * --------------------
 * Shared platform identity for GRUDOX and every game/editor artifact: the Puter
 * SDK loader, the guest-first Grudge ID auth context, and the cross-app profile
 * store. One identity definition used everywhere so the same account is
 * recognised across the hub, the Arcade, Carrier and the Game Studio.
 */

export {
  loadPuter,
  signedInKv,
  type PuterUser,
  type PuterClient,
  type PuterSignInOptions,
  type PuterSignInResult,
} from "./puter.js";

export {
  GrudgeAuthProvider,
  PuterAuthProvider,
  useAuth,
  useProfile,
  type GrudgeAuthValue,
} from "./GrudgeAuth.js";

export {
  CRESTS,
  crestFor,
  ensureProfile,
  grudgeIdFor,
  loadProfile,
  recordGamePlayed,
  recordProjectCreated,
  updateDisplayName,
  type ActivityEntry,
  type Crest,
  type GrudgeProfile,
  type GrudgeStats,
} from "./profile.js";
