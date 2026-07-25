# Portfolio Social — Phase 2: public profiles + follow graph

Date: 2026-07-23
Status: DONE 2026-07-24 — 2a + 2b + 2c all built and committed (a19c82f, ef299ae); social
migrations pushed live. Not yet deployed/OTA'd. Deferred: manual user_profiles RLS apply.
Plus Option C (avatars → GCS) landed alongside — see docs/supabase-exit-options-and-cost-2026-07-24.md.
Predecessor: Phase 0 (rename, `b62852b`) and Phase 1 (profile header / Edit Profile / avatars, `62467ad`) are shipped.

---

## In plain English

Today your Portfolio screen is a profile, but it is *your* profile only. There is no way to look at
somebody else's, no way to follow them, and no way to find them. Phase 2 adds those three things.

The catch this phase has to solve is that **you are two databases**. Who you are — name, handle, bio,
avatar, who follows whom — lives in Supabase Postgres. What you own — every card, every price, the
portfolio total — lives in the backend's SQLite, locked to `owner_user_id`. A public profile is a
screen that has to show both at once, for a user who is not the caller.

The good news is the two systems already agree on identity: the backend verifies the Supabase JWT and
pulls the same `user_id` UUID that `user_profiles` and `follows` key off. So there is no id mapping to
invent — only a read path to open up, carefully.

### What we already have

- `follows` table, with either-direction block guards and triggers that maintain `follower_count` /
  `following_count` on `user_profiles`. Shipped in `social_00`, RLS on. **Caveat found during review —
  see "The RLS problem" below: those triggers are not `SECURITY DEFINER`, so they only work while
  `user_profiles` RLS is off.**
- `ProfileHeader` — already props-driven, built in Phase 1 specifically so a second caller could reuse
  it. It takes `followerCount` / `followingCount` / `onFollowersPress` / `onFollowingPress` today and
  does nothing app-specific.
- `Avatar` primitive, `PageTabs`, the Collection grid, and the whole `deck_entries` read path.
- Backend `SupabaseRequestAuthenticator` → `RequestIdentity.user_id` = the Supabase auth UUID.

### What we do not have (the actual work)

1. **Nobody has a handle.** `user_profiles.handle` exists and `updateProfile()` accepts it, but Phase 1's
   Edit Profile never shipped a field for it, so every row is `NULL`. Profiles-by-handle and people
   search have nothing to match on until this is fixed.
2. **`user_profiles` is not publicly readable**, and the file that was supposed to fix it was wrong.
   See "The RLS problem" below — this turned into the largest piece of Phase 2a.
3. **The backend has no non-owner read path.** Every portfolio query resolves the owner implicitly from
   an ambient thread-local (`request_identity_context` → `_current_owner_user_id`). There is no way to
   ask "show me *that* user's cards", and we do not want to fake one by shoving a different identity
   into the ambient context — that would silently open write paths too.
4. No public-profile route, no follow button, no followers/following lists, no people search.

---

## The RLS problem

A security review of `supabase/manual/user_profiles_rls_REVIEW_BEFORE_APPLY.sql` found four real
defects. The file has been rewritten; this section records why, because the reasoning binds the rest of
the social roadmap.

**1. Its guard was a no-op.** The file dropped policies named `user_profiles_public_read` /
`_self_insert` / `_self_update`. The policies actually in production are named `user_profiles_select_own`
/ `_insert_own` / `_update_own` (recorded in `docs/supabase-auth-phase1-setup-2026-04-19.md`). Permissive
policies OR together, so the legacy unrestricted `user_profiles_update_own` would have survived and
neutralized every restriction the new file added — leaving a user able to `PATCH` their own row with
`{"admin_enabled": true}` using only the anon key that ships in the app bundle.

**2. Public read would have leaked moderation state.** RLS filters rows, not columns. A
`using (true)` select policy on `user_profiles` publishes `status`, `is_shadowbanned`, `admin_enabled`,
and `labeler_enabled` along with the profile. A shadowban the shadowbanned user can query is not a
shadowban, and `admin_enabled` is the complete moderator roster. Sharpening this: guests use
`signInAnonymously()`, so they hold the `authenticated` role too — `to authenticated` means anyone with
the bundled anon key, not anyone with an account.

