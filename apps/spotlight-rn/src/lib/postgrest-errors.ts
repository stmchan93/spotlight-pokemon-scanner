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

/**
 * Does this error mean "that RPC isn't in the schema (yet)"?
 *
 * Migrations land per environment, so a client that calls a function added by a
 * recent migration must survive an environment that has not run it. PostgREST
 * reports an unknown RPC as `PGRST202` ("Could not find the function ... in the
 * schema cache"); Postgres itself reports one as `42883` (undefined_function).
 *
 * This is the test for "fall back to the older read path": every other failure
 * (RLS, transport, a raise inside the function) means the function DOES exist
 * and retrying a different way would be wrong.
 */
export function isMissingFunctionError(
  error: PostgrestErrorLike | null | undefined,
): boolean {
  if (!error) {
    return false;
  }
  const code = error.code ?? '';
  if (code === 'PGRST202' || code === '42883') {
    return true;
  }
  const message = (error.message ?? '').toLowerCase();
  return message.includes('function') && (
    message.includes('does not exist') || message.includes('could not find')
  );
}

/**
 * Does this error mean "your role may not write that"?
 *
 * Postgres raises `42501` / `permission denied for table <t>` when a statement
 * touches a column the caller has no INSERT/UPDATE privilege on. That is a
 * TABLE-level message even when the cause is a single column, so it can only be
 * attributed by knowing which columns the statement actually carried.
 *
 * This matters here because `user_profiles` is fenced by COLUMN grants, not by
 * a table grant (social_08 revokes table-level insert/update from
 * `authenticated` and re-grants column by column). A column added by a later
 * migration therefore starts with NO write privilege until it is granted
 * explicitly — the column exists and reads fine, and only writes are refused.
 */
export function isInsufficientPrivilegeError(
  error: PostgrestErrorLike | null | undefined,
): boolean {
  if (!error) {
    return false;
  }
  if ((error.code ?? '') === '42501') {
    return true;
  }
  return (error.message ?? '').toLowerCase().includes('permission denied');
}

/**
 * Does this WRITE error mean "the database will not accept that column"?
 *
 * Two distinct causes with one remedy — retry without the column:
 *   * it does not exist yet (the migration has not been applied), or
 *   * it exists but carries no write grant for the caller's role.
 *
 * PostgREST fails the ENTIRE statement either way, so a single unwritable
 * column otherwise takes down every other field in the same patch.
 */
export function isColumnWriteRejectedError(
  error: PostgrestErrorLike | null | undefined,
): boolean {
  return isMissingColumnError(error) || isInsufficientPrivilegeError(error);
}
