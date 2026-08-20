# Spike: One Piece TCG alongside Pokémon

## Context

The app is Pokémon-only end to end — catalog, pricing, scanner, collections. The
question is what it would actually cost to add One Piece as a second game, using
Scrydex for pricing, covering not just scanning but search, adding to a
collection, correct display, graded pricing and pop reports.

This is a **research spike**: the deliverable is this estimate, not code.

**All of it stays on a side branch in its own worktree** so it can never reach a
release and never disturbs the main tree, where day-to-day work and other agents
continue uninterrupted.

**Verdict: technically feasible and cheap — ~4-6 evenings without the scanner,
8-11 with it — but the product is weaker than expected.** The build is small
because the expensive layers (card display, the embedding pipeline, the pricing
seam) are already game-neutral; the new work is a `game` column, a second visual
index and a rarity map.

**The catch, found by running Phase 0 against the live API: Scrydex has no graded
pricing and no pop reports for One Piece.** Raw prices only. Both of those asks
fail on data availability, not on our code. The real question is therefore not
"can we build it" but "is a raw-only One Piece worth having" — answer that first.

## Working setup: an isolated worktree

Everything below happens in a **long-lived sibling worktree**, the same pattern
already used for `/Users/stephenchan/Code/spotlight-payments-mvp`
(`feat/payments-mvp-foundation`) — NOT the ephemeral `.claude/worktrees/agent-*`
ones, which are session-scoped and get cleaned up.

```
git worktree add ../spotlight-onepiece -b feat/one-piece-tcg
```

`/Users/stephenchan/Code/spotlight` keeps `main` checked out and untouched, so
other agents and normal work continue there with no interference.

**Fresh-worktree setup cost (one-off, ~20-30 min mostly waiting).** A worktree
shares git history but NOT gitignored artifacts, so it starts without:

