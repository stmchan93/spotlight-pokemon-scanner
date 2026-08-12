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

**Two follow-ups this left behind:**

- *Artifact loss*'s description still states the old formula
  (`upload_failed/(upload_succeeded+upload_failed)`). It is now failures against
  scans. Edit the text in PostHog.
- ~14 now-unused locals in `recent-captures-persistence.ts` (`startedAt`,
  `readMs`, `parseMs`, `bytes`, …) that only fed the removed events. Lint
  warnings, not errors. Sweep them with the work below.

## The question that matters most

2,435 successful scans → **26 adds**. Verified as real, not an instrumentation
gap: `scan_inventory_add_succeeded` fires from exactly one place
(`scanner-screen.tsx`), and the only other add events are `scan_add_all` (3),
`scan_add_all_collection` (2) and `card_detail_add_item_succeeded` (17 — PDP, not
scanning). Under 1% of successful scans become a card, and nothing currently
records what happened to the other 2,409.

Tier 1 exists to answer that. Everything else is secondary.

## Tier 1 — close the scan → add loop

| Event | Properties | Why |
|---|---|---|
| `scan_row_dismissed` | `reason: 'swipe' \| 'clear_all' \| 'cap_evicted'` | the missing half of the funnel |
| `scan_add_tapped` | — | separates "never tried" from "tried and failed" |

`scan_row_dismissed` **restores signal the prune removed**:
`scan_tray_evicted_for_cap` (297) and `scan_tray_cleared` (143) were classed as
plumbing and were not — a row evicted for cap means someone scanned past the tray
limit without adding anything. One event with a `reason` is cheaper than the two
that were deleted and is explicitly a product event.

`scan_add_tapped` matters because `scan_inventory_add_failed` sits at 0, which
either means adding never fails or means nobody reaches it. Today those are
indistinguishable.

Call sites: `src/features/scanner/screens/scanner-screen.tsx` (dismiss/clear/cap
paths, and the tray row's Add button).

## Tier 2 — the dark features

Each is near-zero volume precisely because nobody knows if it is used.

| Event | Properties | Call site |
|---|---|---|
| `catalog_search_performed` | `result_count` | `catalog-search-screen.tsx` |
| `catalog_search_result_opened` | — | `catalog-search-screen.tsx` |
| `comment_posted` | — | `comments-sheet.tsx` |
| `comment_failed` | `reason` (Postgres message, already carried by `AddCommentResult`) | `comments-sheet.tsx` |
| `post_created` | — | `new-post-screen.tsx` |
| `dm_message_sent` | — | `dm-thread-screen.tsx` |
| `wishlist_item_added` | — | wishlist add path (1 event in 14d — confirm it is real, not uninstrumented) |
| `share_sheet_opened` | `tab: 'collection' \| 'wishlist'` | `share-post-sheet.tsx` |

**Ship `catalog_search_performed` first.** It is the only way to settle whether
search is worth a price filter/sort, and zero-result queries are the cheapest
signal available about catalog coverage gaps.

## Tier 3 — Who's That Pokémon

Built, **not yet deployed** (the access gate blocked it), so these will not fire
until it ships. Instrument now so the first release is measured.

| Event | Properties |
|---|---|
| `whos_that_started` | — |
| `whos_that_completed` | `matched: boolean`, `pokemon` (the revealed species) |
| `whos_that_shared` | — |

**PRIVACY — non-negotiable.** The input is a selfie. Never attach the image, a
file URI, a hash of it, or any derived facial/demographic attribute to any
event. Selfies are never persisted (that is a product guarantee, not an
implementation detail) and the telemetry must not become the exception that
quietly retains something about them. The revealed species is a game outcome and
is fine; anything describing the *person* is not.

## Tier 4 — activation

Mostly derivable from `$identify` + `auth_sign_in_succeeded` +
`scan_capture_started`. The one real gap is guest → account conversion, which
matters because anonymous sign-in mints a billable MAU
(`auth_anonymous_identity_minted` exists but fired once).

## Expected outcome

~1,000–1,500 events/fortnight added at current usage → **~13,000 total**, still
less than half the 28,000 starting point, while answering questions that are
currently unanswerable.

## Explicitly NOT instrumented

Navigation beyond `$screen`; anything in the scan-tray persistence layer; success
twins of high-frequency writes. If one of these is ever needed, it is for a
specific question — add it then, with the question written down.
