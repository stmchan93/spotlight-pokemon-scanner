# Social Layer — Database Design (posts, comments, likes, messaging, moderation)

> **STATUS (updated 2026-08-06): APPLIED.** Migrations `social_00` through `social_09` are live on
> the Supabase project — this doc's original "not yet applied" header was stale. Phase 2 (public
> profiles, handles, follows) shipped; Phase 3 (posts/comments/likes) is partially built. Still NOT
> wired to cron: `backend/social_moderation_worker.py` (and it has a known bug — it signs objects
> out of Supabase Storage, but post-media bytes now live in GCS).
>
> The datastore decision recorded below ("social lives in Supabase Postgres") was **re-confirmed
> 2026-08-06** with real cost and scale numbers — see
> `docs/supabase-scale-plan-and-escape-hatch-2026-08-06.md`, which is the current source of truth
> for the Supabase posture, the MAU cost model, and the escape-hatch rules.

## Context

We want a social layer on the collection: users create **posts** (free-form text + photos), **comment**, react, **follow** each other, and **direct-message**. Goal = retention + acquisition (shareable, discoverable collector activity). This doc is the **database + access model + moderation** design and the decision record for *where the data lives*.

### Confirmed product decisions
- **Posts = free-form text + photo** (image uploads → Supabase Storage).
- **Public-by-default** accounts/posts; safety via **block + mute**. (Private/approval accounts = later.)
- **Moderation = automated pre-filter + human review + report/block**, built **without Supabase Edge Functions**, as cheaply as possible.
- **Image moderation model = OpenAI `omni-moderation-latest`** (free; text + images), run on the existing VM.
- **Datastore = Supabase Postgres** (see decision + analysis below).

## Decision: social lives in Supabase Postgres (RLS + Realtime + Storage), client-direct from RN — NOT the SQLite backend

Why (verified in exploration):
- The Python backend is a **hand-rolled `http.server` on a single VM with SQLite** — no framework, **no websocket/realtime**. Messaging/feed there = large greenfield build + a write-concurrency bottleneck. Its invariant is "SQLite-only runtime reads" for *card/pricing* data — social is a different domain.
- Supabase is **already a client-direct data backend** (`supabase.from('user_profiles')` in `apps/spotlight-rn/src/features/auth/auth-service.ts:187-258`) and natively gives **RLS, Realtime, and Storage** — all currently unused. Native path.
- Join key across both worlds is the **Supabase auth uid** (`owner_user_id` in SQLite == `user_id` in `user_profiles` == `auth.uid()`).
- `card_likes` is already framed in `backend/schema.sql:284` as a "public social signal" — the one existing precedent; the new graph supersedes it conceptually; leave it alone.

Consequence to accept: social content is the **first intentionally cross-user-readable data** in the product (everything else is private-by-owner). It carries its **own explicit visibility + block model** — it cannot inherit the implicit owner-only invariant.

