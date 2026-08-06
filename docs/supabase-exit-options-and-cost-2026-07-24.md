# Getting off Supabase — options, cost, and a phased exit

Date: 2026-07-24
Status: **SUPERSEDED 2026-08-06 by `docs/supabase-scale-plan-and-escape-hatch-2026-08-06.md`.**
Kept for history. Its analysis was directionally right — data lock-in near zero, auth is the anchor,
Option C (avatars → GCS) was the highest-leverage move and is now **done**. What it lacked was real
numbers: measured MAU, actual Supabase/Cloud SQL/auth-vendor pricing, and the finding that the
scanner fleet, not the database, is what breaks first. Read the 2026-08-06 doc for the decision.

Related: [[project_social_layer]], `docs/gcp-cost-hosting-decision` (staying on GCP), and the Phase 2
plan `docs/portfolio-social-phase-2-public-profiles-follow-2026-07-23.md`.

---

## The worry, in plain terms

The Supabase "lock-in horror stories" are real, but they are specific. They come from three places:

1. **Egress / bandwidth** — serving user images (avatars, post photos) out of Supabase Storage. This is
   almost always the first bill that hurts, and it scales with usage, not with users.
2. **MAU-priced auth** — GoTrue is billed per monthly-active-user above the plan's included tier.
3. **Proprietary entanglement** — Edge Functions, and building so much around Supabase-only behavior
   that leaving means a rewrite.

Where we actually stand against each:

| Risk | Our exposure | Why |
|---|---|---|
| Egress | **Low, and about to be lower** | Only avatars use Storage today; Option C moves them to GCS+CDN before post images (Phase 3) ever land there. |
| MAU auth | **Deferred** | Real, but only matters past ~100k MAU. Fixable by extracting GoTrue (below). |
| Proprietary lock-in | **Near zero** | No Edge Functions. Data is plain Postgres. Realtime not built yet. RLS is standard Postgres. |

The single most important fact: **the data is not locked in.** Every table is plain PostgreSQL,
movable with `pg_dump`/`pg_restore`. What is sticky is *auth* and, secondarily, *storage* — and both
have clean exits below.

---

## What Supabase actually gives us (and the replacement for each)

We use five of Supabase's pieces. We deliberately avoid the sixth (Edge Functions).

