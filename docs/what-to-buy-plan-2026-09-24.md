# "What should I buy?" — research findings and plan (2026-09-24)

**The question** (you, your mom, your dad, every vendor at a show): *what do I buy right now — which pack, which card, which slab — so it's popular, it sells, and it could make me money?* Nobody in the hobby answers this honestly today. This plan is what we can answer now, what we can't yet, and how we get there without guessing.

Research behind it: pull rates, our data inventory, a backtest pilot on our own price history, and a review of what actually moves Pokémon prices (sources in the appendix).

---

## What we learned (plain English)

1. **"Which pack should I open?" is answerable now.** TCGplayer publishes pull rates for almost every current English set (1,000–8,500 packs opened each). Combine them with the card prices we already have and we get *average value per pack* and *odds of a big hit* for a pack, bundle, ETB, or box. Japanese has no official rates; boxes have guaranteed hits, so JP gets a per-box estimate.
2. **"What will make me money in the next 1–3 months?" is NOT answerable yet — and anyone claiming it is guessing.** We tested simple "buy" rules on 5 months of our prod prices. **None made money after fees.** The best one ("rising last month") mostly reflects how the market price lags real sales, not a real edge.
3. **The patterns that ARE reliable are warnings, not tips:**
   - New-set cards fall **15–40% in their first 1–2 months** (30th Celebration Mew: ~$1,000 → ~$120 in a week).
   - **Buying the dip loses** — cards that fall usually keep falling.
   - **Sealed holds value far better than new-set singles**; sealed climbs after a set goes out of print — *if* it has a real chase card (Evolving Skies had Moonbreon; the Charizard UPC is still below retail).
   - **Fees are the silent killer**: a $20 card must rise **~23%** just to break even selling on TCGplayer; a $150 box **~25%**; selling to a vendor at 70% needs **+43%**. Grading a modern card under ~$150 to flip **loses money** at 2026 PSA prices.
4. **Nobody shows fee-adjusted break-even, and nobody publishes a track record of their picks.** That's our honest edge.
5. **We're short on history.** Longest price history is 162 days (prod); consistent TCGplayer prices only ~45 days. A real "buy signal" test needs 12–24 months. TCGCSV's historical archive is temporarily offline (maintainer removed it for server costs; ask for access).
6. **"Popular on Ekalight" isn't meaningful yet** — ~10–20 daily users; no card has 3+ viewers in 30 days. It becomes a moat later, not now.
7. **We already receive useful data and throw it away** (PPT sales velocity + trend; eBay active-listing counts; daily low/mid/high prices), and **the prod population job has been silently broken since June 30.**

---

## Have vs need

