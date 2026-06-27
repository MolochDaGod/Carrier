/**
 * Grudge ID auth context — re-exported from the shared @workspace/grudge-id lib.
 *
 * The provider, hook and profile model are shared across GRUDOX and every
 * game/editor artifact so one signed-in account (one Grudge ID) is recognised
 * everywhere. This module keeps the local `@/auth/PuterAuth` import path stable
 * for the rest of Carrier.
 */
export {
  PuterAuthProvider,
  GrudgeAuthProvider,
  useAuth,
  useProfile,
  type GrudgeAuthValue,
} from "@workspace/grudge-id";
