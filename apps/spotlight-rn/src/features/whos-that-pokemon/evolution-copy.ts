/**
 * Copy for the evolution beat — the classic "What? <NAME> is evolving!" card
 * that leads into the reveal morph.
 *
 * It lives in its own module (not inside the component) because the only part
 * that can embarrass us is the NAME, and a pure function is the only way to
 * test every shape a real account can take: a proper display name, a null one
 * with an email, a null one with nothing, and no signed-in user at all.
 *
 * No trademarked wordmarks, logos, or fonts — this is the app's own type scale
 * saying a familiar sentence.
 */

import { getResolvedDisplayName, type AppUser } from '@/features/auth/auth-models';

/** Opening word. Its own beat, exactly like the show. */
export const EVOLVING_LEAD = 'What?';
/** Closing words. Also its own beat. */
export const EVOLVING_TAIL = 'is evolving!';

/**
 * Used when we have no usable name. Deliberately playful rather than blank —
 * MANY accounts have a null `displayName` (email/OAuth sign-ups that never
 * finished the profile step, and every guest), so this is the common path, not
 * an edge case. A literal "null is evolving!" is the failure mode this exists
 * to make impossible.
 */
export const EVOLVING_FALLBACK_NAME = 'SOMEONE';

/**
 * `getResolvedDisplayName`'s own last-resort string. When it returns this, it
 * did NOT find a name — it invented a noun — so the evolution line prefers its
 * own fallback, which at least reads as a joke instead of as a wrong name.
 */
const GENERIC_RESOLVED_NAME = 'Collector';

/** Long enough for real names, short enough not to wrap the hero line. */
const MAX_NAME_LENGTH = 14;

/**
 * The name to shout in the evolution line, already upper-cased for the card.
 *
 * Resolution order is deliberately the app's own (`getResolvedDisplayName`:
 * display name → email prefix → generic), so this screen never disagrees with
 * the account screen or the feed about who you are. Only the generic tail is
 * swapped for `EVOLVING_FALLBACK_NAME`.
 *
 * The first whitespace-separated token is used: "Stephen Chan" reads better as
 * "STEPHEN is evolving!" and a long full name would otherwise dominate the card.
 */
export function resolveEvolvingName(user: AppUser | null | undefined): string {
  if (!user) {
    return EVOLVING_FALLBACK_NAME;
  }

  const resolved = getResolvedDisplayName(user);
  if (!resolved || resolved === GENERIC_RESOLVED_NAME) {
    return EVOLVING_FALLBACK_NAME;
  }

  const firstToken = resolved.trim().split(/\s+/)[0] ?? '';
  if (!firstToken) {
    return EVOLVING_FALLBACK_NAME;
  }

  const clipped =
    firstToken.length > MAX_NAME_LENGTH ? firstToken.slice(0, MAX_NAME_LENGTH) : firstToken;
  return clipped.toUpperCase();
}

/**
 * The payoff caption on the result panel. The species is NOT interpolated here:
 * it is already the hero line directly underneath, at display size, so
 * repeating it would say the creature's name twice in two adjacent rows.
 *
 * Replaces the old "You are basically…" caption, which said the same thing
 * without paying off the beat the reveal just played.
 */
export function buildEvolvedLead(name: string): string {
  return `${name} evolved into…`;
}
