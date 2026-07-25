# Portfolio Social — Phase 3: Activity feed, Posts, Comments

Date: 2026-07-24
Status: PLANNED — decisions flagged below need confirming before the build.
Predecessors: Phase 2 (2a+2b+2c) shipped and verified on staging; Option C (avatars→GCS) live.
Builds on [[project_social_layer]] and [[project_portfolio_profile_phases]].

---

## In plain English

Phase 2 made people findable and followable. Phase 3 gives them something to *do*: post a
card-or-text update with a photo, see a feed of activity, and comment/like. Everything hangs off tables
that already exist and are live — `posts`, `post_media`, `comments`, `post_likes`, `comment_likes`,
`notifications` — so this is mostly mobile UI + a couple of backend seams, not new schema.

The one genuinely new infra piece is **post images**. Avatars were easy (public, one per user). Post
photos are different: they're user-generated at volume and must stay hidden until moderation approves
them. That interacts with both the Supabase-exit direction (serve images from GCS, not Supabase
Storage) and your org's Public-Access-Prevention posture. It's the main thing to get right here.

---

## What already exists (live on Supabase)

| Table | Shape (live columns) | Ready? |
|---|---|---|
| `posts` | id, author_id, body, card_id, content_status, moderation_checked_at, like_count, comment_count, created_at, updated_at, deleted_at | ✅ + author post_count trigger (SECURITY DEFINER as of social_07) |
| `post_media` | id, post_id, storage_path, width, height, blurhash, moderation_status, position, created_at | ✅ RLS gates on `moderation_status='approved'` |
| `comments` | id, post_id, author_id, parent_comment_id, body, content_status, moderation_checked_at, like_count, created_at, updated_at, deleted_at | ✅ threaded (parent_comment_id) + post comment_count trigger |
| `post_likes` / `comment_likes` | (post\|comment)_id, user_id, created_at | ✅ like-count triggers |
| `notifications` | id, recipient_id, actor_id, type, post_id, comment_id, conversation_id, read_at, created_at | ✅ |

Also present but **not wired**: `backend/social_moderation_worker.py` — the async OpenAI
`omni-moderation-latest` pass (text + images, free). Not on cron yet. Phase 3 is when it has to run.

---

## Decisions to confirm before building

1. **Feed scope — what does the Activity tab show?**
   - (a) **Following feed** (recommended): posts from people you follow, newest first. Needs a follow
     graph with content — which 2b just shipped. Empty for new users until they follow someone (mitigate
     with a "suggested collectors" strip reusing 2c search).
   - (b) **Global/discovery feed**: everyone's posts. Instantly populated, but a moderation and quality
     firehose from day one.
   - (c) **Card-anchored**: a post's `card_id` ties it to a card; the Activity tab on a *profile* shows
     that user's posts, and a card's PDP could show posts about it. Narrower, ships without a ranking
     algorithm.
   - Likely answer: start with (c) profile Activity tab + (a) a simple following feed; defer global.

2. **Post images: where and how served?** (the storage wrinkle)
   - post_media must be **private until approved**, so a public bucket like avatars won't do.
   - Options: (i) GCS private bucket + **backend-proxied reads** (`GET /api/v1/post-media/<id>` streams
     approved objects, 404s pending ones) — respects PAP, keeps the Supabase-exit direction, one seam to
     build; (ii) GCS + **signed URLs** minted after approval — but signed URLs expire, awkward to store;
     (iii) fall back to the Supabase `post-media` bucket from social_05 — works today but re-adds the
     Supabase Storage dependency we're trying to shed.
   - Recommended: (i) backend-proxied GCS, extending the `avatar_store.py` pattern, so both image types
     live on GCS and Supabase Storage stays unused.

3. **Moderation timing.** Images are `pending` on upload and hidden by RLS until the worker approves.
   That means a just-posted photo is invisible to the author for a beat. Acceptable? Or optimistically
   show the author their own pending image (RLS already lets an author see their own rows) while others
   wait for approval. Recommended: author sees own immediately; others after approval.

4. **Cron for the worker.** Where does `social_moderation_worker.py --loop` run — the existing VM as a
   systemd timer / cron, every 60–120s? (The VM already holds the service-role key.) This is the
   deploy-side task that makes images actually appear.

5. **CSAM.** Per the worker's own note and [[project_social_layer]]: omni-moderation does not cover
   CSAM. Before public image posting scales, add hash-matching (PhotoDNA / Cloudflare) + the NCMEC
   reporting path. Decide whether Phase 3 launches to a limited cohort first to defer this, or builds it
   in now.

---

## Build shape (once decisions land) — OTA-safe slices

**3a — Read the feed (no composing yet).**
- Data layer (client-direct Supabase): fetch posts (profile Activity tab first), hydrate authors via
  `public_profiles`, media via the chosen serving path, like/comment counts from the denormalized
  columns.
- Activity tab on the public + owner profile (currently the gated "Coming soon" state) renders real
  posts. Post card component: author row, body, optional card link, image, like/comment counts.
- Read-only. Ships behind the flag; composing and liking still gated.

**3b — Engage.** Like/unlike (optimistic, like the follow button), comment list + threaded replies
(Comments sheet), comment like. All client-direct under existing RLS; triggers keep counts.

**3c — Compose.** New Post composer (title/body, optional `card_id` picker reusing catalog search,
image pick → resize → upload to the chosen store as `pending`). Author sees their own post immediately.

**3d — Moderation live.** Wire `social_moderation_worker.py` to cron on the VM; verify a posted image
flips `pending → approved` and becomes visible to others; flagged text/image gets hidden.

**3e — Notifications.** Populate + render `notifications` (new follower, like, comment, reply). A bell
surface + unread count. Realtime is optional here (poll first; Supabase Realtime is a Phase-5 decision).

---

## Non-goals for Phase 3
- No DMs (Phase 5). No global ranked feed algorithm (defer). No Supabase Realtime commitment yet
  (poll; decide at Phase 5). No reposts/quote-posts. No rich text.

## Validation per slice
- typecheck + lint + jest green; new components tested. Flag off → OTA to staging → judge on device →
  flip on. Moderation slice (3d) verified against a real pending→approved image round-trip on staging.

## Critical files
- Live tables above (Supabase). Serving: extend `backend/avatar_store.py` → a `post_media_store` +
  `GET /api/v1/post-media/<id>` in `backend/server.py`. Worker: `backend/social_moderation_worker.py`.
- Mobile: new `src/features/social/` (feed, post card, composer, comments sheet); the Activity tab in
  `public-profile-screen.tsx` + `portfolio-screen.tsx`; data layer alongside `profile-service.ts`.
