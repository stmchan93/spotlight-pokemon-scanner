# PostHog event plan — 2026-08-11

Source of truth for what the app captures and why. Written after measuring 14
days of real ingestion: **~28,000 events from 28 users**, of which 13,251 were
scan-tray persistence that answered no product question.

## Principles

1. **Ship an event only if you would act on it.** Alerting data (disk writes,
   sweeps, cache reads) is not analytics; it belongs in a log or nowhere.
2. **Properties, not new event names.** PostHog bills per event and breakdowns
   are free, so `share_sheet_opened { tab }` beats two events, and
   `scan_row_dismissed { reason }` beats three.
3. **Keep every `_failed` / `_error` twin.** They cost 0–4 events a fortnight
   and they are the only warning when something starts silently losing data.
4. **Names are `feature_action_outcome`, snake_case.** The saved dashboard
   queries by name; renaming breaks tiles.

## Done — pruned 2026-08-11 (commit `f70f238`)

Removed, ~15,700 events/fortnight (56%): `scan_tray_persist_write` (7,018 — it
fired ~2.9× per scan), `_copy`, `_delete`, `_read`, `scan_tray_orphan_sweep`,
`scan_artifact_upload_succeeded`, and `scan_match_requested` (pure duplication —
it and `scan_capture_started` both fired 2,464 times, same instant).

Three saved insights were repointed FIRST so no tile flatlines: both scan funnels
now enter on `scan_capture_started`; *Artifact loss* (`8CHCgRuZ`) takes its
denominator from it.

**Follow-ups this left behind:**

- ~~14 now-unused locals in `recent-captures-persistence.ts`~~ — **swept.** All
  14 are gone, along with `pendingChangeCount`, which turned out to be dead
  outright: it was written in three places and read in none once
  `scan_tray_persist_write` (its only consumer) was removed. The module now
  lints clean.
- **STILL OPEN:** *Artifact loss*'s description still states the old formula
  (`upload_failed/(upload_succeeded+upload_failed)`). It is now failures against
  scans. Edit the text in PostHog — this is the one item here that cannot be
  done from the repo.

## The question that matters most

2,435 successful scans → **26 adds**. Verified as real, not an instrumentation
gap: `scan_inventory_add_succeeded` fires from exactly one place
(`scanner-screen.tsx`), and the only other add events are `scan_add_all` (3),
`scan_add_all_collection` (2) and `card_detail_add_item_succeeded` (17 — PDP, not
scanning). Under 1% of successful scans become a card, and nothing currently
records what happened to the other 2,409.

Tier 1 exists to answer that. Everything else is secondary.

## Tier 1 — close the scan → add loop — SHIPPED

| Event | Properties | Why |
|---|---|---|
| `scan_row_dismissed` | `reason: 'swipe' \| 'clear_all' \| 'cap_evicted'`, `count`, `mode` | the missing half of the funnel |
| `scan_add_tapped` | `mode` | separates "never tried" from "tried and failed" |

`count` was added during implementation so a Clear All costs ONE event carrying
how many rows went, rather than one per row — a tray wiped at the 150 cap would
otherwise cost as much as the scans that filled it.

`scan_row_dismissed` **restores signal the prune removed**:
`scan_tray_evicted_for_cap` (297) and `scan_tray_cleared` (143) were classed as
plumbing and were not — a row evicted for cap means someone scanned past the tray
limit without adding anything. One event with a `reason` is cheaper than the two
that were deleted and is explicitly a product event.

`scan_add_tapped` matters because `scan_inventory_add_failed` sits at 0, which
either means adding never fails or means nobody reaches it. Today those are
indistinguishable.

Call sites: `src/features/scanner/screens/scanner-screen.tsx` — `deleteRecentCapture`
(swipe), `performClearAllCaptures` (clear_all), `applyCapEviction` (cap_evicted),
`handleAddToInventory` (add tapped).

**One implementation note worth keeping.** `applyCapEviction` runs *inside* a
`setRecentCaptures` updater, and React may invoke an updater more than once for
a single commit. The file deletion already in there tolerates that; an analytics
count does not. So cap-eviction reporting is deduped by capture id through a
module-level `Set`, and the other two report from the callback body, outside the
updater. Anything added to those paths later has the same hazard.

