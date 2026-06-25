# PokemonPriceTracker (PPT) pricing migration — spec

**Date:** 2026-06-25 · **Status:** proposal / phased · **Owner:** Stephen

## TL;DR (plain English)

We're deciding whether to move card **pricing** from Scrydex to
PokemonPriceTracker (PPT) before launch. This spec lays out *why*, *what stays the
same*, and a **phased, reversible** path that proves the win with real data before
we flip anything users see.

Two things to be honest about up front, because they changed the case:

1. **Scrydex pricing is not "broken."** The Moonbreon scare (a PSA 10 showing
   $3,050 instead of ~$4,525) turned out to be **our** resolver picking an
   autographed-slab comp, not bad Scrydex data. That's now fixed + deployed
   (commits `9b4a3cf` + `6cc5159`). So the migration is **not** a rescue — it's an
   upgrade.
2. **The real case for PPT is structural, not "their numbers are better":**
   - **Cleaner data model.** PPT's graded sales are keyed purely by
     `{company}{grade}` (`psa9`, `psa10`, `bgs10`…) — there is *no* signed / perfect
     / variant sub-record. The class of bug we just fixed **cannot exist** in PPT's
     shape.
   - **A true "current price" field.** `smartMarketPrice` (14-day weighted, with a
     confidence label) tracks fast movers; a 3-month median lags a rallying card by
     30–40%.
   - **Volume + transparency.** 509 backing eBay solds for Moonbreon, with the
     individual `soldListings` (title, price, date, URL) we can show and audit.
   - **One provider** to operate pre-launch instead of two.

If, after Phase 1 (shadow comparison on real data), PPT does **not** clearly beat
Scrydex on coverage + accuracy, we keep Scrydex and walk away having spent only
safe, reversible work.

## Have vs. need

| | Scrydex (today, live) | PPT (target) |
|---|---|---|
| Raw / market price | ✅ TCGplayer market, daily sync | ✅ `variants[*].marketPrice` (TCGplayer) + Cardmarket EUR |
| Graded comps | ✅ per `{grader,grade,variant,flags}` (rich but leaky: signed/perfect sub-records) | ✅ per `{company}{grade}` (flat, no sub-records) + `smartMarketPrice` |
| Sold-listing detail | ❌ not exposed | ✅ `soldListings[]` (title/price/date/url/bestOffer) |
| Current-vs-median | ⚠️ one market number (daily snapshot) | ✅ median **and** 14-day weighted "current" w/ confidence |
| Identity crosswalk | card id is native (`swsh7-215`) | ✅ `externalCatalogId == swsh7-215` → deterministic join, no fuzzy match |
| Images | Scrydex/our hosted | `imageCdnUrl` 200/400/800 (tcgplayer-cdn) → **must rehost to GCS** |
| Coverage | EN + JP (Scrydex catalog) | TCGplayer-keyed (EN strong; **JP/SEA coverage = open question**) |
| eBay scraping | n/a (Scrydex does pricing) | **PPT scrapes eBay server-side** — we just pull their API (big ops win) |
| Visual index / identity states | unchanged | unchanged (migration does **not** touch the scanner) |

**Need, in one line:** a `PricingProvider` we can point at PPT, fed by a daily sync
that mirrors the Scrydex pipeline, with a comp-cleaning layer over `soldListings`,
images rehosted to GCS, behind a flag, proven by a shadow comparison first.

## Non-goals / invariants (do NOT touch)

- **The scanner is untouched.** Visual index (SigLIP2), `predicted/selected/
  confirmed_card_id`, raw-visual lane, slab cert-first lane — none of it depends on
  the pricing provider. This migration is pricing-read only.
- **No new runtime PSA-official-API dependency** (repo invariant).
- **No bundled runtime catalogs / startup-seeded JSON** (repo invariant). PPT data
  lands in the DB via the sync, same as Scrydex.
- **Backend stays the runtime source of truth** for persisted pricing snapshots.
- **AGENTS.md invariant change is explicit, not silent.** Today AGENTS.md says
  "raw identity/reference/pricing stays on the Scrydex-first lane" and "slab
  identity/pricing stays on the Scrydex lane." Cutting pricing to PPT **changes
  that policy.** That edit to AGENTS.md happens only at Phase 3 cutover, called out
  in the PR — not buried here.