| Piece | What it does for us | Replacement (we're on GCP) | Migration difficulty |
|---|---|---|---|
| **Postgres + RLS** | `user_profiles` + the 16 social tables | **Cloud SQL for Postgres** (same region as the VM) | Easy — `pg_dump`; RLS is standard Postgres |
| **Auth (GoTrue)** | email/password, OTP, Apple/Google OAuth, anonymous sign-in; issues the JWTs the backend verifies | keep **standalone GoTrue** container, OR Google Identity Platform / SuperTokens | Hard — the real anchor |
| **Storage** | `avatars` (public), `post-media` (private, Phase 3) | **GCS** + **Cloud CDN**; backend already speaks GCS (`scan_artifact_store.py`) | Moderate |
| **PostgREST** | the auto REST API the RN client hits for social reads/writes | self-host **PostgREST** against Cloud SQL, OR fold into the Python backend | Moderate |
| **Realtime** | (Phase 5 DMs — not built) | self-host Supabase Realtime, Postgres `LISTEN/NOTIFY` + a WS server, or Ably/Pusher | Free to choose |
| Edge Functions | not used | n/a | n/a |

The clever middle path: **extract just GoTrue + PostgREST as standalone containers against Cloud SQL.**
Because that preserves the JWT format and the `auth.uid()` SQL helper, the RLS policies and the
backend's JWT verification (`request_auth.py`) keep working almost unchanged. That is the lowest-code
full exit.

---

## The three shapes of "leave"

**Option A — Self-host the whole Supabase stack on GCP.**
Supabase is open source; run Postgres + GoTrue + PostgREST + Realtime + Storage + Kong via Docker
Compose on a VM (or GKE). The `@supabase/supabase-js` client just points at your URL — app code barely
changes. Cost: you now operate Postgres backups/PITR/HA + auth + storage. Trades dollars for on-call.
Good if you want to keep the exact programming model and are willing to run infra.

**Option B — Decompose into GCP-native services.**
Cloud SQL (Postgres) + standalone GoTrue (or Identity Platform) + GCS/CDN (storage) + PostgREST-or-Python
(API) + a chosen Realtime. Consolidates onto one cloud and one IAM. More moving parts to wire once, but
each piece is best-fit and independently scalable. This is the likely end state.

**Option C — Stay, but kill the expensive part now.** (doing this now)
Move image serving to GCS + Cloud CDN while leaving auth/DB/RLS on Supabase. Attacks the #1 cost
(egress) directly, touches only the avatar upload path today, and sets the pattern so Phase 3 post
images never touch Supabase Storage. Lowest risk, highest cost-per-effort.

---

## Recommended sequence

1. **Now — Option C for avatars.** Backend endpoint uploads to a public GCS bucket, reusing the
   `scan_artifact_store.py` GCS client; the client stops calling `supabase.storage`. Implemented behind
   `SPOTLIGHT_AVATARS_GCS_BUCKET`, inert until the bucket exists. See "Option C cutover" below.
2. **Before Phase 3 (posts).** Make post-media uploads use the same GCS path from day one. This is where
   real egress would otherwise accumulate.
3. **Before Phase 5 (DMs).** Choose Realtime deliberately so we don't take on Supabase Realtime lock-in
   we'd later have to unwind.
4. **When MAU or the DB bill hurts.** Extract GoTrue + PostgREST onto Cloud SQL (Option B middle path).
   Co-locating Postgres with the VM is the natural consolidation and matches the long-standing
   "revisit Cloud SQL at consolidation/scale" note.

Nothing forces a full migration now, and the Phase 2 social work did not increase lock-in.

---

## Option C cutover (avatars → GCS) — concrete

**Code (being implemented now):**
- Backend `POST /api/v1/profile/avatar` — authenticated; uploads the caller's JPEG to
  `gs://<bucket>/avatars/<user_id>.jpg`, object path derived from the verified identity (not a
  client-supplied id, so nobody can overwrite another user's avatar); returns `{ avatarUrl }`.
- Gated on `SPOTLIGHT_AVATARS_GCS_BUCKET`; returns "not configured" until set.
- Client: `edit-profile-screen.tsx` posts the resized bytes to the endpoint instead of
  `supabase.storage`, keeps the cache-buster and the defensive no-crash behavior.

**Infra the user provisions (one-time, ~15 min):**
1. Create a GCS bucket, e.g. `spotlight-avatars-prod`, in the VM's region.
2. Make it public-read (`allUsers` → Storage Object Viewer) OR front it with Cloud CDN + a backend
   bucket (preferred at scale — caches at the edge, cuts origin egress).
3. Ensure the VM's service account has `Storage Object Admin` on it (the scan-artifacts SA likely
   already has the shape).
4. Set `SPOTLIGHT_AVATARS_GCS_BUCKET=spotlight-avatars-prod` on the backend and redeploy.
5. (Optional) lifecycle rule / naming already means one object per user, so storage stays tiny.

Existing avatars already in Supabase Storage keep working (their URLs are stored in
`user_profiles.avatar_url`); only new uploads use GCS. A backfill is optional and low priority.

---

## Rough cost intuition (not a quote)

- **Supabase** scales as: Pro base + usage (egress, MAU above tier, storage GB, Realtime, compute
  add-ons). Egress and MAU are the ones that surprise people.
- **GCS + Cloud CDN**: storage is cheap (~$0.02/GB-mo); the win is CDN edge caching cutting repeat
  egress, and you control it. One avatar per user = negligible storage.
- **Cloud SQL**: a fixed monthly instance cost (right-sized, co-located with the VM → no cross-region
  egress, free intra-region to the app). Predictable, unlike per-usage auth/egress.
- **The hidden cost of self-hosting is operations**, not compute. If you self-manage Postgres, budget
  for tested restores, failover, and upgrades — or use Cloud SQL managed to keep the RLS model without
  owning `pg_basebackup`.

Bottom line: the highest-leverage cost move is CDN-fronted image serving (Option C), not a full
migration. The full migration is feasible whenever you want it, dominated by auth, and doesn't get
harder because of anything we built in Phase 2.