## Tier 2 — the dark features — SHIPPED

Each was near-zero volume precisely because nobody knew if it was used.

| Event | Properties | Call site |
|---|---|---|
| `catalog_search_performed` | `result_count`, `query_length`, `has_rarity_filter` | `catalog-search-screen.tsx` |
| `catalog_search_result_opened` | `result_count`, `has_rarity_filter` | `catalog-search-screen.tsx` |
| `comment_posted` | `is_reply` | `comments-sheet.tsx` |
| `comment_failed` | `reason` (Postgres message, truncated to 200), `is_reply` | `comments-sheet.tsx` |
| `post_created` | `has_image`, `body_length` | `new-post-screen.tsx` |
| `dm_message_sent` | — | `dm-thread-screen.tsx` |
| `dm_message_failed` | — | `dm-thread-screen.tsx` |
| `wishlist_item_added` | `source` | `card-detail-screen.tsx`, `portfolio-screen.tsx` |
| `wishlist_item_removed` | `source`, `count` | + `wishlist-screen.tsx` (swipe, bulk) |
| `share_sheet_opened` | `kind`, `tab` | `share-post-sheet.tsx` |
| `share_sheet_sent` | `kind`, `tab` | `share-post-sheet.tsx` |

Three deliberate departures from the plan as written:

- **`dm_message_failed` and `share_sheet_sent` are additions.** Principle 3
  requires the `_failed` twin, and a DM that never lands is indistinguishable
  from one nobody replied to. `share_sheet_opened` alone measures intent and
  never tells you whether sharing works.
- **The wishlist question is answered: it was uninstrumented, not unused.** The
  single event in 14 days was `scan_wishlist_added` from the scanner. The main
  path — the PDP heart — sent nothing at all, and neither did the Collection
  row menu or either removal path. All are now covered, and removals are
  tracked too, because wishlist churn is the interesting half.
- **The search query text does NOT travel**, and `catalog_search_performed`
  carries `query_length` instead. `cardname` is already on the observability
  redact list in `lib/observability/privacy.ts`; shipping the same string under
  a friendlier key would just route around a decision this codebase already
  made. **This changes what Tier 2 can answer:** the client event tells you how
  often search comes back empty — is search working, is it worth a price sort —
  but naming a specific catalog coverage gap needs the query, and that analysis
  belongs in backend search logs where the text already lives. The original plan
  claimed zero-result queries were the cheap signal for gaps; against this
  privacy posture, on the client, they are not.

## Tier 3 — Who's That Pokémon — SHIPPED (dormant)

Built, **not yet deployed** (the access gate blocked it), so these will not fire
until it ships. Instrumented now so the first release is measured.

| Event | Properties |
|---|---|
| `whos_that_started` | — |
| `whos_that_completed` | `matched: boolean`, `pokemon` (the revealed species), `duration_ms`, `match_count` |
| `whos_that_shared` | `pokemon`, `is_top_match` |

`whos_that_completed` is reported *after* the staleness guard, so a run someone
walked out on counts as neither completed nor failed: `started` minus the two is
the abandon rate, which is the number worth watching on an animation this long.
`duration_ms` is the real round trip, taken before the theater's artificial
minimum is added back. `is_top_match` on the share is the cheap read on model
quality — people promoting an alternate before sharing means the first answer
was not the good one.

**PRIVACY — non-negotiable.** The input is a selfie. Never attach the image, a
file URI, a hash of it, or any derived facial/demographic attribute to any
event. Selfies are never persisted (that is a product guarantee, not an
implementation detail) and the telemetry must not become the exception that
quietly retains something about them. The revealed species is a game outcome and
is fine; anything describing the *person* is not.

