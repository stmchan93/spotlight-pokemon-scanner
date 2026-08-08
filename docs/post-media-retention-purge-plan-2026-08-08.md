# Post media retention + purge

> **STATUS: PLANNED, not built.** Written 2026-08-08 alongside the soft-delete
> switch. Nothing purges anything today.

## Why this exists

Deleting a post is now a SOFT delete — `posts.deleted_at` is set, readers filter
it out, the row stays. That was chosen so a user can't erase evidence a moderator
is about to judge (`reports.target_id` has no FK by design), and so notifications
other people already read don't cascade away.

The images are a separate problem. They live in the Supabase Storage
`post-media` bucket; `post_media.storage_path` is the only pointer to them.
**Soft delete does not delete them — it keeps them deletable.** Under the
previous hard delete the `post_media` row cascaded away and the file became
unreachable garbage: still billed, impossible to find without scanning the whole
bucket.

So soft delete converts an unsolvable leak into a scheduled job. This is that
job.

## Scale, so nobody panics about the wrong thing

| | Size | 1,000 of them |
|---|---|---|
| Soft-deleted post/comment row | ~250-300 B | ~0.3 MB |
| Post image (1200px JPEG q0.8) | 200-400 KB | ~300 MB |

Rows are noise — you would need millions before it registered against Pro's 8 GB.
**Images are the entire cost**, roughly a thousandfold. Any conversation about
"deleted data piling up" is a conversation about the bucket.

## Retention: 30 days

Purge a deleted post's media 30 days after `deleted_at`.

The number is a moderation window, not a storage decision. Purge at 24h and the
moderation hole is back — post something bad, delete it, and the image is gone
before a human looks. 30 days matches a normal report-review window and costs
almost nothing: a hundred deleted posts a month is ~30 MB in flight at any time.

## Three distinct classes of garbage

Only the first is created by deletion. The other two exist today and are worth
handling in the same job.

1. **Media of soft-deleted posts.** `posts.deleted_at < now() - 30 days`. The
   main case; findable, safe, well-defined.
2. **Never-attached uploads.** `post_media` already carries
   `idx_post_media_pending on (created_at) where moderation_status = 'pending'`
   — that index exists to find rows uploaded but never bound to a published post
   (someone picks a photo, upload succeeds, they abandon the composer). **This
   leaks today, independent of delete semantics**, and has been leaking since the
   composer shipped.
3. **Files orphaned by past HARD deletes.** Anything deleted before 2026-08-08
   has no row pointing at it. Reclaiming these needs a one-time reconciliation:
   list the bucket, diff against `post_media.storage_path`, delete what nothing
   references. **Highest risk in this document** — a bug here deletes live
   users' photos. Dry-run, eyeball the diff, then run once.

## Where it runs

`backend/deploy_to_vm.sh` already manages a cron block on the staging/prod VMs —
it is where the social moderation worker was wired to run every two minutes. A
daily entry goes alongside it. `backend/post_media_store.py` already owns bucket
access, so the job should use it rather than talking to Storage directly.

Needs the service-role key, which the moderation worker already loads the same
way (`run_social_moderation_vm.sh` sources runtime config → runtime env →
secrets, and exits 0 with a log line when its key is absent — copy that
posture exactly, so a missing key is a no-op rather than a crash-loop).

## Order of operations (this order, deliberately)

1. Select candidate `post_media` rows.
2. Delete the storage objects.
3. Delete the `post_media` rows.

Object first, row second. If it fails between them, the row still points at a
missing object — the next run retries and the app degrades to a broken image.
Reverse the order and a failure strands the file forever with nothing pointing
at it, which is precisely the garbage this job exists to prevent.

## Non-negotiables for the implementation

- **Dry-run mode, default ON.** It logs what it would delete and deletes
  nothing. The first real run should be a human reading that output.
- **A cap per run.** A query bug that matches everything should delete at most N
  objects, not the bucket.
- **Never key off `content_status`.** The moderation worker overwrites it
  (`'deleted'` → `'removed'`). Every decision keys off `deleted_at`, which only
  the user's own delete sets. This is the same rule the counter triggers follow.
- **Log what was purged**, with post ids, so "where did my image go" is
  answerable.
- **Tests with a faked clock** — the 30-day boundary is the whole logic, and it
  is untestable if the job reads the wall clock directly.

## When to build it

**Not urgent by storage. Bounded by moderation, and that clock hasn't started.**

The first image only becomes purge-eligible 30 days after the first real user
deletes a post with a photo. Pre-launch, with a handful of testers, that is
nobody.

The forcing function is the **Aug 22 show**, which is when real users start
posting and deleting in volume. Working backwards:

- **Before Aug 22** — nothing required. The job could not do anything yet even
  if it existed.
- **By ~Sept 21** — the real deadline. Content deleted on launch day becomes
  purge-eligible 30 days later. Miss it and nothing breaks; the bucket just
  keeps growing until the job lands.
- **Class 2 (never-attached uploads) is leaking right now**, but slowly, and it
  is the same job — no reason to do it separately.

**Recommendation: build it in the first week of September**, after the show has
settled and before the Sept 21 window opens. That leaves roughly two weeks of
slack rather than a deadline to hit. It wants a focused session with the dry-run
and the faked-clock tests, not to be appended to a batch of UI fixes — this is
the only job in the system with delete authority over users' photos.

Do the class-3 reconciliation sweep separately and later, once the routine job
has been running uneventfully for a while.
