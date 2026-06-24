# Japanese Raw Pricing → TCGplayer Source Plan (2026-06-24)

## TL;DR (plain English)

Our Japanese **raw** card prices come from Scrydex, which prices JP cards at the thin
**Japanese-domestic** market in yen. That number is **erratic versus the market our users actually
check** (TCGplayer / eBay USD) — sometimes right, sometimes too low, sometimes way too high. It is
**not a uniform bias we can correct with a multiplier or an FX tweak**. The only real fix is to source
the **actual per-card market** for JP raw cards from TCGplayer (via the PokemonPriceTracker API, which
mirrors TCGplayer), keeping Scrydex for everything it does well (English raw, all graded/slab pricing,
identity, metadata).

This doc scopes that change. **No code yet.** It also flags that this deviates from the current
`AGENTS.md` invariant "Raw … pricing stays on the Scrydex-first lane" and therefore needs explicit
sign-off before implementation.

---

## What we have vs what we need

**Have today:**
- Scrydex daily sync writes JP raw price in **JPY** into `card_price_snapshots` / `card_price_history_daily`.
- Read path converts JPY→USD with a cached ECB rate at display time.
- Scrydex **graded** (slab) pricing is in USD and is **accurate** (validated this session: Gastly PSA10
  Scrydex $141.06 vs eBay $135.38; Umbreon VMAX 095/069 PSA10 Scrydex $5,443.75 vs eBay $5,500 — both <2% off).
- Scrydex **English** raw is essentially the TCGplayer feed already (matches PPT within ~1%).

**Need:**
- A **TCGplayer USD market price** for JP raw cards, refreshed daily, stored the same way the app already
  reads raw prices — so the UI needs no change.
- A **card-mapping** between our `card_id`s and TCGplayer/PPT cards (by set + number + language).
- A **fallback** for JP cards with **no TCGplayer listing** (e.g. Umbreon VMAX 095/069), plus a
  **safety guardrail** for the catastrophic-garbage cases.

---

## Evidence base (this session, 2026-06-23/24)

