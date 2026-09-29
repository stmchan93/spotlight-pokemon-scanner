# TCGplayer-only cards: filling the Scrydex catalog gap (plan, 2026-09-29)

## Plain English

**What happened.** A user scanned a PSA-10 "Monkey.D.Luffy (Sealed Battle 2024 Vol. 2)" One Piece event Leader (TCGplayer 552137, printed number "P"). The scanner had no correct candidate because the card is not in our catalog: Scrydex doesn't list it, TCGplayer does.

**How big the gap is** (TCGCSV vs prod catalog, 2026-09-28; `scratchpad/tcgp_gap/`):

| Game | TCGplayer singles | Linked to our cards | Missing *versions* of cards we have | Missing *cards* |
|---|---|---|---|---|
| One Piece | 7,003 | 4,917 | 2,000 | 86 |
| Gundam | 1,726 | 1,336 | 258 | 132 |
| Lorcana | 3,239 | 3,171 | 39 | 29 |
| Riftbound | 1,486 | 1,177 | 279 | 30 |
| Pokémon EN | 28,633 | 27,236 | 828 | 569 |
| Pokémon JP | 30,342 | 23,488 | 974 | 5,880 (73% unpriced; mostly deck/box reprints) |

The gap is concentrated in exactly what vendors carry: every One Piece Release Event / Pre-Release / Anniversary Tournament group has zero links; high-value misses include Riftbound Metal Prize Wall promos ($1.3k–$4.4k), Lorcana promo foils (to $4.9k), Gundam Newtype Challenge promos (to $2.4k), Pokémon staff prereleases ($2.2k) and CoroCoro JP promos.

**What we have.** A daily TCGCSV crawl of all six categories that already sees every product; sealed products already live as TCGplayer-only `cards` rows priced by that crawl (`backend/sealed_products.py`); the raw main price is TCGCSV in both envs; the per-game incremental visual refresh embeds any new card row; alt-art version rows + the art-crop version rule (branch `scanner-altart`).

**What we need.**
1. A nightly step that sorts every unclaimed card-shaped TCGplayer product into **(a) a missing version** of a card we have (link it; it gets its own photo, price and scanner row) or **(b) a missing card** (create a TCGplayer-only card row).
2. Permanent ids for (b): `tcgplayer-<productId>` (Pokémon) / `<game>~tcgplayer-<productId>` (others). **Not** `tcgp-` — that prefix is Scrydex's TCG Pocket digital cards and carries a −0.06 scanner penalty and a search demotion.
3. Scrydex stays primary: TCGplayer only fills gaps, never overrides or duplicates a Scrydex card; when Scrydex later adds the card, the TCGplayer row is superseded (kept forever — 22 FKs cascade from `cards(id)` — and aliased to the Scrydex card).
4. Guards so TCGplayer-only ids never reach Scrydex (credits) and the app hides graded lanes for them.

## Phases (staging first; production needs explicit approval + `SPOTLIGHT_PROD_CONFIRM` per invocation)

| Phase | Scope | Effort |
|---|---|---|
| P0 Shadow audit | Classifier `backend/tcgplayer_only_catalog.py`, `tcgplayer_product_classifications` table, `TCGCSV_TCGPLAYER_ONLY_INGEST=shadow` (writes classifications + report, no card rows). JP-vintage guard, overrides file `backend/tcgplayer_only_overrides.json`. | 3–4 d |
| P1 Missing cards (b) | Id helpers, upsert path (sealed template), image probe/guard, collision-guard exclusion, Scrydex adapter + pricing guards, `catalogSource` payload field, visual refresh after the TCGCSV cron. | 4–5 d |
| P2 Scanner | Pokémon supertype mapping, manifest metadata, real-photo eval (the trigger Luffy etc.). | 2–3 d |
| P3 App | PDP gating (no graded lanes), source caption, redirect, search/rarity, null-safety. | 3–4 d |
| P4 Supersession | `card_supersessions`, detection, read-path alias, export mapping, holdings move. | 3–5 d |
| P5 Missing versions (a) | Link consumers (alt-art builder mapping, printings map, matched-variant chip/price); rebuild alt-art + art-crop. | 3–5 d |

## Decisions (user, 2026-09-29)

- **D1 Add new cards immediately** — no waiting period for brand-new sets; supersession cleans up if Scrydex adds them later.
- **D2 Include as much as possible** — no exclusions beyond sealed/non-card products and code cards (jumbo/oversized, World Championship Deck, art cards and DON!! are all included).
- **D3 Move holdings** — when Scrydex adds a card we carried as TCGplayer-only, repoint mutable ownership rows (deck_entries, card_favorites, watch_printings; merge quantities on collision; keep an audit table) to the Scrydex card in one transaction. Immutable history (scan events, confirmations, price history, posts) is never rewritten; the old id resolves via alias.
- **D4 Display TCGplayer images in the app on staging AND production** for TCGplayer-only cards (user's call; they believe TCGplayer permits it).
- **D5 Yes** — synthetic per-group sets so event groups are browsable (e.g. "Sealed Battle 2024").
- **D6 No caption** — just show the card and its image like any other card.
- **D7 Graded copies show "—"** (no graded data for TCGplayer-only cards).
- **D8 No admin UI / queue** — surface uncertain matches to the user as a visual review (photo-style page like the weekend review) rather than a manual overrides workflow; overrides file stays as the mechanism for applying fixes.

## Key file references (from the design pass)

- `backend/sync_tcgcsv_prices.py:553-560` hook point (after sealed ingest, before variant product ids); `_build_printings_map` `:253`; main-price selection `:114-143`.
- `backend/catalog_tools.py` `card_tcgplayer_products` rewrite on upsert `:3587-3605` (can't hold hand-added links → separate table); collision guard `:3544-3547,:3719`; `game_for_catalog_id` `:2286-2306`; search tcgp demotion `:4924-4926`.
- `backend/raw_visual_matcher.py:985-987` tcgp- penalty (TCG Pocket; b7cc95a7).
- `backend/server.py` graded refresh fallback to Scrydex `:16519`; `_visual_candidate_stub` `:15109-15120`; `card_detail` `:16828`.
- `backend/visual_index_incremental.py` `_base_indexed_ids` `:138-143` (TCGplayer-only base rows must NOT carry `referenceSource='tcgplayer'`).
- Latent bug: `sealed_card_id` (`backend/sealed_products.py:93`) lacks the game prefix for non-Pokémon sealed ids.