**3. Enabling RLS would have silently broken follower counts.** `tg_follows_counts` (`social_00`) is
not `SECURITY DEFINER`. Trigger functions run as the invoking user, and when A follows B the trigger
updates **B's** row. Under a self-only UPDATE policy that matches zero rows — and RLS filters `UPDATE`
rows silently rather than raising. The follow succeeds, `following_count` increments, `follower_count`
does not, and nothing anywhere errors. Counts drift permanently and asymmetrically.

**4. Column pinning by subquery was fragile and incomplete.** The draft pinned three columns by
re-reading `user_profiles` from inside a policy on `user_profiles`. It left `is_verified`, `reputation`,
`follower_count`, and `labeler_enabled` self-writable (any user could grant themselves the blue check),
and it sits one edit away from `42P17 infinite recursion` — it survives only because the SELECT policy
it recurses into is sublink-free. Adding an `EXISTS` to the read policy, which a block-aware read in 2b
plausibly needs, would make every profile save start failing.

### What replaced it

- **New migration** `20260723090000_social_07_public_profiles_view_counter_triggers.sql` — additive and
  safe to push on its own. Creates the `public_profiles` view (only the columns a profile page renders,
  filtered to `status = 'active' and not is_shadowbanned`, so suspended and shadowbanned users simply
  return "not found" and are never told which), and re-creates both counter triggers with
  `SECURITY DEFINER`. **This must be pushed before the RLS file.**
- **Rewritten RLS file** — drops the real legacy policy names, keeps `user_profiles` self-read-only, and
  fences sensitive columns with `REVOKE UPDATE` + a column-scoped `GRANT` instead of a subquery.
  Column privileges are checked independently of RLS, can't be OR'd away by a stray policy, and have no
  NULL semantics. It now carries a pre-flight checklist, because the repo cannot tell you the real
  column list — `labeler_enabled` exists in production but appears in no SQL file here.
- **`isHandleAvailable()` now reads `public_profiles`.** Against the self-read-only base table it would
  report every other user's handle as free. Worth noting this was already broken before Phase 2: under
  today's self-only select policy the check always returns "available", and only the unique index
  catches the collision at save time.

Two separate gates, and they are not equally risky:

- **The migration must be pushed for 2a to work at all** — the `public_profiles` view is what the app
  reads. It is additive (one view, two function bodies re-created unchanged apart from the qualifier)
  and safe to push normally.
- **Applying the RLS file can be deferred.** Nothing in 2a depends on tightening writes, and the view
  bypasses base-table policies either way. It should land before 2b, since the follow graph is what
  makes the counter-trigger and self-write issues load-bearing.

## Decisions taken (2026-07-23)

| Decision | Choice |
|---|---|
| What a visitor sees on your Collection tab | **Fully public, including per-card values and the portfolio total.** |
| How users get a handle | **Claimed in Edit Profile**, with a live uniqueness check. Profiles stay reachable by user id, so handle-less users still work. |
| Where discovery lives | **The existing top-bar search bubble**, extended with a People section. No new Discover screen. |

Noted and accepted: publishing portfolio totals publicly is a real-world safety consideration at shows.
It stays cheap to walk back — a `collection_public boolean default true` column plus one guard in the
public read path — so this is not a one-way door.

---

## Shape of the build

Three OTA-safe slices. Each leaves the app fully working and is validated before the next starts.

### 2a — Handles + the public profile read path

The foundation. No follow button yet; a visitor can look, not act.

- **Handle claim.** Add a handle field to Edit Profile: lowercase, `[a-z0-9_]`, 3–20 chars, live
  availability check against `user_profiles`. The unique partial index from `social_00`
  (`uq_user_profiles_handle ... where handle is not null`) is the real enforcement; the client check is
  just UX. Handle is optional — never block save on it.
- **Apply the RLS file.** Run `user_profiles_rls_REVIEW_BEFORE_APPLY.sql` consciously, after verifying
  its self-read/insert/update policies cover every flow in `auth-service.ts`. This is the one step in
  Phase 2 that touches the live auth table, so it gets its own verification pass on a preview project
  before staging.
- **Backend public read endpoints.** New, explicitly-scoped, read-only:
  - `GET /api/v1/profiles/{userId}/deck/entries?limit&offset`
  - `GET /api/v1/profiles/{userId}/portfolio/summary` → total value + card count only

  These call **new service methods that take `owner_user_id` as an explicit argument**, rather than
  reusing `request_identity_context` with a borrowed identity. Explicit beats ambient here: it keeps
  owner scoping visible at the call site and makes it structurally impossible for a public read to
  reach a write path. Caller must still be authenticated and pass the access gate.