### This is NOT a SQLite→Postgres migration — you already run both
Card/scan/pricing on **SQLite** (Python backend, VM); **auth + `user_profiles` on Supabase Postgres** (client-direct, in use today). Social is a "which existing store" question, answered by workload — **zero migration**:
- **Keep SQLite for card data.** Read-heavy, single-writer nightly syncs, one VM, index-tuned. Migrating a 27M-row pricing DB = big risky project, no payoff (and wouldn't fix past cold-cache disk-I/O issues).
- **Put social in Supabase Postgres** (already running for auth). Social = many concurrent small writes, realtime fan-out, cross-user public reads — where single-VM SQLite struggles and Postgres/Supabase shines. Adds **no new store**.
- **Cost of the split:** no SQL `JOIN` across SQLite collection ↔ Postgres social; compose via the backend API when a social surface needs collection data.
- **When to revisit SQLite→Postgres:** only if you outgrow the single VM and need multiple backend instances writing card data concurrently. Not now.

## Supabase vs. self-hosting Postgres on GCP (the analysis)

It's not "Supabase vs Postgres" — you're already committed to Supabase **Auth**, and ~80% of Supabase's value for social is the **auth↔DB integration** (`auth.uid()` in RLS, Realtime that respects RLS, the client API). Splitting the DB onto GCP means re-implementing that yourself, and **building Realtime** (the hardest piece).

- **Supabase (chosen):** managed Postgres + RLS + Realtime + PostgREST + Storage, tied to the auth you already use. ~$25/mo flat (free to start). ~zero ops. Data is **plain Postgres → no real lock-in** (`pg_dump` → Cloud SQL any day).
- **Cloud SQL on GCP:** co-located with the VM (low latency, no cross-cloud egress — Supabase runs on AWS), but you still **build Realtime + the auth integration + the API tier**. Cheaper raw compute is a mirage; the Realtime build dominates TCO at this stage.
- **Self-managed PG on GCE:** cheapest compute, you become the DBA (backups/patching/failover) — false economy for a small team.

**Verdict:** Supabase now. **Revisit Cloud SQL** only when: (1) you consolidate inventory into Postgres and cross-cloud VM↔DB latency/egress hurts; (2) Supabase usage bills exceed a self-run instance *and* you have ops bandwidth; (3) you need one GCP IAM/VPC/bill. At that point migrate the *whole* durable-user Postgres to Cloud SQL together, not two instances.

## Long-term target architecture (the right split)

Sort every dataset by one question: *can I rebuild it from vendors?* No → Postgres. Yes → keep local to the model.

| Dataset | Bucket | Home long-term |
|---|---|---|
| Auth, profiles | Durable user truth | Postgres (already) |
| Social (posts/comments/DMs/follows) | Durable user truth | Postgres (new) |
| **Inventory / scans / transactions / portfolio** | Durable user truth | **Postgres — migrate later (the upgrade worth doing)** |
| Card catalog, price snapshots + 27M-row history | Rebuildable cache | **VM-local (SQLite) — keep** |
| Visual embeddings / matcher index | Rebuildable cache | **VM-local — keep** |
| Scan image binaries | Private blobs | Object storage (GCS) — unchanged |

Catalog/pricing/index stays VM-local for a real reason (not tech debt): the hot scan path needs **zero network hops + CPU co-location with SigLIP2** (local ~0ms vs network PG 1–5ms/read), it's a **cache** (vendors are truth, rebuilt nightly), and keeping 27M rows off Supabase keeps Supabase small/cheap. The scanner's SQLite-VM is the single-point piece; the read-only-rebuildable design makes eventual scale-out (N stateless workers each with a copy of the cache) **easy**.

## Scaling ceiling on Supabase (what breaks first)
A single Supabase project scales to **hundreds of thousands → low millions** of social users before anything exotic. You'll hit design pressure points, each with a standard on-Supabase fix, in order: **(1) the feed query** (keyset pagination → fan-out/materialized feed), **(2) Realtime concurrent connections** (upgrade add-on to 10k+), **(3) `messages`/`notifications` growth** (partition by time + archive), **(4) image egress — the fastest-growing cost** (CDN + image resizing; same on any DB). 10k users is small — dozens–hundreds concurrent; both tiers handle it trivially.

## Data model

Postgres conventions: `uuid` PK `default gen_random_uuid()`, `timestamptz default now()`, `references auth.users(id)`, RLS on every table. **Identity extends the existing `user_profiles`** (not a new `profiles` table) — additive columns: `handle` (citext unique), `bio`, `status` (active|suspended|banned), `is_shadowbanned`, `follower_count`/`following_count`/`post_count`, `admin_enabled` (ensured), timestamps.

- **Graph:** `follows` (follower→followee), `blocks` (mutual invisibility), `mutes` (hide from my feed only).
- **Posts:** `posts` (body, optional `card_id` showcase link, `content_status` pending|visible|removed, `moderation_checked_at`, counters, `deleted_at` soft-delete), `post_media` (Supabase Storage `storage_path`, `moderation_status` pending|approved|rejected, blurhash), `comments` (1-level threading via `parent_comment_id`), `post_likes` / `comment_likes` (composite PK).
- **Messaging:** `conversations` (`dm_key` sorted-pair unique to dedupe 1:1, `last_message_at`), `conversation_participants` (`last_read_at` for unread), `messages`.
- **Notifications:** `notifications` (recipient, actor, type, target ids, `read_at`).
- **Moderation:** `blocked_terms` (hard|soft wordlist), `reports`, `moderation_actions` (audit).

## Access control — RLS

Enable RLS on every table. `SECURITY DEFINER` helpers centralize logic and avoid the messages↔participants recursion trap: **`is_admin()`**, **`is_blocked(a,b)`**, **`is_conversation_participant(conv,uid)`**.
- **posts/comments:** SELECT = `deleted_at is null AND (author = auth.uid() OR (content_status='visible' AND NOT is_blocked(...)) OR is_admin())`; INSERT = author is self; UPDATE/DELETE = author or admin.
- **post_media:** visible only when parent post is visible AND `moderation_status='approved'` (else owner/admin only) — **images hidden until approved**.
- **messages/conversations/participants:** gated by `is_conversation_participant`.
- **reports:** INSERT any authed user; SELECT/UPDATE admins only. **moderation_actions/blocked_terms:** admins only.
- **Realtime respects RLS** — subscribe to `messages`/`notifications` with the authed token so users only receive their own rows.

### Design principle — keep plpgsql/triggers THIN
Triggers only for **invariants that must hold no matter who writes** (client-direct = can't trust app code): denormalized counters, `updated_at`, and the unbypassable synchronous safety gate (wordlist + rate limit). Product logic (AI moderation, feed) stays in app code / the VM worker — deliberately NOT triggers.

## Moderation architecture — automated pre-filter + human, no Edge Functions, cheap

1. **Synchronous in-DB pre-filter (free, instant).** `BEFORE INSERT/UPDATE` plpgsql trigger on `posts`/`comments`/`messages` matches body against `blocked_terms` → `removed` (hard) or `pending` (soft); same trigger enforces a per-author **rate limit**. Pure SQL, no external call.
2. **Async AI pass on the EXISTING VM (free, no Edge Function) — `omni-moderation-latest`.** `backend/social_moderation_worker.py`: a cron polls Supabase via the **service-role key** (PostgREST, same pattern as `sync_user_emails_from_supabase()` at `backend/server.py:2302`) for `moderation_checked_at IS NULL` text and `post_media.moderation_status='pending'`, calls the free model (text **and** images), writes back verdicts. Seconds of delay; **images stay hidden (blurhash) until approved**; poster sees own immediately (owner RLS).
   - *Upgrade if leaky on images:* add **GCP Vision SafeSearch** in the same worker (native to your GCP VM).
   - **CSAM legal carve-out:** a general NSFW classifier is NOT sufficient for child-sexual-abuse material. Before public scale add **hash-matching** (free: Microsoft PhotoDNA, Cloudflare CSAM tool); US detection triggers a **mandatory NCMEC report**. Acknowledge the duty + fast takedown path the moment public image uploads are live.
3. **Community reporting + threshold auto-hide (free).** Report → `reports`; a trigger flips a target to `pending` once it crosses **K distinct reporters**.
4. **Human review queue (reuse `admin_enabled`).** Admins get a queue over `reports` + `pending`; actions write `moderation_actions` and soft-delete / suspend / ban / shadowban (RLS-enforced via `user_profiles.status`).
5. **User self-serve:** `blocks` + `mutes`, enforced in SELECT policies.

Lifecycle: **insert → trigger (instant) → [visible|pending|removed] → async AI (seconds) → [visible|removed] → reports/human (ongoing).** Text optimistic-visible after the trigger; **images pending-until-approved**.

## Repo hygiene fix (done as part of this)
Adopt Supabase CLI migrations. ALL social SQL is checked into `apps/spotlight-rn/supabase/migrations/`. The existing `user_profiles` RLS lives only in the dashboard today; its social-required RLS is in `apps/spotlight-rn/supabase/manual/user_profiles_rls_REVIEW_BEFORE_APPLY.sql` (touches the live auth table → applied consciously).

## Backend artifacts created (this pass)
- `apps/spotlight-rn/supabase/migrations/20260720090000_social_00_identity_helpers_graph.sql`
- `…/20260720090100_social_01_posts_comments_reactions.sql`
- `…/20260720090200_social_02_messaging.sql`
- `…/20260720090300_social_03_notifications.sql`
- `…/20260720090400_social_04_moderation.sql`
- `…/20260720090500_social_05_storage.sql`
- `apps/spotlight-rn/supabase/manual/user_profiles_rls_REVIEW_BEFORE_APPLY.sql`
- `apps/spotlight-rn/supabase/README.md` (apply + validate instructions)
- `backend/social_moderation_worker.py` (async AI pass; not yet wired to cron)

## RN client + surfaces (LATER — not this pass)
Reuse the `supabase` singleton + the `auth-service.ts` `.from()` pattern in a new `src/features/social/social-service.ts`; Realtime via `supabase.channel(...)`; media via `supabase.storage`. Screens: feed + DM inbox → `app/(tabs)/`; post detail / other-user profile / thread → `app/(stack)/social/…`; compose → `app/(modal)/`. Feed = followees + self, `content_status='visible'`, keyset-paginated; counters via triggers. Seed a public "Discover" feed so day-one isn't empty.

## Phasing
1. **(this pass) Backend:** migrations + RLS + moderation tables/triggers + Storage bucket + worker. 2. Apply to Supabase (branch/dev first, then project) + seed `blocked_terms` + deploy worker cron. 3. RN: profiles/handles + follows + feed. 4. Posts + media + comments + likes. 5. Messaging + Realtime. 6. Notifications + badges.

## Out of scope (v1)
Private/approval accounts, group DMs, mentions/hashtag search, quote-posts, edit history, trading (that's the marketplace), push delivery (in-app badge only).

## Verification (when applied)
- **Migrations:** `supabase db reset` (local or a preview branch) applies all files cleanly from scratch.
- **RLS:** two test users A/B — B can't read A's `pending`/`removed`/soft-deleted posts, can't read a conversation it isn't in, can't write as another uid; blocked users mutually invisible; admin sees the queue; verify `is_conversation_participant` doesn't recurse.
- **Moderation:** slur → trigger `removed` synchronously; borderline text + image → both queued, image hidden; run the worker → statuses resolve; exceed rate limit → rejected; K reports → auto-hide; admin action writes `moderation_actions` + flips `user_profiles.status`.
- **Realtime:** A DMs B → only B receives live; a like on A's post → live `notifications` row for A only.
- **Cost:** zero Edge Function usage; AI pass on the VM against free `omni-moderation-latest`; Storage/egress within free tier at launch volume.