**This is now enforced by a test**, not just by this paragraph — see
`__tests__/components/whos-that-pokemon-screen-test.tsx`, "never puts the
selfie, its URI, or anything derived from the face into an event". It walks a
full capture → match → share and asserts against **every property of every
event the screen sends**, so an event added to that file later is covered the
day it is written. It checks two things: no value contains the image or its
file URI, and no *key* is one of the face-derived signals the screen holds —
`palette`, `headBox`, `personOutline`, `speciesOutline`. The second is the one
with teeth. All four are computed from the photo, and a dominant-colour palette
of a picture of a person carries more about them than it looks like it does.

## PDP comps — the eBay exits (added 2026-08-11)

The graded row's chevron and both comps panels. Most of this existed; the gaps
were the collapse, the per-row taps, and a mislabel.

| Event | Properties |
|---|---|
| `pdp_recent_sales_expanded` | `grader`, `grade`, `cache`, `listed_cache` |
| `pdp_comps_collapsed` | `grader`, `grade` |
| `pricing_link_opened` | `surface: pdp_recent_sales` / `_empty` / `_row`, and the `pdp_lowest_listed` trio |

**The mislabel.** "See more on eBay" renders under a populated panel as well as
an empty one, and both branches reported `..._empty` — so every exit from a full
panel was filed as "there was nothing here". Opposite meanings, same event. The
panels now pass `hasRows` and the screen picks the surface.

One chevron opens BOTH panels, so the expand keeps its name (the dashboard
queries it) and carries `listed_cache` alongside `cache` rather than splitting
into two events.

## Tier 4 — activation — SHIPPED (the guest funnel only)

Activation itself is derivable from `$identify` + `auth_sign_in_succeeded` +
`scan_capture_started` plus PostHog's app-lifecycle events, so no new events
there — instrumenting it again would pay twice for one answer.

The gap worth closing was **guest → account conversion**, and it is a billing
question rather than a curiosity: Supabase charges per Monthly Active User and
an anonymous user is a user, so every guest who is minted and never converts is
a line on the bill with nothing on the other side of it.

| Event | Properties | Where |
|---|---|---|
| `guest_mode_entered` | — | `enterPendingGuest` — free, no Supabase user exists yet |
| `auth_anonymous_identity_minted` | *(already existed)* | `signInAnonymously()` in auth-service |
| `guest_converted` | `had_minted_session`, `preserved_identity`, `provider` | `updateFromSession`, real-account branch |

`entered` − `minted` measures how well the deferred mint is working (people who
browsed and cost nothing). `minted` − `converted` is the leak.

**A correction to the earlier draft of this doc.** It said
`auth_anonymous_identity_minted` "exists but fired once", implying the mint side
was thin. The event is in fact fully built — `features/auth/anonymous-identity-churn.ts`
carries `is_churn`, `mint_count`, `mint_kind`, `previous_anonymous_user_id` and
keychain-fallback state — and it is hooked in **exactly one place** by design,
`signInAnonymously()`, the only function that mints. A provider-level mint event
was written during this work and then removed: it would have double-counted
every mint. There is a test asserting the provider stays silent; it now covers
the new name too. **Do not add a second mint hook.**

`preserved_identity` catches the specific expensive mistake: converting a guest
by creating a NEW user rather than upgrading the anonymous one bills the same
human twice. The shipped path is correct — a minted guest signing in with Google
goes through `linkOAuthIdentityToCurrentUser` and keeps its uuid — and a test
pins that. The property costs nothing while the path stays right and is the only
thing that would notice from outside if a future change swapped the link for a
fresh sign-up. **If that ratio ever reads below ~1.0, that is what broke.**

## Expected outcome

~1,000–1,500 events/fortnight added at current usage → **~13,000 total**, still
less than half the 28,000 starting point, while answering questions that were
previously unanswerable.

All four tiers are implemented. Check the real numbers a fortnight
after this reaches staging — in particular whether `scan_row_dismissed` with
`reason: 'cap_evicted'` is large, which would mean people are scanning past the
tray cap and adding nothing, and would make the tray itself the thing to fix
rather than the add button.

## Explicitly NOT instrumented

Navigation beyond `$screen`; anything in the scan-tray persistence layer; success
twins of high-frequency writes. If one of these is ever needed, it is for a
specific question — add it then, with the question written down.