| To answer… | Have | Need |
|---|---|---|
| **Which pack to open** (mom) | Card prices + rarities for every set; sealed prices (staging) | Pull-rate table (hand-copied from TCGplayer, ~1 day for ~25 EN sets); JP per-box templates |
| **Will it profit after fees** | Prices | A fee/shipping table (TCGplayer, eBay, vendor %, grading) — pure arithmetic |
| **Is it popular / selling** (demand) | Nothing volume-based stored | Keep PPT `salesVelocityWeekly`/`marketTrend`/`sellers` daily (we download then drop them); run the PPT export daily (it isn't scheduled) |
| **Is supply drying up** | eBay listings for watched cards (1h cache, count not saved) | Save eBay active-listing count + lowest ask daily; sealed "print status" flag (manual) + reprint news |
| **Slab supply (pop growth)** | One population snapshot (June 27) | Fix the broken prod cron; save population daily as a history |
| **Proof it works** | 162 days prod history; pilot backtest scripts | 12–24 months of history (TCGCSV archive access, or PPT/Scrydex history endpoints, or wait until ~Mar 2027); a proper backtest harness |

---

## Plan

### Phase 0 — Start collecting now (history compounds; ~2–3 days)
Every day we don't store these is a day of history we can never get back.
1. **Fix the prod population cron** (one-line import-path bug) and **store population daily** (pop growth over time).
2. **Schedule the PPT export daily** and **keep sales velocity, trend, 7-day price, sellers** in a daily table (only volume signal we have).
3. **Save eBay active-listing count + lowest ask daily** for cards we already query (supply trend, "days of inventory").
4. **Keep TCGplayer low/mid/high in daily history** (free liquidity signal).
5. **Ask the TCGCSV maintainer for archive access** (back to Feb 2024; tools already built). In parallel check PPT/Scrydex price-history endpoints + cost.

### Phase 1 — Honest guidance we can ship now (~1–1.5 weeks)
Everything here is arithmetic or a well-supported pattern — no predictions.
1. **"Which pack?" — Set report card** (for mom): per product (pack / bundle / ETB / box), cost per pack, **average value back**, **chance of a $50+ hit**, and a plain verdict: *"Best for ripping"*, *"Fun but you'll usually lose money"*, *"Skip — chase cards have dropped and packs cost more than they return"*. JP shown per box, marked "community estimate". Home: **"Best packs to open right now"**.
2. **"Needs +X% to profit" on every card, slab, and sealed item** — fee-adjusted break-even by where you'd sell (TCGplayer / eBay / vendor). Nobody shows this.
3. **"Wait" warnings** backed by our own data: *"New set — cards like this usually drop 15–40% in the first 2 months"*; *"Grading this probably loses money (needs a PSA 10 worth 4.5× raw)"*; *"Spiked this week — spikes usually fade"*.
4. **Sealed vs singles context**: *"Still in print — sealed usually stays near retail"* vs *"Out of print since March"* (manual print-status flag per set to start).

### Phase 2 — Supply & demand signals (after ~4–8 weeks of Phase 0 data)
Per card / slab / sealed item, three plain labels with the evidence shown:
- **Popular** (sales velocity, later Ekalight activity) · **Selling** (sales/week, days of inventory) · **Supply** (listings shrinking/growing, pop growing, print status)
- Combined into a descriptive tag: **"Tightening"** (demand up, supply down, price hasn't moved), **"Hot but late"**, **"Cooling off"** — shown as *information*, not "buy".

### Phase 3 — Earn the right to say "buy" (needs 12+ months of history)
1. Build the real backtest (skip-a-week to avoid the price-lag illusion, non-overlapping periods, confidence intervals, real buy prices incl. shipping/tax).
2. **Gate:** a label ships as a buy-style signal only if it beats random picks **after fees** in several independent periods. Otherwise it stays descriptive.
3. **Public track record**: every signal logged with what happened 30/60/90 days later. This is what turns "I feel like it'll go up" into "I know this usually goes up" — and protects us from "you pumped it" accusations.

---

## Guardrails (from the research)
- **Language:** "market info for collectors", never "investment advice"; no "invest"/"ROI" in App Store copy (Apple 3.2.1); disclaimer on every signal; disclose affiliate links near picks (FTC).
- **Anti-pump:** only flag items above a liquidity floor (≥$20 and real sales volume); never flag something already up sharply this week; everyone sees signals at the same time; internal no-trading policy on flagged items; public log.
- **Weight fixed-price sales over auctions** (auction comps can be shill-bid).

## Decisions for you
1. **Start Phase 0 now?** (low effort, and every day we wait is history lost)
2. **Phase 1 order:** pack report card first (mom) or "needs +X% to profit" first (everyone)?
3. **OK to email the TCGCSV maintainer** about archive access (possibly paid)?
4. **Hold horizon** you care about most (1–3 months vs 1+ year) — decides which Phase 3 test comes first.

---

## Appendix — key numbers & sources
- **Pull rates:** TCGplayer Authentication Center articles (e.g. Pitch Black 2026-07-21); covers SVI…PBL + some SWSH; sample 350–8,500 packs; per-tier % with 95% CI. EN products = N independent packs (bundle 6, ETB 9, PC ETB 11, box 36). JP: per-box guarantees (standard 30 packs; high-class 10), community tallies only. Existing EV tools: PPT sets page, ThePriceDex, RipOrFlip, theexpectedvalue.com — none tie EV to momentum/fees. Transcribe figures with attribution; don't scrape TCGplayer's undocumented article API without sign-off.
- **Backtest pilot** (`/tmp/backtest-pilot/`, prod `card_price_history_daily`, EN singles ≥$10, weekly starts May–Aug 2026, 15% round-trip haircut): 28-day mean net −11.4% baseline; momentum top-10% −9.2% (edge fades when skipping recent weeks → price lag); buy-the-dip −15.0%; sets 0–3 months −28%. Sealed (TCGCSV, one month): new-set singles median −14% vs sealed −2.9%; 2–5y sealed +1.8% (70% up). Not statistically meaningful — 1–4 independent periods.
- **Fees (2026):** TCGplayer ~13.25% all-in (10.75% + 2.5% + $0.30, $75 cap); eBay 13.25% + $0.40 on total incl. tax/shipping; stamp $0.82; PSA cheapest tier $59.99 (Value tiers paused since June 2); CGC bulk $17; vendors pay ~60–80% of market.
- **Evidence-backed signals:** fee break-even; post-release decay; in-print vs out-of-print + reprint news; supply/demand tightness (days of inventory, listing trend, sales velocity — TCG Quant's approach, the only competitor with a buy score); grade scarcity vs pop growth. **Don't work:** short-term "top gainers" on thin cards; headline index returns; "out of print = up" without a chase card; launch-week prices; hype/YouTube as buy triggers; raw "low pop" without gem rate/growth; grading modern <$150; tournament meta for collector cards.
- **Data inventory:** prod Scrydex raw 2026-04-16→09-24 (162 days); TCGCSV main lane ~43–49 days; graded cells daily on prod; PPT export ran once (2026-06-27), velocity columns dropped (`backend/sync_ppt_catalog.py:473-490`); prod population cron failing since 2026-06-30 (`backend/run_ppt_population_vm.sh`, ModuleNotFoundError); eBay Browse `total` not persisted; ~10–20 DAU.
