/**
 * Pure helpers for reading PostgREST/Supabase error shapes.
 *
 * Deliberately its own module rather than part of `@/lib/supabase`: that module
 * creates the client at import time and is `jest.doMock`ed wholesale by several
 * suites, so a predicate living there would silently become `undefined` under
 * test. Nothing here has side effects or dependencies.
 */

/** The error shape both postgrest-js and supabase-js hand back. */
type PostgrestErrorLike = {
  code?: string;
  message?: string;
};

/**
 * Does this error mean "that column isn't in the schema"?
 *
 * PostgREST fails an ENTIRE select when one requested column is unknown, so a
 * reader that asks for a column a not-yet-migrated environment may lack has to
 * retry with a narrower select. This is the test for "worth retrying narrower":
 * every other failure (no row, RLS, transport) would fail identically on the
 * narrower select and must not cost another round trip.
 *
 * Postgres reports an unknown column as `42703`; PostgREST's schema cache
 * reports one as `PGRST204` and its select parser as `PGRST100`. The message
 * check is a fallback for versions that only populate `message`.
 */
export function isMissingColumnError(
  error: PostgrestErrorLike | null | undefined,
): boolean {
  if (!error) {
    return false;
  }
  const code = error.code ?? '';
  if (code === '42703' || code === 'PGRST204' || code === 'PGRST100') {
    return true;
  }
  const message = (error.message ?? '').toLowerCase();
  return message.includes('does not exist') && message.includes('column');
}