## Cost & caching (decide before building — Scrydex-discipline applies)

Make PPT's per-view cost explicit the same way we do for Scrydex:

- **Never call PPT per PDP view.** Mirror the Scrydex model exactly: a **daily sync**
  pulls PPT into `card_price_snapshots` (+ decomposed `card_price_history_cell`),
  and every user-facing read is **free-from-DB**. PPT's payload already ships
  pre-scraped (`lastScrapedAt`, `scrapeCount`, `dataCompleteness`) — they do the
  eBay scraping; we cache their result.
- **Open question to pin down in Phase 0:** PPT API rate limits / plan limits /
  per-call cost, and whether the daily full-catalog pull fits one window (Scrydex
  is ~898 calls/run today). If PPT meters harder, we sync hot cards daily + long
  tail weekly.
- **Listings/marketplace deep-links** stay cached 24h as today.

## Phased plan (safe → reversible → irreversible last)

### Phase 0 — Provider abstraction + cost probe *(safe, no behavior change)*
- Define a `PricingProvider` protocol (raw market, graded contexts, sold comps,
  images, freshness) that **Scrydex already satisfies** — wrap the existing
  `scrydex_adapter.py` behind it so nothing changes at runtime.
- Probe PPT API: auth, rate limits, JP coverage, full-catalog pull feasibility.
- **Revertible:** pure refactor; delete the protocol and you're back.

### Phase 1 — PPT ingestion in **shadow mode** *(safe, reversible, this is the real eval)*
- Build `ppt_adapter.py` + a `sync_ppt_catalog.py` that pulls PPT and writes to a
  **parallel** table (`card_price_snapshots_ppt` or a `provider` column), joined by
  `externalCatalogId → cards.id`. **Do not serve it.**
- Emit a **shadow comparison report**: for every card we have both, diff raw +
  per-grade (PPT median, PPT current, Scrydex) and flag deltas > X%. This is the
  honest, non-circular eval gate — on the real catalog, not cherry-picked cards.
- **Decision gate:** PPT must clearly win on coverage (esp. JP/SEA) **and** accuracy
  before any cutover. If not → stop here, keep Scrydex, having spent only safe work.
- **Revertible:** parallel data, zero user impact; drop the table.

### Phase 2 — Comp-cleaning layer over `soldListings` *(safe, additive)*
- Title-parse PPT `soldListings[]` to strip the leaky negative-keyword
  contamination (PPT's eBay scrape uses `-1stedition -shadowless …`; titles still
  carry stray variants/lots/lang). Produces a cleaned comp set + a clean median we
  control, independent of PPT's `averagePrice`.
- This is also what powers a future "recent sales" UI (titles/dates/links).
- **Revertible:** additive transform over shadow data.

### Phase 3 — Flagged cutover, per lane *(reversible via flag)*
- Behind `PRICING_PROVIDER=ppt|scrydex` (per lane: raw / graded), point the
  `PricingProvider` reads at PPT. Snapshot + cell writers already exist
  (`price_history_cells_from_contexts`); feed them PPT-shaped contexts so
  `server.py` serves PPT with **zero** changes to the read path or the resolvers
  (including the signed-leak / corrupt-cell guards — though PPT's flat model makes
  the signed case moot).
- **Update AGENTS.md invariants in this PR**, explicitly.
- **Revertible:** flip the flag back to `scrydex`; the Scrydex sync keeps running
  through Phases 1–3 so the fallback data is always warm.

### Phase 4 — Images + cleanup *(do last)*
- Rehost PPT `imageCdnUrl` (200/400/800) to GCS via the existing image pipeline —
  **do not hotlink tcgplayer-cdn at runtime**, and keep scan artifacts private.
- Decommission the Scrydex pricing sync only after a soak period.

## Open questions (answer in Phase 0/1, don't guess)

1. **JP / SEA coverage.** Scrydex is EN+JP; regional promos already gap (see
   `catalog_coverage_gap`). Is PPT EN-only (TCGplayer-keyed)? If it can't price JP,
   this is a **dual-provider** story (PPT raw/graded for EN, Scrydex for JP), not a
   full replacement. **This is the single biggest go/no-go.**
