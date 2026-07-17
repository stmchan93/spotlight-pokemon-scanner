# Set Completion Tracking — "My Sets" + missing-cards → Wishlist

> **STATUS: DEFERRED 2026-07-16** — fully specced and ready to pull forward when
> prioritized. Data model verified feasible; no blockers. Build when asked.
>
> **Product decisions already confirmed (do not re-ask):**
> - Scope = **"My Sets"** — only sets the user owns ≥1 card in (not the full catalog).
> - Missing-card action = **"add all missing to Wishlist"** (one tap).
> - Denominator = **`expansion.total`** (secret-rare-inclusive "complete set"), from
>   online research on how collectors track completion (Sources at bottom). Master
>   set / variant-level tracking is **out of scope for v1** (our card-id-granular
>   `deck_entries` can't express reverse-holo vs holo as separate slots).

## Context

Card-show scanning already fills a user's collection with cards, but the app never tells them **how close they are to finishing a set**. Collectors think in sets ("I have 47 of the 102 Base Set cards, here's what I'm missing"), and that framing turns a pile of scans into a goal with a next action. This feature adds a **"My Sets" completion view**: for every set the user owns ≥1 card in, show `owned / total` with a progress bar, list the **missing** cards, and offer a one-tap **"add all missing to my Wishlist."** A tappable completion row also lands on the card detail (PDP) so any card doubles as an entry point to its set.

### Denominator decision (research-backed)

Collectors use three tiers (see Sources): **complete set** = one of every *numbered* card **including secret rares** (numbered past the printed count); **master set** = every *variant* (reverse-holo + holo of the same number, alt-arts, promos) ≈ 2× the count; **printed set** = only the number printed on the card (undercounts, excludes secret rares).

- **v1 denominator = `expansion.total`** (secret-rare-inclusive "complete set"). This is the standard primary number in Pokéllector / TCG Collector, and it maps cleanly to our data.
- **Master set is explicitly out of scope for v1.** It needs *variant-level* ownership (reverse-holo vs holo of the same card number as separate slots), which our card-id-granular `deck_entries` cannot express. Note it as a future tier; do not fake it.

## Verified data facts (Explore agent, 2026-07-16)

- `cards` is a **full catalog** — `backend/sync_scrydex_catalog.py` paginates all `/pokemon/v1/cards` (no set filter) nightly and upserts every card via `upsert_catalog_card` (`backend/catalog_tools.py:2744`). So `SELECT * FROM cards WHERE set_id=?` returns every card in the set (incl. secret rares) once synced. JP goes through `/pokemon/v1/{lang}/cards` and only if that language sync ran.
- Denominators are nested in `cards.source_payload_json`: **`expansion.total`** and **`expansion.printed_total`** (both children of `expansion`; not promoted to columns). Card number is `cards.number`.
- Owned inventory = `deck_entries`, owner-scoped by **`deck_entries.owner_user_id`** (`backend/schema.sql:323`), card via **`deck_entries.card_id → cards.id`**; set via **`cards.set_id`** (indexed `idx_cards_set_id`). No existing per-set owned-count helper — new query, but fully supported by existing indexes.

## Backend

**New completion query — `backend/catalog_tools.py`** (near `list_local_expansions` @ 3779 / `get_cards_by_expansion` @ 3726):

1. `get_owned_set_completions(owner_user_id)` → the "My Sets" list. One SQL pass:
   `SELECT c.set_id, COUNT(DISTINCT c.id) AS owned FROM deck_entries d JOIN cards c ON d.card_id=c.id WHERE d.owner_user_id=? GROUP BY c.set_id`.
   Then per set_id, resolve `total` and display metadata (name, series, code, releaseDate, language, imageUrl) from a **representative card's** `source_payload_json.expansion` (one extra lookup per set; or reuse `list_local_expansions`' existing `GROUP BY set_id` catalog aggregate and join in Python). Also compute `catalogCount = COUNT(*) FROM cards WHERE set_id=?` so the client can detect a not-yet-fully-synced set (`catalogCount < total`). Return rows sorted by completion %/recently-updated.
2. `get_set_completion_detail(owner_user_id, set_id)` → the set drill-down. Enumerate all cards in the set (reuse `get_cards_by_expansion`, but **lift its ≤200 clamp** — modern sets exceed 200 with variants; enumerate the whole set), tag each with `owned` from the owner's `deck_entries`, split into owned/missing, and include the set's `total` + `printed_total`. Missing list = catalog cards in set minus owned; if `catalogCount < total`, surface an honest "N cards not yet in catalog" note rather than silently underlisting.

**New endpoints — `backend/server.py`** (beside `list_expansions` @ 9069 / routes @ 16737):
- `GET /api/v1/me/sets` → owned set completions (owner from the authed session, same owner-scoping as the inventory read path @ ~15140).
- `GET /api/v1/me/sets/{set_id}` → completion detail (owned + missing card lists).

These are **DB-only, zero Scrydex credits** (all from the synced `cards` + `deck_entries`) — consistent with the credit-discipline rule.

## API client — `packages/api-client/src/spotlight/`