- **Public profile route + screen.** `/u/[handle]` resolving to a user id, plus an id-based fallback for
  handle-less users. Reuses `ProfileHeader` unchanged and the existing Collection grid. For Sale /
  Activity tabs show the same "Coming soon" state they show on your own profile.

### 2b — The follow graph

- Follow / Unfollow button on the public profile, optimistic count update, rollback on failure.
  Writes go straight to Supabase under the `follows_insert` / `follows_delete` policies — no backend
  involvement, and the DB triggers keep the counts honest.
- Followers and Following list screens, reachable from the header chips that Phase 1 already wired
  `onFollowersPress` / `onFollowingPress` for.

### 2c — People discovery

- Extend the top-bar search bubble with a People section: handle and display-name prefix match against
  `user_profiles`, results routing to `/u/[handle]`.

---

## Deliberate scope calls

**No price chart on other people's profiles (2a).** The portfolio dashboard is the known-expensive read
— cold reads were 22s before the projection fix, 4.8s after — and it is expensive *per owner*. Serving
it for arbitrary visitors multiplies that cost across users who never asked for it. Visitors get the
total value and the card grid; the chart stays owner-only. This does not contradict "the Collection
graph is permanent" — that rule is about your own portfolio, which is untouched. Revisit once we can
see real traffic on the public endpoints.

**Blocks are not enforced backend-side in Phase 2.** `blocks` lives in Supabase; the backend cannot see
it without a Supabase round-trip on every public read. The app resolves the profile from Supabase
first, where the block is visible, and only then fetches cards — so the normal path is correct. A
determined blocked user hitting the backend endpoint directly could still read the grid. That is a
known, accepted gap for this phase; hard enforcement belongs with the moderation UI in Phase 6.

**Cover images are still not uploadable.** Phase 1 shipped `handlePickCover` as a stub. Public profiles
will render the placeholder cover until that lands. Not a blocker.

---

## Validation per slice

- `pnpm --filter @spotlight/mobile-app typecheck` + `lint` + `jest` green; new components get tests.
- Backend: relevant tests under `backend/tests/`, plus a direct check that
  `/api/v1/profiles/{userId}/deck/entries` returns the *target's* rows and that no write route accepts
  a target-user parameter.
- Flag off → OTA to staging → judge on device → flip on. Each slice is one OTA.

---

## Appendix — critical files

**Supabase**
- `apps/spotlight-rn/supabase/migrations/20260720090000_social_00_identity_helpers_graph.sql` — `follows`,
  `blocks`, `mutes`, `tg_follows_counts`, `is_blocked`, `uq_user_profiles_handle`
- `apps/spotlight-rn/supabase/manual/user_profiles_rls_REVIEW_BEFORE_APPLY.sql` — apply in 2a

**Mobile — existing, reused**
- `src/features/profile/components/profile-header.tsx` — reuse as-is
- `src/features/profile/screens/edit-profile-screen.tsx` — add handle field (2a)
- `src/features/auth/auth-service.ts` — `profileSelectFull` (~line 60), `updateProfile` (~line 330)
- `src/features/auth/auth-models.ts` — `UserProfile`
- `src/features/portfolio/screens/portfolio-screen.tsx` — the layout the public screen mirrors
- `src/app/(sheet)/catalog/search.tsx` — discovery entry point (2c)
- `packages/design-system/src/components/avatar.tsx`, `page-tabs.tsx`

**Mobile — new**
- `src/features/profile/screens/public-profile-screen.tsx`
- `src/features/profile/screens/follow-list-screen.tsx` (2b)
- `src/features/profile/profile-service.ts` — Supabase reads for profiles + follow graph
- `src/app/(stack)/u/[handle].tsx`

**Backend**
- `backend/server.py` — route dispatch (`/api/v1/deck/entries` ~16871, `/api/v1/portfolio/dashboard`
  ~17027), `request_identity_context` ~1418, `_current_owner_user_id` ~1445
- `backend/request_auth.py` — JWT → `RequestIdentity.user_id`
- `packages/api-client/src/spotlight/repository.ts` — add the public-profile client methods
