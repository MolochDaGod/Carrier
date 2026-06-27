/**
 * Puter SDK surface — re-exported from the shared @workspace/grudge-id library.
 *
 * The loader, typed client and per-user KV helper now live in one shared place
 * so GRUDOX and every game/editor artifact share the same Puter session (and
 * therefore the same Grudge ID). This module keeps the local `@/lib/puter`
 * import path stable for the rest of Carrier.
 */
export {
  loadPuter,
  signedInKv,
  type PuterUser,
  type PuterClient,
  type PuterSignInOptions,
  type PuterSignInResult,
} from "@workspace/grudge-id";