- **PPT raw market = TCGplayer USD**, verified (Gastly 080/071 PPT $42.88 = TCGplayer, labeled "Near Mint
  Holofoil – Japanese").
- **JP raw is erratic, not uniformly biased.** eBay-sold (cleaned JP-NM) vs Scrydex across a sample:
  Radiant Jirachi $4.47 vs $4.95 (right); Roxie $55 vs $49 (right); Mabosstiff −13%; Genesect −22%;
  Lugia V 109/098 **2.2× high**; plus earlier Gastly (low), Iono 091 (right), Iono 096 (high). No clean
  direction → no formula fix.
- **Catastrophic subset is small + catchable:** raw > the card's own PSA10 flags **173 cards (145 JP),
  ~0.4%**, dominated by Shiny Collection (シャイニーコレクション) with garbage USD-stored values ($32k, $200k)
  and old PCG/promo/e-card series.
- **Scrydex's own listings endpoint is NOT a clean raw source.** Calling `/listings?source=ebay` without a
  grade returns a graded/raw **mix** with `grade=None` on every row; for pricey cards it's ~all slabs.
- **Free data tiers can't audit at scale.** PPT free (~tiny daily credit cap) and 130point both
  rate-limit within ~a dozen calls. A real audit needs a **paid PPT month** (bulk pull).

---

## Phase 0 — Validation gate (do this BEFORE building anything)

Goal: quantify the gain and confirm coverage, cheaply, before touching ingestion.

1. **One paid PPT month** (or whichever tier unlocks bulk `/cards` + history). Free tier is unusable for
   audit (proven this session).
2. **Bulk pull** TCGplayer market for all JP cards we can map (set+number), diff against current
   Scrydex-JPY→USD. Produce the real distribution:
   - % of JP cards within ±10% / ±10–30% / >30% of TCGplayer.
   - Direction split (how often Scrydex is high vs low).
   - **Coverage**: how many of our JP cards PPT/TCGplayer actually has a market for (the no-listing
     residual is the fallback population).
3. **Decision criteria to proceed:** material divergence on a meaningful share of JP cards **and**
   acceptable TCGplayer coverage. If coverage is poor or divergence is small, stop here.
4. **Also settle the GRADED lane in the same paid month.** PPT's eBay/graded data (`includeEbay`) is
   paywalled on free (charges the credit, returns `ebayData:false`), so we couldn't compare it. Use the
   paid key to diff PPT `salesByGrade` vs Scrydex graded across the matrix. Prior going in: **keep
   Scrydex for graded** — validated this session against real eBay-sold (130point), it's within ~7% on
   5 of 6 cards (Umbreon VMAX 215 +6.6%, Gastly +4.2%, Umbreon JP −1%, Iono091 −5.4%, Iono096 +1.1%;
   one outlier Charizard ex 199/165 PSA10 +48%, likely stale/thin — spot-check). Only switch graded if
   PPT clearly beats it.

> Cheap, non-circular: this gate uses real TCGplayer numbers, not our own assumptions, and tells us the
> blast radius and the residual-fallback size before we commit to ingestion work.

---

## Architecture (if Phase 0 passes)

**Per-card source routing for the RAW lane only.** Graded, English raw, identity, and metadata stay
Scrydex. For a JP card:

```
JP card raw price:
  TCGplayer (PPT) market exists?  → use it (USD), provider="tcgplayer-ppt"
  else  → keep Scrydex JPY value, BUT apply the raw>own-PSA10 guardrail
            guardrail trips → suppress raw price ("graded only" / unavailable) or cap from graded ladder
            guardrail ok    → keep Scrydex number (it's the best we have; Umbreon-class is fine)
```

Why this shape:
- Uses existing columns — `card_price_snapshots.provider` + `display_currency_code` — no schema change.
- TCGplayer is USD → the read-path FX step becomes a no-op for those cards (no JPY conversion).
- Raw and graded are stored/read separately, so this **cannot touch slab pricing**.
- Provider-tagged → fully **revertible** by re-syncing Scrydex over the rows.

---

## Implementation outline (deferred until sign-off)

**A. Card mapping (the hard part).** Build/maintain a `card_id ↔ PPT/TCGplayer` map keyed on
(language=japanese, set, number). JP promos and reprints are error-prone (duplicate "PokéPark Munchlax"
entries exist). Store the mapping; treat unmapped JP cards as "no TCG listing" (fallback lane). This is
where most of the real effort and risk lives — budget for manual QA on collisions.

**B. New raw source adapter.** `tcgplayer_ppt_adapter.py` (parallel to `scrydex_adapter.py`):
`TCGPLAYER_PPT_PROVIDER = "tcgplayer-ppt"`, `fetch_tcgplayer_raw_pricing(card_id)` → USD `raw_contexts`,
`persist_tcgplayer_raw_snapshot(...)` → `upsert_price_snapshot(provider="tcgplayer-ppt",
display_currency_code="USD", …)`.

**C. Routing in the daily sync.** In the raw-persist path (`persist_scrydex_raw_snapshot`,
`scrydex_adapter.py:1178`): if `cards.language` is Japanese **and** the card is mapped **and** PPT
returns a market → write the TCGplayer snapshot instead of the Scrydex JPY one. Else fall through to
Scrydex.

**D. Guardrail (safety net, can ship independently).** Read-path guard behind a default-off flag:
when resolving a **raw** summary, compute the card's own PSA10 (USD) from `graded_contexts_json`; if
`raw_usd > psa10`, suppress or cap. Lives at the raw-summary finalization point fed by
`_pricing_summary_from_snapshot_row` (`server.py:2515`) / `_resolve_raw_context_summary`
(`catalog_tools.py:1816`). Validated logic this session: passes Gastly/Umbreon, flags the 173.

**E. Daily-sync cadence + credit discipline.** Pull PPT once per day per mapped JP card in the sync job
(NOT per app view) — mirrors the Scrydex daily-sync model, so per-view cost stays $0 from the DB. Cache
and respect PPT credit metering (1/card raw; history/eBay cost extra). Size the paid tier to (JP mapped
cards ÷ daily credit budget).

---

## Costs, risks, and invariants

**Credits / vendor cost:** PPT is credit-metered and the eBay/graded data is paywalled above free. We
only need **raw TCGplayer market** (cheapest call). Daily-sync model keeps it bounded; size the plan to
the JP mapped-card count.

**Coverage gap / fallback:** JP cards with no TCGplayer listing keep Scrydex + guardrail. Phase 0
measures how big this residual is.

**Mapping risk:** card_id↔PPT mapping for ~JP catalog is the main failure mode (wrong match = wrong
price). Mitigate with strict (language, set, number) keys + collision QA; unmapped → fallback, never
guess.

**AGENTS invariant — needs sign-off:** `AGENTS.md:29` states "Raw identity/reference/pricing stays on the
Scrydex-first lane." This plan deviates for JP raw **pricing** (not identity/reference). Requires explicit
approval and an AGENTS update before implementation.

**Safe by construction:**
- Identity keys are `(card_id, grader, grade, variant, condition)` — provider-independent → **deck
  entries don't recompute**, collections stay linked.
- Graded lane untouched (`graded_contexts_json` separate).
- TCGplayer USD → FX path no-ops for routed cards.
- Provider-tagged rows → revert by re-running Scrydex sync.

**Price-history note:** historical `card_price_history_daily` rows keep their original currency/provider
by date (frozen by design). Switching source affects new rows going forward; old JPY history stays as-is.
No backfill required for display (read uses latest snapshot).

---

## Phasing

- **Phase 0 — Validate** (paid PPT month, bulk diff, coverage map). Gate. *No code.*
- **Phase 1 — Guardrail safety net** (read-path, default-off flag, tests, local-validated). Ships the
  catastrophic-173 fix independently; useful regardless of Phase 0 outcome.
- **Phase 2 — Mapping** (card_id↔PPT, collision QA).
- **Phase 3 — JP raw ingestion** via TCGplayer adapter + sync routing; fallback to Scrydex+guardrail.
- **Phase 4 — Rollout** on staging, parity/coverage checks, then enable.

---

## Open questions for the user

1. OK to buy **one paid PPT month** for the Phase 0 audit? (Cheapest path to a real answer; free tier
   can't.)
2. Sign-off to **deviate from the Scrydex-first raw invariant for JP pricing** (and update `AGENTS.md`)?
3. For no-TCG JP cards that trip the guardrail: **suppress** the raw price ("graded only") or **cap**
   from the graded ladder? (Default lean: suppress — never show a number we can't stand behind.)

---

## Appendix — verified code seams (2026-06-24)

| Concern | File:line |
|---|---|
| Provider constant | `scrydex_adapter.py:40` (`SCRYDEX_PROVIDER = "scrydex"`) |
| Raw snapshot persist (routing seam) | `scrydex_adapter.py:1178` (`persist_scrydex_raw_snapshot`) |
| Raw context builder | `scrydex_adapter.py:1007` (`_contexts_from_variant_payloads`) |
| Snapshot upsert (provider/currency) | `catalog_tools.py:3362` (`upsert_price_snapshot`) |
| Raw summary resolve (guardrail point) | `catalog_tools.py:1816` (`_resolve_raw_context_summary`) |
| Snapshot row read | `catalog_tools.py:4457` (`price_snapshot_row`) |
| Raw/graded split + summary | `server.py:2515` (`_pricing_summary_from_snapshot_row`) |
| FX JPY→USD (no-op for USD) | `fx_rates.py:181` (`decorate_pricing_summary_with_fx`) |
| Card language source | `scrydex_adapter.py:660`, normalize `:635` (`cards.language`) |
| Scrydex listings (graded-dominated, not clean raw) | `scrydex_adapter.py:1234` (`fetch_scrydex_recent_sales`) |
| AGENTS raw-lane invariant (needs sign-off) | `AGENTS.md:29` |

Related memory: `project_scrydex_raw_jp_broken`, `project_pricing_parity`,
`feedback_scrydex_credit_caching`, `feedback_native_no_hacks`.