2. **PPT API cost/limits** for a daily full-catalog pull.
3. **Slab lane:** slab pricing currently rides the Scrydex lane (repo invariant +
   `slab_variant_grade_label_bug`). Does PPT's `{company}{grade}` cover BGS/CGC/TAG/
   ACE/SGC well enough to drive owned-slab pricing? (Moonbreon: yes — BGS10/CGC10/
   etc all present with volume.)
4. **Freshness/staleness:** trust `dataCompleteness`/`needsDetailedScrape` to gate
   which cards we serve PPT for vs fall back to Scrydex.

## Appendix A — PPT → our-schema field mapping (from real `swsh7-215` payload)

| Our field | PPT source |
|---|---|
| `cards.id` join | `externalCatalogId` (`"swsh7-215"`) — exact, no fuzzy match |
| stable provider key | `tcgPlayerId` (`"246723"`) |
| raw market (USD) | `variants["Holofoil"].marketPrice` / `prices.market` |
| raw market (EUR) | `cardmarketPrices.marketEur` / `trendEur` |
| graded market | `ebay.salesByGrade["psa10"].medianPrice` (stable) **or** `.smartMarketPrice.price` (current; carries `confidence`) |
| graded volume/spread | `.count`, `.minPrice`, `.maxPrice`, `.marketTrend` |
| graded time series | `ebay.priceHistory["psa10"][date]` → `{average,count,sevenDayAverage}` (feeds the trend cells) |
| sold comps | `ebay.soldListings["psa10"][]` → `{title,price,soldDate,url,bestOfferAccepted}` (clean in Phase 2) |
| images | `imageCdnUrl200/400/800` → GCS rehost (Phase 4) |
| freshness | `lastScrapedAt`, `scrapeCount`, `dataCompleteness`, `needsDetailedScrape` |

Note: PPT `salesByGrade` keys (`psa9`,`bgs10`,`cgc9_5`,`tag10`,`ace10`,`sgc9`,…) map
1:1 to our `(grader,grade)`; **there is no variant/flag axis** — so the snapshot
graded blob is a flat list per `(grader,grade)`, no `isSigned`/`isPerfect`.

## Appendix B — code touchpoints (mirror the Scrydex pipeline)

- **Ingest (new):** `backend/ppt_adapter.py` (PPT JSON → our contexts) +
  `backend/sync_ppt_catalog.py` — mirror `scrydex_adapter.py` +
  `sync_scrydex_catalog.py`.
- **Persist (reuse):** `catalog_tools.price_history_cells_from_contexts` already
  decomposes raw/graded context dicts → `card_price_history_cell`. Feed it
  PPT-shaped contexts; writers + `card_price_snapshots` schema are unchanged.
- **Resolve/serve (reuse, unchanged):** `server.py` pricing summary
  (`_pricing_summary_from_snapshot_row` → `_resolve_best_graded_context_entry`) and
  the trend (`resolve_graded_entry_from_cells`) work as-is. The signed-leak /
  corrupt-cell guards (`catalog_tools._pick_graded_item`,
  `_graded_cell_is_corrupt`) stay; PPT's flat model just makes the signed case a
  no-op.
- **Provider seam (new):** `PricingProvider` protocol + a `PRICING_PROVIDER` flag
  read by the sync layer (which provider populates the snapshot/cells) — **not** by
  the read path.
- **Shadow report (new):** `tools/compare_pricing_providers.py` → the Phase 1
  decision artifact.

## Reversibility summary

| Phase | User-visible? | Revert |
|---|---|---|
| 0 abstraction | no | delete protocol |
| 1 shadow ingest | no | drop parallel table |
| 2 comp cleaning | no | additive |
| 3 flagged cutover | **yes** | flip flag → scrydex (kept warm) |
| 4 images/cleanup | yes | re-enable scrydex sync |

Recommendation: do **Phase 0 + Phase 1 now** (safe, and Phase 1 *is* the real
decision data). Hold Phases 3–4 until the shadow report + JP-coverage answer justify
the irreversible bits.
