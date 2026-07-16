# Grading Advisor + Trade Analyzer — Feature Specs (2026-07-16)

Two "Robinhood of collecting" features that pass the differentiation test — *only we
can build them, with data we already have*. Scoped from the live codebase; effort
estimates assume one experienced dev. Status: **specced, not built**.

---

## Feature 1: Grading Advisor

**One line:** on any raw card's detail page, answer "is this worth grading?" with the
raw↔graded price spread we already store — information, never advice.

### The user experience

A section on the PDP for raw-lane cards, below Price Trend:

```
WORTH GRADING?
Raw (NM) today ················· $95.00
PSA 10 comps ····· $450.00  → +$330 net
PSA 9 comps ······ $180.00  → +$60 net
─────────────────────────────────────────
Net = comp − raw − ~$25 grading fee
PSA gem rate for this card: 21%     (only when population data exists)
```

- Renders only when the card has PSA graded comps. Negative nets still render —
  "don't bother" is equally valuable information.
- Copy rules: "comps," "net after ~$25 fee" — never "you should grade." The ~ keeps
  the fee honest.

### Data reality (verified in code)

- Raw market price: already on the card-detail payload (`CardDetailRecord.marketPrice`).
- PSA 10/9 comps: served by `GET /api/v1/cards/{id}/price-trends?mode=graded&grader=PSA`
  (`CardPriceTrendRow.currentPrice` per grade, with `confidence`/`saleCount`). The PDP
  already calls this endpoint but lazily (only when the user flips to a graded lens) —
  the advisor triggers the same cached fetch on raw-PDP open.
- Gem rate: `detail.population.PSA.gemRate` (GemRate via the PPT sync, card-level
  `population_json` on `card_price_snapshots`). Coverage is partial — render the line
  only when present.
- Graded contexts are card-level (populated from eBay sales-by-grade regardless of
  ownership) — a never-graded card still has comps.

### Build (RN-only, no backend)

1. `GradingAdvisorCard` component (design-system primitives; SurfaceCard + rows),
   mounted in `card-detail-screen.tsx` for raw-lane cards below the Price Trend list.
2. Trigger `fetchTrendsForLane('graded')` (already exists, cached) on raw-PDP mount.
3. Grading fee: labeled client constant `GRADING_FEE_ESTIMATE = 25` ("~$25 typical PSA
   value tier"); server-configurable later if fees need tuning without an OTA.
4. Guards: section hidden when no PSA-10 comp; gem-rate line hidden when no population.
5. Tests: renders with comps (net math exact), hidden without, negative-net rendering,
   gem-rate conditional.

**Effort: ~2–3 evenings. Ships OTA.**

### v1.1 candidates (not in v1)

- Expected-value line using gem rate: `EV = gemRate×PSA10 + (1−gemRate)×PSA9 − fee`
  (clearly labeled as rough).
- BGS/CGC tabs; per-grade confidence badges (data exists).
- "💎 grade-worthy" chip on scanner results — the flywheel version (scan a binder,
  instantly see which cards to pull for grading).

---

## Feature 2: Trade Analyzer

**One line:** two lists of cards, two totals, one neutral fairness readout — the
question at every trade table, answered by the scanner app already in their hand.

### The user experience (v1)

```
TRADE ANALYZER
YOUR SIDE                        $312.40
🖼 Umbreon VMAX (NM)     $285.00      ✕
🖼 Gengar holo (NM)       $27.40      ✕
[+ add from collection]  [+ search]

THEIR SIDE                       $286.10
🖼 Charizard V (NM)      $286.10      ✕
[+ search]
──────────────────────────────────────────
⚖️  You're giving up $26.30 (8.4%)
    Roughly even is within ~5%
```

- **Verdict tone (decided): numbers + neutral band.** The app states the difference
  and a quiet reference line; it never says "bad trade" — information, not arbitration.
- Condition defaults NM per line (editable later); graded cards enter with their slab
  pricing.
- Session is in-memory for v1 — leaving the screen ends the trade.

### Architecture reality (verified in code)

- The scanner tray is ONE in-memory array with persistence/price-selection/animations
  coupled to it — a native dual-tray scanner mode is a 1–2 week refactor. **Don't
  start there.**
- The cheap staircase exists: the catalog search sheet (add by search), the portfolio
  bulk-select model (`Set<entryId>` — add from collection), the module-level
  session-store pattern for passing rich card data between screens, and the scanner's
  add-all destination dispatcher (`collection | wishlist | remove`) that can gain
  trade-side destinations.

### Build phases

- **v1 — standalone screen** (`(stack)/trade/index.tsx`, peer of Wishlist): two side
  lists + add-via-search + add-from-collection picker + totals (same reduce as the
  tray) + neutral verdict. **~4–6 evenings, OTA.**
- **v1.1 — scan-into-trade** (+~2 evenings): two new destinations in the scanner's
  existing dispatcher ("Send to trade: your side / their side"). Scan-at-the-table
  without touching tray architecture.
- **v2 — native dual-tray scanner mode**: only if v1.1 feels clunky at a real show.
  (1–2 weeks; not planned.)

### Why it matters strategically

It's social by construction — two people huddle over one phone at a show table, and
the second person's next question is "what app is that?" Built before Aug 27, it's an
acquisition feature on the show floor, not just a utility.

---

## Suggested sequence

1. Grading advisor (2–3 evenings, unique, feeds the scanner story).
2. Trade analyzer v1 + v1.1 (~6–8 evenings total) targeted before the Aug 27 show.
3. Revisit: EV line, scanner grade-worthy chip, trade-session persistence.