- `types.ts`: add `SetCompletion` (`setId, name, series, code, releaseDate, language, imageUrl, owned, total, printedTotal, catalogCount`) and `SetCompletionDetail` (`…summary + owned: CatalogCard[], missing: CatalogCard[]`). Reuse the existing per-card shape returned by `listCardsInExpansion` (which already carries `ownedQuantity`).
- `repository.ts` (near `listExpansions`/`listCardsInExpansion` @ 5135): `listMySets()` and `getSetCompletion(setId)` calling the two new endpoints.

## Design system — new `ProgressBar` primitive

No progress bar/ring exists. Add `packages/design-system/src/components/progress-bar.tsx`: a horizontal track + fill driven by `value`/`max` (or `fraction`), theme-token colors (`green400` fill on a `gray*` track), optional inline `owned / total` label, rounded caps. Export from the package index; register a story in the design catalog (`design-system-catalog-screen.tsx`). Reuse existing `SurfaceCard`, `RollingNumberText`, `StateCard` for the surrounding rows.

## Frontend — `apps/spotlight-rn/`

Reuse the existing expansion-browser scaffolding rather than build new list plumbing:

- **My Sets screen** (`src/features/catalog/` — mirror `expansion-browser-screen.tsx`): FlatList of `SetCompletion` rows, each = set art + name + `ProgressBar` + `owned/total`. Fill the empty slot already stubbed in `components/expansion-cell.tsx` (lines ~55-62) for the completion row. Owner-scoped via `useAppServices()` (`inventoryEntriesCache` pattern) so it never leaks across accounts. Empty state (no owned sets) via `StateCard`.
- **Set completion detail** (mirror `expansion-detail-screen.tsx`): header with the big progress bar + `owned/total` (+ small "printed total N" secondary), then **Owned** and **Missing** sections. Missing cards reuse the existing catalog card cell; each tappable to its PDP.
- **"Add all missing to Wishlist"** button in the detail header → loop the missing list through the existing favorite/wishlist mutation (`setCardFavorite` / `card_favorites`; user-facing copy says "Wishlist", internal ids stay `favorite`). Confirm-count toast on success; guests hit the existing gate-to-login modal.
- **PDP set-context row** (`src/features/cards/screens/card-detail-screen.tsx` near the `identityNumberSetLine` @ 879-889): a tappable "47 / 102 · Base Set" row with a slim `ProgressBar` that deep-links to the set completion detail. Loads lazily from `getSetCompletion(setId)`; hidden if the card has no `set_id` or the set isn't resolvable.

### EN / JP

EN and JP are **separate set entities** (`base1` vs `base1_ja`) and stay separate rows — never merged (JP completion is a distinct goal, and JP only appears when the JP language sync has populated those `cards`). The `language` field on each `SetCompletion` distinguishes them in the UI.

### Reachability / entry points

Add "My Sets" to the Collection surface (a filter/entry near the existing chips in `portfolio-screen.tsx`) or the drawer — a single entry that pushes the My Sets screen. (Confirm placement during build; low-risk either way.)

## Out of scope (v1)

- **Master set / variant-level completion** (reverse-holo vs holo as separate slots) — needs variant-granular ownership; note as a future tier.
- Grand master set (promos/errors/print runs).
- Sets the user owns **0** of (scope = "My Sets" only, per decision).

## Verification

- Backend: unit-test `get_owned_set_completions` / `get_set_completion_detail` against a seeded `deck_entries` + `cards` fixture — assert `owned` = distinct owned, `total` = `expansion.total`, missing = set − owned, and that a >200-card set enumerates fully (cap lifted). Confirm zero Scrydex calls.
- API contract: `GET /api/v1/me/sets` and `/me/sets/{id}` return owner-scoped data; verify a second account sees only its own sets (cross-account-leak guard).
- RN: component tests for the My Sets screen (progress rows), the detail screen (owned/missing split + add-all-missing), the new `ProgressBar` primitive, and the PDP set row. Guest tap → login modal.
- Manual: scan/own a partial set on staging → My Sets shows correct `X/Y` + bar; open detail → missing list correct; "add all missing" populates Wishlist; PDP row deep-links to the set; a JP set shows as its own row.
- Ship via staging deploy gate (`pnpm backend:deploy:staging` + `pnpm frontend:update:staging`); prod stays gated.

## Sources (denominator research)

- [Cardrake — Pokémon Master Set Guide](https://www.cardrake.com/guides/master-set)
- [Ravaver — What Is a Pokémon Master Set? (2026)](https://ravaver.com/blogs/article/what-is-a-pokemon-master-set-a-complete-guide-for-beginner-collectors)
- [TCGMart London — Master Sets vs. Grand Master Sets](https://www.tcgmartlondon.com/articles/master-sets-vs-grand-master-sets/)
- [Bleeding Cool — Collecting Complete & Master Sets of Pokémon TCG](https://bleedingcool.com/games/collecting-complete-master-sets-of-pokemon-tcg/)
- Tracker precedents: [MasterSet.gg](https://masterset.gg/), [PokeTrack.io](https://www.poketrack.io/)
