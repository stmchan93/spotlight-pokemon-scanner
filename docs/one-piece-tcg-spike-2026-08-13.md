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

**Verdict up front: feasible, and cheaper than it looks — roughly 4-6 evenings
without the scanner, 8-11 with it.** The reason is that the expensive layers
(pricing shape, card display, the embedding pipeline) turn out to be
game-neutral already. The genuinely new work is a `game` column, a second visual
index, and a rarity map. The one thing that does NOT come along is pop reports.

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

**Crucially, One Piece prices carry the same graded model as Pokémon**: each
price has `variant`, `condition` (NM/LP/MP/DM), `type` (`raw` | `graded`),
`company`, `grade`, `is_perfect`, `is_signed`, `is_error`. That means the graded
resolver, the per-printing graded logic, and the PDP dual-source handling carry
over as-is — including the signed/perfect leak class of bug we already fixed.
This is the single biggest reason the estimate is small.

**Scale:** ~5-6k One Piece cards including variants, against 46,461 Pokémon in
our catalog — about an eighth the size. Sync cost is ~1 credit per 100-card page
(`sync_scrydex_catalog.py` meters `estimated_credits_used = pagesFetched`), so a
full One Piece catalog pull is **~50-60 credits**. Negligible.

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
index selection. Card ids are already namespaced (`base1-4` vs `OP13-118`) so
there is no collision risk — the column is for filtering and routing, not
identity.

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

### 7. Pop reports — not in v1

Population comes from **GemRate via PokemonPriceTracker** (`backend/ppt_adapter.py`,
`card_price_snapshots.population_json`), which is Pokémon-only. Scrydex lists a
"Pop Reports" webhook topic for One Piece, but the card docs don't show
population on the object and I have not verified it's on our plan. One Piece PDPs
ship with raw + graded pricing and **no population**, labelled honestly.

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
