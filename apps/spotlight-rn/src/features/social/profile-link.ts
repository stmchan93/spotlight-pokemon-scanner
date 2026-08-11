/**
 * Where a person's name or avatar leads: `/u/<handle>`, falling back to their
 * user id.
 *
 * The `/u/[handle]` route accepts either — it detects a UUID slug and resolves
 * it by id — which is what makes collectors who have not claimed a handle
 * reachable at all. Without the fallback their name would simply be dead text.
 *
 * One helper because three surfaces (post cards, the comment thread, and search
 * results) all have to agree on the rule; a per-screen copy is how one of them
 * ends up silently non-navigable for handle-less users.
 */
export function profileRouteSlug(
  handle: string | null | undefined,
  userId: string | null | undefined,
): string | null {
  const trimmedHandle = handle?.trim();
  if (trimmedHandle) {
    return trimmedHandle;
  }
  const trimmedId = userId?.trim();
  return trimmedId || null;
}