| Missing | Needed for | How |
|---|---|---|
| `node_modules/` | any RN work or `jest` | `pnpm install` at the worktree root |
| `backend/.venv` | `run_all_tests.sh` | recreate, or point `PYTHON_BIN_OVERRIDE` at the main tree's venv |
| `backend/.env` | **the backend suite** — 3 pricing tests fail without it | `ln -sf ~/Code/spotlight/backend/.env backend/.env` (symlink, don't copy the secret) |
| `backend/data/*.sqlite` | running the backend, syncing One Piece | copy a catalog snapshot from the main tree |
| `backend/data/visual-index/`, `visual-models/` | Phase 2 only | copy or symlink from the main tree — several GB, do NOT duplicate blindly |

**Hard rule for this branch: no deploys, no OTA.** Never run
`backend:deploy:staging`, `frontend:*:staging`, or any EAS command from this
worktree — staging carries real users and this branch is explicitly not for
release. Local verification only until you decide it's worth merging.

## What I verified

**Scrydex covers One Piece properly.** `/onepiece/v1/cards`, `/expansions`,
`/price-history` — the same resource shape we already consume, just a different
path prefix ([cards docs](https://scrydex.com/docs/onepiece/cards),
[price history](https://scrydex.com/docs/onepiece/price-history)).

**CORRECTION — graded pricing and pop reports do not exist for One Piece.**
An earlier draft of this doc claimed, from the API docs alone, that One Piece
carried the same graded model as Pokémon. Phase 0 was run against the live API on
2026-08-13 and that is **wrong**. See "Phase 0 results" below. The price *schema*
is identical; the *data* is raw-only.

**Scale:** ~5-6k One Piece cards including variants, against 46,461 Pokémon in
our catalog — about an eighth the size. Sync cost is ~1 credit per 100-card page
(`sync_scrydex_catalog.py` meters `estimated_credits_used = pagesFetched`), so a
full One Piece catalog pull is **~50-60 credits**. Negligible.

## Phase 0 results (run 2026-08-13, ~7 credits)

`tools/probe_scrydex_onepiece.py`, against the live API with our real key.

**✅ Our plan tier serves One Piece.** `/onepiece/v1/expansions` returns **53
expansions** — OP01 through OP16, the ST starter decks, the EB sets. No 403, no
gating.

**✅ Raw pricing is complete and good.** Every card sampled (50 across two sets)
had prices: `condition` NM/LP/DM, `market`, `low`, `currency`, plus 1/7/14/30-day
`trends` — richer than I expected, and the same shape the Pokémon lane consumes.

**❌ Graded pricing: none.** Not "sometimes" — none at all:

| Probe | Graded rows |
|---|---|
| OP16 (newest set), 20 cards | 0 |
| OP01 (oldest set, 2022), 30 cards | 0 |
| `OP01-001` single-card detail, `include=prices` | `type` is `raw` only |
| `OP01-001/price_history?company=PSA&grade=10&days=90` | 0 points |

The `grade`, `company`, `is_perfect`, `is_signed` and `is_error` fields are all
*present* on every price object and uniformly null. So the schema is identical to
Pokémon and our resolver would understand graded data the day it appears — there
just isn't any.

**❌ Pop reports: none.** Each variant carries a `pop_reports` key, which is `[]`
on every variant sampled — including OP01 alt-arts, where PSA-graded copies
demonstrably exist in the real world.

**What this means.** Both halves of the "pop reports + PSA pricing" ask fail on
**data availability, not on our code**. One Piece would be a **raw-pricing-only**
game in the app. That's the single most important thing to decide on before
spending an evening: is One Piece worth having without graded prices or pop?

**One unknown left.** The empty responses came back `200`, not `403`, which reads
like "no data" rather than "not on your plan" — but some APIs return empty rather
than forbidden for ungated tiers. Worth one email to Scrydex asking whether
One Piece graded/pop is a higher tier before writing the feature off.

## What already works unchanged

- **Card display.** The client card model (`packages/api-client/src/spotlight/types.ts`)
  is name / setName / cardNumber / rarity / images / prices. Zero `pokedex`,
  `supertype` or `regulationMark` references anywhere in `apps/spotlight-rn/src`
  outside the Who's That Pokémon feature. PDP, collection grid and search UI need
  no structural change.
- **The embedding pipeline.** `tools/build_raw_visual_index.py` takes card id +
  reference image and emits a SigLIP2 embedding. Nothing in it is Pokémon-aware.
- **Pricing provider seam.** `backend/pricing_provider.py` already has a
  `PricingProviderRegistry` with Scrydex and PriceCharting registered.
- **Collections.** Mixed-game collections need no schema change — a holding is a
  `card_id`, and totals just add up.
- **Partial game-awareness.** `fetch_scrydex_expansions(game=...)` and
  `sync_scrydex_expansions(game=...)` already take the parameter.

## What has to change

### 1. `game` column — the keystone (~1 evening)

Nothing anywhere records which game a card belongs to; Pokémon is implicit. Add
`cards.game TEXT NOT NULL DEFAULT 'pokemon'` (the existing
`_sqlite_add_column_if_missing` pattern in `backend/catalog_tools.py`), backfill
lazily, and thread it through card payloads, catalog search filtering, and visual
index selection.

> **This paragraph originally claimed card ids were already namespaced
> (`base1-4` vs `OP13-118`) and so carried no collision risk. That is FALSE** —
> One Piece and Gundam collide on 211 ids. See "BLOCKER found while building the
> test harness" below. The assumption survived this long because each game was
> synced into its own database, which hid it.

### 2. Adapter parameterization (~0.5 evening)

`backend/scrydex_adapter.py` hardcodes `/pokemon/v1/` in **13 places**. Replace
with the game segment. Mechanical, but touches the highest-traffic file in the
pricing path, so it wants care and test coverage rather than a blind
find-and-replace.

### 3. Rarity buckets (~0.5 evening)

`RARITY_BUCKET_KEYS` / `_RARITY_BUCKETS` in `catalog_tools.py:1644` is a
hand-built Pokémon rarity map (`sir`, `illustration`, `secret`, `shiny`…). One
Piece has its own ladder (C, UC, R, SR, SEC, L, P, Manga rare, alt-art). Needs a
parallel map keyed by game — the bucket *keys* are Pokémon-flavoured too, so
either add One Piece keys or make buckets per-game.

### 4. Catalog + price sync (~1-2 evenings)

Reuse `sync_scrydex_catalog.py` with the game parameter. One Piece fields that
have no home today: `cost`, `power`, `attribute`, `colors`, `rarity_code`. Park
them in `source_payload_json` for v1 rather than adding columns nobody reads yet.

### 5. Search + collection scoping (~1 evening)

Catalog search filtered by game; a game filter chip on the Collection tab
(alongside the existing All / Likes / A-Z chips in
`collection-filter-chip-row.tsx`). Mixed collections mean the "All Collection"
total spans both games — worth a per-game breakdown later, not in v1.

### 6. Scanner — the expensive half (~3-5 evenings + compute)

Separate index per game, selected by the existing lane toggle:

- **Index build.** ~5-6k cards to download and embed. Hours of compute, not
  effort; the tooling exists.
- **Matcher.** `raw_visual_matcher.py:195` loads ONE active index from a fixed
  path (`SPOTLIGHT_VISUAL_INDEX_NPZ_PATH`). Becomes a small registry keyed by
  game, picked from the scan's lane.
- **Lane UI.** `scanning-for-sheet.tsx` already has `pokemon_en` / `pokemon_jp`
  rows and a `ComingSoonRow` component — there is literally a slot for this. The
  `pokemon_en`/`pokemon_jp` strings appear in only **2 RN files**, so the
  plumbing is small.
- **OCR tiebreak.** Collector-number parsing is built for Pokémon formats. One
  Piece is `OP13-118`. Either add a parser or disable the OCR tiebreak on the One
  Piece lane for v1 (accepting lower top-1 on near-identical alt-arts).

Keeping the indexes separate is what protects the Pokémon top-1 number: a One
Piece card can never enter a Pokémon scan's candidate pool.

### 7. Graded pricing and pop reports — unavailable, not deferred

Two independent sources, both dry:

- **Population** comes from GemRate via PokemonPriceTracker
  (`backend/ppt_adapter.py`, `card_price_snapshots.population_json`) — Pokémon-only.
- **Scrydex** returns no graded prices and empty `pop_reports` for One Piece
  (Phase 0 above).

So a One Piece PDP shows raw prices by condition and nothing else. The graded
section and the population block have to be **hidden for non-Pokémon games**
rather than rendered empty — roughly half an evening, and the kind of thing that
looks broken if skipped.

## Risks worth pricing in

- **Scanner accuracy is unproven and unvalidatable.** The visual model was
  fine-tuned on Pokémon *show captures*; the gain was capture-domain (lighting,
  angle), which should transfer, but there is no One Piece show holdout to prove
  it. Expect to build one before trusting the numbers.
- **Alt-art density.** One Piece leans heavily on parallels/alt-arts that differ
  only in foiling — the same class the Pokémon matcher struggles with, and the
  OCR tiebreak that mitigates it doesn't exist for OP numbers yet.
- **Two pricing providers at once.** Pokémon prices are migrating to PPT while
  One Piece would sit on Scrydex. Two live providers, two sync cadences.
- **Current posture is a frozen mirror.** Health reports
  `activeRawPricingProvider: "none"`, `liveQueriesBlocked: true`, show mode
  active — the catalog and prices are deliberately frozen to conserve credits.
  Adding a game means deciding whether One Piece prices refresh live, which is a
  policy call, not a code one.

## Recommended phasing

1. **Phase 0 — prove the data (half evening).** One authenticated
   `/onepiece/v1/cards` call against a single expansion. Confirms the plan tier
   covers One Piece and that graded prices really come back populated. Everything
   below assumes this passes.
2. **Phase 1 — catalog + search + collect.** Items 1-5. One Piece cards become
   real: searchable, addable, priced (raw + graded), displayed.
3. **Phase 2 — scanner.** Item 6, behind the lane toggle.
4. **Phase 3 — pop reports.** Only once a One Piece population source is
   confirmed.

## Verification

All of it runs **inside `../spotlight-onepiece`**, never against staging:

- `bash backend/run_all_tests.sh` — extend `test_multi_collection.py`-style
  coverage with a game-scoped catalog fixture.
- New backend tests: One Piece rarity bucketing, game-scoped search, graded price
  resolution against a real Scrydex One Piece payload captured as a fixture.
- `cd apps/spotlight-rn && npx jest` — search returns One Piece results, a One
  Piece card adds to a collection, the PDP shows graded pricing and no empty
  population block.
- Scanner: replay harness against a One Piece holdout set (has to be built)
  before the lane is exposed; the Pokémon top-1 number must be unchanged, which
  the separate-index design should make true by construction.

## Measured results (2026-08-14)

The spike grew from One Piece alone to **four games** — Magic stayed out at 104,865
cards / 1,049 credits. Total one-time cost for the four: **81 credits**, 7,948
cards. Index builds cost nothing (`download_image()` is a plain CDN fetch), and
ongoing cost is zero unless prices are refreshed.

### Per-game visual indexes

| Game | Cards | Index size | Credits |
|---|---|---|---|
| One Piece | 2,633 | 7.5 MB | 27 |
| Lorcana | 3,181 | 9.1 MB | 32 |
| Riftbound | 1,187 | 3.4 MB | 12 |
| Gundam | 947 | 2.7 MB | 10 |
| **Total** | **7,948** | **22.7 MB** | **81** |

For scale, Pokémon's active index is 127 MB for 44,484 cards.

### Synthetic capture head-to-head (n=150/game, seed 20260814)

Same SigLIP2-384 backbone, same seed, byte-identical degradations per game.

| Game | Gallery | Clean | Realistic top-1 | Realistic top-5 | Worst single |
|---|---|---|---|---|---|
| Pokémon | 44,484 | 100.0% | 76.0% | 94.0% | defocus 90.0% |
| One Piece | 2,633 | 100.0% | 82.7% | 96.0% | crop 95.3% |
| Lorcana | 3,181 | 100.0% | 84.0% | 98.7% | crop 87.3% |
| Riftbound | 1,187 | 100.0% | 92.7% | 98.0% | crop 97.3% |
| Gundam | 947 | 100.0% | 92.7% | 98.0% | perspective 100.0% |

Every new game scores **above** Pokémon, and the ranking tracks corpus size. Read
it as a floor and a comparison, not an accuracy claim: the harness models no print
variation, sensor noise or real lighting, and query and reference derive from the
same image.

Two things keep the conclusion honest:

- At n=150 the Pokémon-vs-One-Piece gap (6.7pp) is roughly 1.5σ. The *five-point
  trend* carries the argument, not any single pair.
- The harness omits the user-photo rerank pool that production Pokémon scans get,
  so Pokémon's real number is **better** than 76%. That makes "the new games are
  not worse" safe, and "the new games are better" unsupported.

A real accuracy number still needs ~30-50 photographed cards per game through
`tools/eval_raw_visual_model.py --fixture-root`.

### The Pokémon lane provably did not move

"Unchanged by construction" was not accepted as evidence. There is no stored
baseline scorecard at the current active index, so the check was run as a genuine
before/after: the **main tree** still holds the pre-refactor matcher and the
worktree holds the per-game registry, so the identical eval ran from each — same
adapter, same index, same 116 fixtures, same device.

    visual top-1 52/71 (73.2%) · top-10 66/71 (93.0%) · hybrid top-1 61/71 (85.9%)

Identical in both, and the scorecards match on the **per-fixture `entries` array**,
not merely on the aggregates.

Re-run after the backend route audit landed, because that audit changed
`search_cards` and the `/scan/match` OCR fallback — the exact text signals
**hybrid** top-1 depends on, so the earlier result no longer covered the tree.
Identical again, entries included. Visual top-1 was never at risk; hybrid was, and
it held.

### THE REAL NUMBER: 88.6% top-1 on real English One Piece photos

Measured on **42 hand-verified photographs of real cards** sourced from listings
(`qa/onepiece-real-photos/`), scored against the shipped One Piece index with
`tools/eval_raw_visual_model.py`. Not synthetic, not publisher art — actual
photos with foil glare, off-axis angles, dark desks, a sleeve and a slab.

| slice | n | visual top-1 | visual top-10 |
|---|---|---|---|
| **English printings** | 35 | **88.6%** | **97.1%** |
| Japanese printings | 7 | 42.9% | 85.7% |
| all | 42 | 81.0% | 95.2% |

**For comparison, Pokémon's own holdout scores 73.2% visual top-1 / 93.0%
top-10.** One Piece on real photos is *better* than the shipped Pokémon lane —
which is what the original structural argument predicted (a 17× smaller corpus is
an easier retrieval problem), now demonstrated on real captures instead of the
synthetic harness that could not see past its own assumptions.

The Japanese row is not a model failure: **the index is English-only**, because
One Piece was synced without language paths. Pokémon solves this with separate
EN/JP lanes; One Piece would need a JP catalog sync to match. Until then, JP
cards are out of domain by construction.

By rarity, English only: Leader 5/5, Common 6/6, Uncommon 2/2, Rare 5/5, Super
Rare 5/6, **Secret Rare 8/11** — the alt-art and manga secrets are the hard class,
exactly as expected.

**What the 8 misses actually are:** 5 of 8 lost to *the same character in a
different printing* (Borsalino → another Borsalino, Rosinante → another
Rosinante, Luffy → another Luffy), and the true card was still inside the top 10
for 6 of the 8. That is the documented, accepted consequence of having no OCR
collector-number tiebreak: near-identical printings resolve to a near-tie and the
user picks from the tray — precisely how the Pokémon lane behaves today.

### CORRECTION (2026-08-14, later the same day): the watermark is NOT the blocker

The section below was written from a comparison that changed **two variables at
once**, and its conclusion is wrong. It compared a watermarked *art file* against
a *photograph* of a real card, and attributed the whole gap to the watermark.

Holding capture domain fixed settles it. Same index, same card:

| query | OP05-119 rank |
|---|---|
| TCGplayer **art**, watermarked | 1 (sim 0.8987) |
| de-watermarked **art** | 1 (sim **0.9254**) |
| real **photo** of the card | 30, then absent |

An unwatermarked image ranks first just as easily — slightly better. **The stamp
costs no rank.** What the failing case actually had in common was being a
*photograph*: angle, glare, holo shimmer, resolution, background. That is the
**capture-domain gap**, the same lever the show-scan work already identified, and
the fix is in-domain training data, not image cleaning.

A four-arm harness (`tools/eval_watermark_transform_arms.py`) confirms there is
no headroom: across 13 real query images, **every arm is 13/13 top-1, including
the untouched baseline**. Three further findings worth keeping:

- The stamp is near-**opaque** (oracle alpha peak 0.996), so un-blending cannot
  recover the art underneath — "strip the watermark" is dead on arrival.
- Stamping the *query* instead needs no index rebuild and buys ~+21% top-1
  margin, but changes **zero ranks**. Only worth anything if an absolute
  similarity threshold ever gates the pipeline.
- A mask estimator fitted from reference-image variance flags **clean** games
  (Lorcana 6.9%, Riftbound 7.1%) about as strongly as stamped ones. It must never
  be applied game-blind.

Everything below remains factually accurate about the watermark's *existence* and
which publishers stamp their art. Only the causal claim is retracted.

### The watermark itself (still true, no longer believed to be the blocker)

Found 2026-08-14 by scanning a real card — the first real card ever put through
this lane. It returned 30 candidates, **all** the right character
(Monkey.D.Luffy) and **none** of them the right printing. The true card
(OP05-119) is in the catalog and in the index, and still did not place.

The reason is visible the moment you open the reference image: Scrydex's One
Piece art is Bandai's official promo art with a large white **SAMPLE** stamped
across the middle. The physical card has no such thing. Every One Piece
embedding therefore encodes a mark that no real capture will ever contain.

It tracks the **publisher**, not the provider:

| game | publisher | reference art |
|---|---|---|
| One Piece | Bandai | **SAMPLE watermark** (median 0.22 near-white in the middle band, 91% of a 120-card sample) |
| Gundam | Bandai | **fainter SAMPLE watermark**, confirmed visually |
| Lorcana | Ravensburger | clean |
| Riftbound | Riot | clean |
| Pokémon | — | clean |

**No eval on this branch could have caught it, including mine.** The synthetic
capture harness derives its query from the same reference image, so the watermark
sits on both sides of the comparison and cancels perfectly. One Piece scored
82.7% and Gundam 92.7% top-1 under "realistic" degradation while being unusable
on a real card. That is a sharper version of the caveat already written here —
"a floor and a comparison, not an accuracy claim" — and it also means the
cross-game head-to-head compared a watermarked catalog against clean ones, which
is not apples-to-apples.

**What this does not affect:** everything non-visual. Search, catalog, pricing,
PDP, collections, marketplace links and set browsing all work on real data and
are unaffected. Lorcana and Riftbound have clean reference art and should scan on
their merits — that is also the cheapest confirmation of this diagnosis.

**Options, none taken yet:** find a clean image source for the two Bandai games;
remove the watermark before embedding (it is a consistent overlay, so this is
tractable); or ship those two games search-and-collection-only with the scanner
lane disabled. The registry already models "which game can do what", so the last
one is a capability flag rather than new machinery.

### Backend route audit — six routes were silently Pokémon-assuming

Auditing every route that reads `cards` found more leaks than the design
predicted. The per-game visual index was being undone one layer below by
unscoped text search:

| Route | Was | Now |
|---|---|---|
| `GET /cards/search` | entirely game-blind | scoped |
| `GET /expansions/{id}/cards` | `set_id` is only unique *within* a game | scoped |
| `/scan/match` OCR fallback | text search ignored the scan's lane | scoped |
| Rarity bucket filter/browse | bucketed every label with Pokémon's table | per-game table |
| `/cards/{id}/recent-sales` | always `/pokemon/v1/…` | per-game + capability gate |
| `/cards/{id}/market-history` | hardcoded `/pokemon/v1/…/price_history` | per-game |

`game` is now a **required keyword** on `search_cards`, `search_cards_local`, the
raw OCR helpers and `get_cards_by_expansion` — nothing defaults, and
`normalize_game` runs only at the HTTP boundary. `game_for_scan_payload` is the
single payload→game reader, so the visual index and the OCR fallback cannot drift
onto different catalogs.

**The performance trap.** A naive `AND game = ?` flips SQLite from
`idx_cards_name_set_number` onto `idx_cards_game` — which, in a catalog where
every row is `pokemon`, selects the entire table on every keystroke. The main
search therefore filters in Python where rows materialise, and paths that page in
SQL use `+game = ?` to suppress index selection. Query plans are pinned by tests.
Measured on the real 43,991-card catalog, same queries, both trees:

    before (main tree)  median 78.4 ms · total 958.2 ms
    after  (worktree)   median 75.8 ms · total 904.1 ms

No regression.

**Lorcana has listings after all.** `GET /lorcana/v1/cards/AOTV-224/listings`
returned a real eBay sold row, so `has_listings` went `False` → `True`; it had
been set on a "no evidence" default rather than a measurement.

### The client was ignoring `game` entirely

The backend emitted `game` on card payloads and the client **dropped it** — no
`game` in `CardCandidateDTO`, `normalizeCardCandidate`, `mapDeckEntry`, the three
search mappers, favorites, or `CardDetailRecord`. Every capability check was
therefore answering "Pokémon" for a One Piece card, so the PDP would still have
offered PSA/BGS/CGC lanes into a permanently empty chart. All the capability
plumbing was real; nothing fed it. Now wired end to end, with `normalizeCardGame`
collapsing an unknown-to-this-build game to `undefined` rather than poisoning a
lookup.

Also added: `game` on the card-detail response (the only payload a **deep link**
can reach), a collection game filter that appears only when the collection spans
games, and game tags on search rows only when the results span games.

### BLOCKER found while building the test harness: card ids collide across games

The four games were synced into **four separate POC databases**, which was right
for building indexes and wrong for testing — the backend serves exactly one
database, so nothing could exercise two lanes at once. Merging them into one
catalog surfaced the problem the separate databases had been hiding:

    One Piece × Gundam    211 card ids collide      EB01-001, EB01-002, …
    One Piece × Gundam     11 expansion ids collide EB01, ST01, ST02, ST03, ST04

Both games ship an expansion literally called `EB01`, numbered from 001. So
`EB01-001` is *Kouzuki Oden* in One Piece and *Gundam Astray Red Frame Custom* in
Gundam. `cards.id` is `TEXT PRIMARY KEY` with no game component, so the merge
silently dropped 211 Gundam cards (947 → 736).

This **falsifies a line in the route audit**: card-detail-by-id and
`cards_by_ids` were classified "game-neutral-and-safe (id-keyed; ids are
namespaced)". They are not namespaced. Pokémon is unaffected (`base1-4`,
`sv3pt5-25`), so nothing shipped is at risk — but any two games can collide, and
this pair does.

**FIXED — non-Pokémon ids are namespaced at ingest**: `gundam~EB01-001`. Pokémon
ids are byte-identical, so the live catalog cannot move. A composite `(game, id)`
primary key was the alternative and was rejected as a far larger schema change
touching every collection row and foreign key.

**The separator is `~`, not `:`, for three measured reasons.** `backend/server.py`
is a hand-rolled `http.server` handler and only 4 of its 11 card/expansion-id
extraction sites call `unquote()` — `encodeURIComponent(':')` is `%3A`, so a colon
id would 404 on seven routes and work on four. `~` is RFC 3986 *unreserved* and
survives both `encodeURIComponent` and `quote()` verbatim. Reference images are
also cached as `{card_id}{suffix}` and the id recovered from `path.stem`; `:` is
illegal on Windows and the historical HFS separator. Finally `~` appears in zero
ids across all five catalogs, where `_` occurs in 20,566 Pokémon ids and `-` is
disqualified because set-code recovery splits on it.

Two real regressions the change introduced were caught by a before/after diff and
fixed: a `set_id >= ? AND set_id < ?` range made the game name a prefix of every
set id in that game (typing "gundam" pulled in the whole catalog), and a
`LIKE '%gundam%'` matched every Gundam set. The namespace also had to be stripped
out of scored search text, or `tokenize("gundam~GD01")` would make the game name
itself a searchable token.

Verified: all four games' ids pairwise disjoint, zero overlap with Pokémon's
43,991, and **1,443 real search queries per game before vs after → 0 result
differences**. All four indexes rebuilt from renamed cached images — embedding
only, zero downloads.

### Testing it end to end

    python tools/build_multigame_test_db.py --rebuild  # free, no Scrydex
    bash tools/start_multigame_test_backend.sh         # port 8788
    cp apps/spotlight-rn/.env.development.example apps/spotlight-rn/.env.development
    pnpm dev:mobile

The merged catalog, after the id fix:

| game | cards | expansions | priced |
|---|---|---|---|
| pokemon | 43,991 | 100 | 40,242 |
| lorcana | 3,181 | 22 | 3,170 |
| onepiece | 2,633 | 53 | 2,633 |
| riftbound | 1,187 | 5 | 1,179 |
| gundam | **947** | 23 | 945 |

Gundam is 947 again, not 736. The build script reports offered-vs-landed per game
precisely so a future id collision shows up as a number rather than as a game
quietly missing cards.

The script exists because two things are non-obvious: the merged catalog
(`backend/data/spotlight_multigame_test.sqlite`, built free from the local
Pokémon catalog plus the POC databases) and the **Pokémon visual index, which
lives in the main tree** — only the four new per-game indexes were built here, so
without the env overrides the Pokémon lane reports itself unavailable.

Verified live against that backend:

    /cards/search?q=luffy&game=onepiece   → Luffy & Ace, Luffy-Tarou, …
    /cards/search?q=mickey&game=lorcana   → Mickey Mouse, …
    /cards/search?q=charizard&game=pokemon→ unchanged
    /cards/search?q=charizard             → unchanged (no game param = Pokémon)

### Testing on a phone needs its OWN dev build

Scanning the Expo QR does **not** load this branch. Every worktree declares the
same `scheme` (`spotlight`) and `bundleIdentifier`
(`com.ekalight.app.staging`), so the deep link is handed to the **installed
TestFlight build**, which is a release binary: it ignores the bundle URL and runs
its own embedded JS against staging. The symptom is convincing and misleading —
the "coming soon" list shows One Piece, and searches for the new games return
nothing, because that is genuinely true of staging.

Confirm which bundle is really loaded before debugging anything else:

    lsof -iTCP:8081 -n -P | grep -v LISTEN   # Metro
    lsof -iTCP:8788 -n -P | grep -v LISTEN   # local backend

Zero connections means the phone is running an installed binary. So the branch
needs its own development build — `npx expo run:ios --device <udid>`, local and
free (`ios/` is gitignored). Expo Go is not an option: the app depends on
`react-native-vision-camera`, which Expo Go cannot load. A simulator build covers
everything except the camera.

**Fastest visual check that you are on the right bundle:** this branch's
"coming soon" list is Magic / Sports / Yu-Gi-Oh only. If it still lists One
Piece, Lorcana or Riftbound, you are looking at main.

### Manual test checklist

1. **Lane switch** — the scanner's "Scanning for" sheet offers Pokémon EN/JP plus
   One Piece, Lorcana, Riftbound, Gundam.
2. **Search follows the lane.** "luffy" in the One Piece lane finds cards; in the
   Pokémon lane it correctly finds nothing. Search is scoped to one game, and the
   app's active game currently rides on the scanner lane.
3. **The graded contrast** — the sharpest single check that capabilities drive the
   UI rather than a hardcoded game name. A **One Piece** PDP shows raw pricing and
   **no** PSA/BGS/CGC lanes, no empty population block. A **Lorcana** PDP **does**
   show graded lanes, across 8 graders.
4. **Set browse is scoped** — 53 One Piece sets, not 449 Pokémon ones.
5. **The id collision** — One Piece `EB01-001` is *Kouzuki Oden*; Gundam
   `EB01-001` is *Gundam Astray Red Frame Custom*. Both must exist.
6. **Marketplace links** — a One Piece card's TCGplayer link opens the right
   product (every One Piece card has a `tcgplayer_id`), and the eBay link finds
   real listings rather than searching "pokemon OP16 …".
7. **Pokémon is untouched** — graded lanes, population, both marketplace links,
   and search results exactly as before.

### Known gaps — these need a schema change

- ~~**`/expansions` mixes games.**~~ **FIXED.** `expansions.game` now exists —
  additive, `TEXT NOT NULL DEFAULT 'pokemon'`, so a live table backfills in
  place. The read, the count and the sync are all scoped per game, and
  `sync_scrydex_expansions` stamps every row it writes. Deliberately NOT indexed:
  measured on 449 rows, `idx_expansions_game` flips the listing onto a full
  re-sort, which is the one thing that could reorder Pokémon's list — the
  predicate is `+game` for the same reason it is on `cards`. Pokémon's response
  was verified byte-identical against the real 192-row merged catalog. The four
  POC databases were stamped without spending Scrydex credits via
  `tools/backfill_expansion_game.py`.
- ~~**`refresh_card_pricing` / `hydrate-pricing` are Pokémon-only.**~~ **FIXED.**
  `PricingProvider.refresh_raw_pricing` / `refresh_psa_pricing` now take a
  keyword-required `game: str` (no default — every caller had to be visited),
  and `ScrydexProvider` routes fetch-by-id through the game's segment.
  Covered by `test_multi_game_pricing_refresh.py`.
- **Product deep-links on collection rows and the scan price sheet** fall back to
  a keyword search: `_candidate_base_payload` carries no `sourcePayload`, so
  those rows have no TCGplayer product id. Only the card-detail endpoint does.

### Suite state

- backend gate **981 tests OK** (was 906 — three modules that the curated list in
  `run_all_tests.sh` had never run were breaking, and are now gated)
- all 115 backend modules **1,405 tests OK**
- RN **180 suites / 1,936 passed / 1 skipped**, `tsc` clean, eslint 0 errors

## Merging back

The branch stays unmerged until you've actually tested it. When it is worth
keeping, the `game` column and the adapter parameterization (items 1-2) are the
parts worth landing on `main` first — they're low-risk, and they make everything
else additive. The scanner lane should merge only once a One Piece holdout
confirms the Pokémon top-1 number is untouched.

If it turns out not to be worth it, `git worktree remove ../spotlight-onepiece`
and delete the branch — `main` never saw any of it.

## Deliberately out of scope

Pop reports, One Piece-specific card attributes as first-class columns
(cost/power/colors), per-game collection totals, deck-building, and any change to
the Pokémon lane's accuracy or pricing path.

---

## Update 2026-08-20 — product GO, the Japanese answer, and the road to a phone

### The product decision is made

The open question at the top of this doc — "is a raw-only One Piece worth
having?" — was answered **yes** on 2026-08-20: *"everything that CAN be scanned
should be scanned."* All four new games keep their scanner lanes, including
Gundam and Riftbound with no real-photo validation yet; that is now a recorded
product choice, not an oversight, so the `canScan` capability flag this doc
floated is deliberately NOT being added.

### Japanese: measured, and the answer is "not yet, and not our code"

*"If there is Japanese One Piece we should allow it."* There isn't — on our
catalog provider. `tools/probe_scrydex_game_languages.py` spent 13 requests
settling it for all four games at once, three shapes per game:

| probe | onepiece | lorcana | riftbound | gundam |
|---|---|---|---|---|
| `/{seg}/v1/ja/cards` (Pokémon-style sub-path) | empty 200 | empty 200 | empty 200 | empty 200 |
| `/{seg}/v1/cards?q=language_code:JA` | 0 rows | 0 rows | 0 rows | 0 rows |
| `/{seg}/v1/expansions?q=language_code:JA` | 0 rows | 0 rows | 0 rows | 0 rows |

The filter syntax itself was validated with an EN control on the same endpoint
(`q=language_code:EN` returns rows). So the POC syncs did not miss anything:
**Scrydex simply has no Japanese catalog for any non-Pokémon game today.** Same
empty-200 shape as the One Piece graded probes — consistent with either absence
or tier gating, which is one more line in the Scrydex email below.

What this means for the product:

- **No JP lane is possible** for these games until Scrydex ships JP data — there
  is no JP reference art to index. The lane config already refuses to offer a
  language toggle for games without `has_language_paths`, so nothing to build.
- **JP cards are allowed, not blocked.** One Piece EN/JP share set codes,
  collector numbers and artwork, so a JP capture in the (single) One Piece lane
  scores against EN references at the measured **42.9% top-1 / 85.7% top-10**.
  Degraded, not broken — and it improves the day a JP catalog exists, with no
  client change.
- Revisit trigger: Scrydex answering the email, or JP paths appearing on their
  changelog.

### Email to Scrydex (ready to send)

> Subject: One Piece graded pricing + Japanese catalogs — absent or tier-gated?
>
> Hi — we're building on the Scrydex API (team ID on this account) with Pokémon
> in production and One Piece / Lorcana / Riftbound / Gundam synced from your
> v1 endpoints. Two questions about empty-but-200 responses we're seeing:
>
> 1. **One Piece graded pricing & population**: `/onepiece/v1/cards` returns no
>    graded price contexts and empty `pop_reports` on every card we probed,
>    while `/lorcana/v1/cards` returns rich graded data (8 grading companies).
>    Is One Piece graded/pop data absent from the catalog, or gated to a higher
>    plan tier? If absent — is it on the roadmap?
>
> 2. **Japanese catalogs for non-Pokémon games**: `/onepiece/v1/ja/cards`,
>    `q=language_code:JA` card and expansion filters all return empty 200s for
>    onepiece, lorcana, riftbound and gundam. Are Japanese printings for these
>    games planned? One Piece JP in particular matters to our collectors.
>
> Thanks — happy to share exact request logs if useful.

### What changed today (2026-08-20)

- The idle-since-08-14 working tree (80 files) is **committed** — checkpoint
  `4088bb07`, 333 files.
- Lorcana `hasListingsData` drift fixed on the client (the probe's True finally
  propagated to `CARD_GAME_CAPABILITIES`), and `test_catalog_id_namespacing`
  joined the backend gate — the two consistency gaps this doc's review found.
- The `refresh_card_pricing` Known-gap above was already fixed in-tree; the
  bullet now says so.
- Phone-test environment verified end-to-end (see the runbook:
  `docs/multigame-phone-test-runbook-2026-08-20.md`). The smoke run found and
  fixed two real bugs:
  1. `tools/start_multigame_test_backend.sh` never set
     `SPOTLIGHT_VISUAL_MODEL_ID`, so the matcher booted in CLIP ViT-B/32 mode,
     looked for `*_clip-vit-base-patch32.npz` per-game artifacts that don't
     exist, and **every non-Pokémon lane reported itself unavailable** (plus a
     512-vs-768 adapter shape mismatch on the Pokémon prewarm). The phone-dev
     script always had the export; the backend-only script now does too.
  2. `_visual_candidate_stub` built scan candidates without a `game` key, so
     `_candidate_base_payload` defaulted **every scan candidate to pokemon** —
     a One Piece scan result would have rendered Pokémon-style grading lanes.
     Fixed by resolving the game from the namespaced id (cached row first);
     regression-tested in `test_scan_candidate_pool.py`
     (`VisualCandidateStubGameTests`).
- Verified-working smoke numbers, post-fix: One Piece real-photo top-1 match in
  247ms; Lorcana/Riftbound/Gundam reference self-match 0.998+; a One Piece
  query in the Pokémon lane leaks nothing (all candidates tilde-free).
