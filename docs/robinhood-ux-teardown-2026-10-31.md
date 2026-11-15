# Robinhood UX teardown, and what Ekalight should take from it

Date: 2026-10-31. Status: research plus a plan. Nothing here is built yet.

How to read this: Part 1 is the plain-English version. Part 2 lists what we have and what we need. Part 3 is the build list in priority order. The appendices hold the pattern-by-pattern teardown, the competitor notes, the code-fit notes and the sources.

**Confidence labels used throughout**
- **[DOC]**: documented by Robinhood or a primary source. Cited inline.
- **[REPORTED]**: from secondary press or third-party write-ups. Cited.
- **[INFERENCE]**: my reading of how the app behaves, or common knowledge from using it. No primary source was found. Check it on a device before treating it as spec.

---

## Part 1 — Plain English

### What actually makes Robinhood feel good

It is not one effect. Five habits stack up.

1. **One number dominates each screen, and that number moves.** Google Design's case study on the original app says it directly: "The value of the stock is represented by a large number and a graph, both of which animate when the stock value changes." [DOC] ([Google Design](https://design.google/library/robinhood-investing-material)). Robinhood open-sourced the odometer it used for this, `robinhood/ticker`. Each character rolls independently through an ordered list of characters, and the view handles width changes such as "9999"→"10000". Duration and interpolator are configurable, and the README's examples use 500–1500 ms with an *overshoot* interpolator. [DOC] ([github.com/robinhood/ticker](https://github.com/robinhood/ticker))
2. **The chart is the control, and scrubbing rewrites the headline.** Robinhood also open-sourced `robinhood/spark`, its sparkline. Scrubbing is defined as "when the user taps and drags their finger along the sparkline chart". An `OnScrubListener` pushes the scrubbed value into the headline text. There is a first-class *baseline* line, and two built-in animators: Line (draw-on) and **Morph** (the old path morphs into the new one). [DOC] ([github.com/robinhood/spark](https://github.com/robinhood/spark)). So the "line morph when you change range" and the "dotted baseline" are part of Robinhood's own primitives, not something we imagined.
3. **Color is state, not decoration.** Green and red come from comparing the last value in the window to the first, applied to the line and, in the classic app, to the whole screen. Google Design: "The color of the UI changes depending on the status of the market and the value of the stock". After hours, "the full background turns from white to dusky grey". [DOC] ([Google Design](https://design.google/library/robinhood-investing-material)). Legend's docs state the rule exactly: "if the last close price in the frame is higher than the first close price in the frame, the line is green, and red if it is lower." [DOC] ([Robinhood Legend widgets](https://robinhood.com/us/en/support/articles/widgets-in-robinhood-legend))
4. **Restraint everywhere else.** The early team said notifications "weren't designed to prompt engagement", and notification content is readable without opening the app. [DOC] ([Robinhood newsroom, design story](https://robinhood.com/newsroom/the-top-secret-robinhood-design-story)). The 2024 rebrand's principle was "less is more", with a "distraction-free experience". [DOC] ([Robinhood, new visual identity](https://robinhood.com/newsroom/a-new-visual-identity)). Black, white and neutrals carry the screen. The single "Robin Neon" accent is a bright yellow-green. [DOC] (same source)
5. **Typography carries the brand.** In 2020 COLLINS chose Capsule Sans (a modified Maison) with Nib as the serif ([Robinhood 2020 identity](https://robinhood.com/newsroom/a-visual-identity-that-better-reflects-our-vision/)). The 2024 refresh reportedly moved to a custom sans, "Phonic", for UI, with Martina Plantijn as the serif for headlines and Gold. [REPORTED] ([Design Compass](https://designcompass.org/en/2024/10/18/robinhood-rebranding), [1000logos](https://1000logos.net/news/robinhood-an-identity-for-a-mature-brand)). Foundry credits conflict between sources. The lesson that matters for us: **the big number uses tabular figures, so digits do not jiggle as they roll.** Our tokens already declare `fontVariant: ['tabular-nums','lining-nums']` (tokens.ts:294).

### The cautionary tale: confetti

Robinhood removed its confetti animation on 2021-03-31, while under scrutiny for "gamification" ([CNBC](https://www.cnbc.com/2021/03/31/robinhood-gets-rid-of-confetti-feature-amid-scrutiny-over-gamification.html)). Massachusetts regulators had cited it in a complaint, and the January 2024 settlement was **$7.5M**. Robinhood agreed to "permanently cease the future use of confetti". The same order also named digital scratch tickets, free-stock rewards, push notifications and "most popular" lists as engagement tactics aimed at inexperienced users ([Tearsheet](https://tearsheet.co/?p=59230), [WealthManagement](https://www.wealthmanagement.com/regulation-compliance/robinhood-pays-7-5m-to-settle-massachusetts-gamification-charge), [Insurance Journal](https://www.insurancejournal.com/news/east/2024/01/19/756246.htm)).

**The lesson for us:** a celebration attached to a *transaction you might regret* is the problem. A celebration attached to an *accomplishment* is fine. Robinhood rewarded the act of trading itself, so the reward reinforced frequency. For Ekalight the risky zone is pack openings, "your card went up" pushes, and anything that makes ripping or flipping feel like a slot pull. That risk is real right now. Digital repacks such as Courtyard face US lawsuits alleging unlicensed gambling while reporting ~$2B/yr pace ([on360](https://on360.ca/?p=920), [cllct](https://www.cllct.com/sports-collectibles/sports-cards/how-do-digital-repacks-work-cllct-offers-its-guide-to-hobby-s-hottest-trend)).

### The core problem in translating Robinhood to cards

Robinhood has **one liquid price per asset, ticking in real time**. A card has **many prices**: raw NM/LP/MP, each printing, PSA/CGC/BGS at each grade, and EN/JP. Those prices update **daily at best**, and for graded slabs they come from **a handful of sales a month**. Copying Robinhood literally would make the UI lie in three ways. It would show a "live" dot over stale data. It would draw a smooth, confident line through three sales. And it would show a headline "value" you could not actually sell for.

The fix is to keep the *feel* (big number, rolling digits, scrub-rewrites-headline, state color, morph) and swap the *semantics*.
- The live dot becomes an **"as of" freshness dot**.
- The smooth line becomes an **honest line**: sale dots on graded charts, and a visible gap or dashed segment where there is no data.
- The single price becomes a **declared lane**: "Raw · NM · Unlimited" in a chip, always visible and tappable.
- The portfolio total gains an optional **"quick-sell estimate"** line, so vendors see what they could actually realize.

---

## Part 2 — What we have vs. what we need

| Area | Have (in code today) | Need |
|---|---|---|
| Scrub chart (Collection) | `portfolio-chart-card.tsx`: react-native-svg path, long-press (~250 ms) scrub lock with a Light impact haptic, horizontal-drag-enters-scrub, dashed guide line, tooltip, headline driven by `onActivePointChange`, sub-$1 baseline guard on % | Per-point haptics policy; baseline-cross haptic; range-switch morph; reduce-motion path; VoiceOver adjustable action |
| Ranges | `1W 1M 3M YTD 1Y ALL` (api-client `historyRanges`) | Keep. Hide ranges with fewer than ~3 points rather than drawing a flat lie |
| Big number | `portfolio-balance-header.tsx`: static Text, delta row with arrow and colored text, eye-toggle privacy | Rolling-digit ticker (Reanimated); ticks on value change and on scrub, not while scrubbing |
| PDP chart | `card-price-trend-list.tsx`: 62×22 sparkline rows per lane; graded rows expand to "last solds" | A real scrubbable hero chart on PDP that reuses the portfolio chart core; sale dots for graded |
| Color | tokens: `green400/red400`, `greenDelta/redDelta`, pill ramps | Semantic `trendUp/trendDown/trendFlat` tokens, plus an accessible-colors variant (blue/orange) |
| Haptics | `expo-haptics` installed. Used on scrub lock, scanner (Heavy/Success), portfolio (Medium), evolution haptics | One central `haptics.ts` vocabulary with a global settings toggle |
| Motion libs | `react-native-reanimated 4.2.1`, `react-native-worklets 0.7.4`, `react-native-gesture-handler 2.30`, `react-native-svg 15.15` | **No `@shopify/react-native-skia`** installed. Adding it means a **native build**. Everything in the S/M list below works without it |
| Reduce motion | Only `card-price-trend-skeleton.tsx` checks `isReduceMotionEnabled` | App-wide `useReduceMotion()` (Reanimated ships `useReducedMotion`) |
| Freshness | "Updated m/d/yyyy" only on the Cost Basis row | "Prices as of 6 PM PT" on every price header; dot state |

---

## Part 3 — Prioritized build list

Effort: **S** is under a day, **M** is 2–4 days, **L** is a week or more. "OTA" means it can ship as a JS-only update. "Native" means it needs a new binary; see the EAS build-cap note in memory.

| # | Build | Why | Effort | Libs | Ship |
|---|---|---|---|---|---|
| 1 | **Rolling-digit price ticker** (`<RollingNumber>` in design-system) for the Collection total, PDP price and scanner tray price. Per-digit columns with translateY, tabular nums, ~400–600 ms, a slight overshoot, and only changed digits roll. Width changes animate. Reduce-motion falls back to a crossfade | It is the single most "Robinhood" signal, and Robinhood's own Ticker shows the pattern | S–M | reanimated (have) | OTA |
| 2 | **Honest freshness dot + "as of"** replacing any pulsing "live" dot. The dot pulses **only** in the first ~2 min after a value actually changed while you watched (for example, after pull-to-refresh). Otherwise it is solid, with the caption "Prices as of today 6:00 PM PT" or "Last sale Oct 12" for graded | Card prices are daily. A permanently pulsing dot is a lie users will catch, and pricing trust is already #1–3 on the competitor complaint map | S | reanimated | OTA |
| 3 | **Shared scrub-chart core plus PDP hero chart**. Extract the gesture, scrub and path math from `portfolio-chart-card.tsx` into `features/charts/`, then use it on the card PDP for the selected lane. Add sale-dot rendering for sparse graded lanes, and **gap/dashed segments** where no data exists (no interpolated fake line). Add a range-switch morph by interpolating resampled y-arrays to a fixed N points, which avoids SVG path-command mismatch | Today the PDP has only 62×22 sparklines. The hero chart is the emotional center of the mock | M | reanimated + svg (have). Skia optional later | OTA |
| 4 | **Haptic vocabulary** (`lib/haptics.ts`): `scrubLock` (Light impact, already exists), `scrubTick` (selection, throttled, **only on sparse charts**: one tick per *sale point*, not per pixel), `baselineCross` (rigid/soft impact once when the scrub crosses the start value, which makes the color flip), `rangeChange` (selection), `addedToCollection` (success notification). A global "Haptics" toggle goes in Settings, per Apple HIG | Apple HIG: "avoid overusing haptics" and let people turn them off ([Apple HIG](https://developer.apple.com/design/human-interface-guidelines/playing-haptics)). Ticks on *real* sales make the haptic carry information | S | expo-haptics (have) | OTA |
| 5 | **Lane chip as the price's subtitle**: "Raw · NM · Unlimited" or "PSA 10". Tapping opens the existing grade/condition sheet. Ticker, chart and color all follow the lane. The lane is remembered per card | Answers "what is *the* price?" every time, without a second screen | S–M | — | OTA |
| 6 | Row price box: **tap toggles $ change ↔ % change ↔ price** across *all* rows at once (persisted), Robinhood style [INFERENCE on RH behavior] | Vendors want $; collectors want % | S | — | OTA |
| 7 | **Quick-sell line on Collection**: a secondary number under the total, "≈ $X if sold to a dealer today (70%)". It uses the vendor buy-% we are already planning (vendor-first reframe) and is user-adjustable | Collection value ≠ realizable value. That is the honest gap no competitor shows | M | — | OTA (backend optional) |
| 8 | **Confidence treatment** on thin data: under ~3 sales/90d, the chart line goes gray-dashed, the headline gains "Low data · 2 sales", and the color theme stays neutral (no green/red screen wash on noise) | Avoids a full-screen green celebration because one PSA 9 sold high. Alt does the same with a High/Med/Low confidence bar ([Alt](https://support.alt.xyz/en/articles/9213564-alt-value-confidence-levels)) | M | — | OTA (needs sales count per lane in the payload; partly present via `salesCount`) |
| 9 | **Whole-screen theme wash** (subtle tinted background + accent) driven by the window's direction, with an "Accessible colors" setting (blue up / orange down) like Robinhood's own toggle ([RH accessibility](https://robinhood.com/us/en/support/articles/accessibility-options)) | Robinhood's signature, kept honest by #8 | S–M | — | OTA |
| 10 | **Price alerts v1**: per watchlist card, "notify if it moves ±10% (daily)" or "drops below $X". Delivered in the daily sync window. **Opt-in, off by default for Watchlist**, mirroring Robinhood ([RH price alerts](https://robinhood.com/support/articles/price-alerts)). The content must be readable in the push itself | High utility, and the deal-radar work already exists | M–L | expo-notifications (check) | Backend + OTA. Native only if notifications are not already configured |
| 11 | **"Your movers" strip, honest version**: biggest $ movers *in your collection* over 7d, excluding thin-data cards | Personal and useful. A market-wide "Top movers" already exists as Top Trends | S | — | OTA |
| 12 | VoiceOver: chart as an `adjustable` element (swipe up/down steps through points and announces "Oct 12, $142, up 8%"), plus a text summary of the range | Robinhood itself admits gaps here ("doesn't adjust to your device's text size preferences yet") ([RH accessibility](https://robinhood.com/us/en/support/articles/accessibility-options)). We can beat them | S–M | — | OTA |
| 13 | Skia chart renderer (gradient fill under the line, GPU path interpolation, 120 fps) via `@shopify/react-native-skia` or Margelo's `react-native-graph` ([repo](https://github.com/margelo/react-native-graph)) | Polish only, after 1–12 prove out. The current SVG chart already works | L | skia | **Native** |

**Top 5 to build first:** #1 ticker, #3 PDP hero chart with honest gaps and morph, #2 freshness dot, #4 haptic vocabulary, #5 lane chip. All five ship as OTA on libraries we already have.

**Do not build:** confetti or celebration on add or scan, streaks, "most popular" leaderboards of what others are buying, pack-opening reveal animations with price flashes, or push notifications whose aim is opening the app rather than informing the user.

---

## Appendix A — Robinhood pattern inventory (keep / adapt / skip)

### A1. Chart scrubbing
- **What RH does:** long-press or drag scrubs. A vertical cursor follows the finger, the headline number and change row rewrite to the scrubbed point, the date shows above the cursor, and lifting your finger snaps back to "now". Advanced charts document long-press-to-scrub ([RH advanced charts](https://robinhood.com/us/en/support/articles/using-advanced-charts)) [DOC]. Spark documents the scrub-to-headline listener [DOC].
- **Haptics while scrubbing:** I found **no primary source** saying RH ticks per data point. [INFERENCE] The current iOS app plays a subtle selection tick when scrub engages, and may play ticks as the cursor moves on low-density ranges. Verify on a device. Either way, Apple's guidance argues against continuous per-pixel ticks.
- **Ekalight: ADAPT.** We already have the long-press lock (a good call, since it avoids hijacking tab swipes). Add: (a) ticks only on real sale points for graded, plus one tick on the *baseline cross*; (b) the snap-back should animate the headline back with the ticker, not jump; (c) the change row while scrubbing should read "since {range start}", which we already compute.

### A2. Baseline / dotted line
- **What RH does:** a dotted horizontal line at the reference value. For 1D that is the previous close, and the daily return uses the prior 4 PM ET close ([RH using charts](https://robinhood.com/support/articles/using-charts)) [DOC for the baseline value; the dotted rendering is INFERENCE, consistent with Spark's `hasBaseLine()`/`getBaseline()` API [DOC]].
- **Ekalight: KEEP.** The baseline is the range's first point. On Collection, consider a baseline at *cost basis* when one exists. That is "am I up on what I paid?", which is more meaningful for collectors than "since 1M ago". This overlaps the since-added baseline work already live on Watchlist/Collection rows.

### A3. After-hours / extended-hours conventions
- **What RH does:** separate line treatment for extended hours, with a "Show all hours" toggle. 1D/1W are 24-hour charts ([RH using charts](https://robinhood.com/support/articles/using-charts)) [DOC]. The classic app grayed the background after hours ([Google Design](https://design.google/library/robinhood-investing-material)) [DOC].
- **Ekalight: ADAPT the idea of "price states."** Cards have no market hours, but they do have *data states*: (1) fresh daily market price; (2) carried-forward (no new data today, so draw the segment dashed); (3) sales-only (graded, discrete dots); (4) no data (gap). The dimmed-future-line idea in our mock is about scrubbing; keep it. Use dashed segments for carried-forward values, which is the honest analogue of after-hours.

### A4. Pulsing "live" dot
- **What RH does:** a pulsing dot at the line's end on live ranges. [INFERENCE: widely observed, undocumented.]
- **Ekalight: ADAPT (build #2).** Pulse only on a genuine change you just witnessed. Otherwise use a solid dot with an "as of" caption. The pulse is a promise of liveness, and we cannot keep that promise. Prices sync once a day (prod 6 PM PT per catalog-freshness notes).

### A5. Number ticker
- **What RH does:** per-character odometer roll, wrap-around when shorter, configurable duration and interpolator ([robinhood/ticker](https://github.com/robinhood/ticker)) [DOC]. Odometer micro-interaction on bid/ask in the redesigned trade buttons ([Pratt IxD critique](https://ixd.prattsi.org/2025/02/design-critique-robinhood-ios-app/)) [REPORTED].
- **Ekalight: KEEP (build #1).** Rules: digits roll in the direction of change (up rolls up). Do not roll during an active scrub, because 60 updates/s of rolling digits is noise; set text instantly while scrubbing and roll only on release or range change. Respect reduce-motion.

### A6. Color theming rules
- **RH:** last vs first in the window decides green or red [DOC, Legend]. The theme is a user setting, with options light, dark, "market hours", or system, plus an "Accessible colors" toggle for red-green colorblindness ([RH accessibility](https://robinhood.com/us/en/support/articles/accessibility-options)) [DOC]. A third-party blog says gain/loss colors stay constant across dark and light [REPORTED, low confidence].
- **Ekalight: KEEP plus a neutral state.** Add a third, **neutral** state for (a) |change| < ~1% or < $0.50, (b) low-confidence data (#8), and (c) $0 baselines (the code already guards sub-$1 baselines for %). Robinhood has no neutral state because stocks always move. Cards often do not.

### A7. Range switching
- **RH:** Spark ships a MorphSparkAnimator [DOC]. [INFERENCE] The app morphs the line between ranges in about 300 ms, and the headline ticker rolls to the new delta.
- **Ekalight: KEEP (in #3).** Implementation note: resample both series to a fixed N (e.g. 64) y-values, interpolate the y-arrays on the UI thread with Reanimated, and rebuild the path string per frame. That avoids the path-command mismatch that breaks naive SVG `d` interpolation. A range pill press plays a selection haptic. **Hide or disable** a range whose data is shorter than the range (for example, a card added 5 days ago shows 1W only), rather than padding with a flat line.

### A8. List rows (sparkline + price box)
- **RH:** watchlist rows show a ticker, sparkline and a colored price button. [INFERENCE] Tapping the button cycles price / % / $ for all rows. Lists sort by symbol, price or % change ([9to5Mac 2020](https://9to5mac.com/2020/02/20/robinhood-ios-profiles-feature/)) [REPORTED].
- **Ekalight: KEEP (build #6).** We already have sparklines on rows. Add the global toggle and sorting by "biggest $ move", which vendors need.

### A9. Top Movers / Lists
- **RH:** "Top movers" cards show the day's largest % gains and losses after market close ([RH lists](https://robinhood.com/us/en/support/articles/lists)) [DOC]. Note the "most popular" lists were named in the MA consent order [REPORTED].
- **Ekalight: KEEP Top Trends (exists); SKIP "most popular / most-scanned" social-proof lists.** Prefer movers *in your collection* (#11) and require minimum liquidity, so a $0.30 bulk card going to $0.90 (+200%) does not top the list. This filter mostly exists already (same-source pairing plus distinct-price filter).

### A10. Notifications / price alerts
- **RH:** 5%/10% movement alerts, a 52-week high/low (max one each per week), custom above/below price alerts set from the chart's bell icon. Watchlist alerts are **off by default**, holdings on ([RH price alerts](https://robinhood.com/support/articles/price-alerts)) [DOC]. The design philosophy is informational, not engagement ([RH newsroom](https://robinhood.com/newsroom/the-top-secret-robinhood-design-story)) [DOC].
- **Ekalight: ADAPT (build #10).** Batch into one daily digest at the sync time ("3 of your cards moved >10%"), not per-card spam. Put a bell on the PDP chart header. Say the threshold out loud in the push. Cap frequency.

### A11. Onboarding / empty states
- **RH:** card-based onboarding prompts, uniform illustration style, contextual illustrations (bank linking shows a checkbook), and snackbar confirmations for watchlist add/remove ([Google Design](https://design.google/library/robinhood-investing-material)) [DOC].
- **Ekalight: ADAPT.** An empty Collection should be a **ghost chart**: a gray dotted flat line at $0, plus one primary CTA, "Scan your first card". The current code already draws a flat baseline for zero points, so this needs copy and a CTA, not a new chart. After the first add, the chart animates up from $0 (the one-point rule already rises from the baseline). That is the "money moving" moment, earned by an action of the user's own, not confetti.

### A12. Dark mode
- **RH:** light/dark/market-hours/system [DOC]. The 2024 identity is black, white and neutrals with Robin Neon [DOC]. Unofficial token sites claim a near-black canvas with a #CCFF00-ish neon [REPORTED, unofficial].
- **Ekalight: DEFER.** Our page background is pure white by design (tokens.ts). Dark mode is a large token audit. Do it as its own project, keeping green and red identical in both modes, and check contrast (memory: "invisible ≠ absent").

### A13. Accessibility
- **RH:** accessible-colors toggle; admits text-size and TTS gaps [DOC].
- **Ekalight: EXCEED (build #12).** Use a chart `accessibilityRole="adjustable"` with increment/decrement stepping through points, Dynamic Type on the headline (with a cap), reduce-motion fallbacks for the ticker, morph and pulse, and never color-only deltas (we already render an arrow icon plus sign).

### A14. Gold / Legend styling
- **RH Gold:** serif (Martina Plantijn) plus gold accents mark the premium tier [REPORTED] ([1000logos](https://1000logos.net/news/robinhood-an-identity-for-a-mature-brand)). The Gold card is real 10k gold for referrals, as marketing theater ([RH newsroom](https://robinhood.com/us/en/newsroom/the-new-gold-standard-introducing-the-robinhood-gold-card/)) [DOC]. **Legend:** dense, dark, multi-widget desktop for active traders ([RH Legend](https://robinhood.com/us/en/legend)) [DOC].
- **Ekalight: ADAPT later.** A premium tier could earn a distinct typographic voice, using our `display` family for the headline number. The Legend lesson is **two densities**: a calm collector view and a dense "vendor mode", meaning a compact list, $-first, the quick-sell number, and no chart wash. That fits the vendor-first reframe directly.

### A15. One primary action per screen
- **RH:** a single dominant Trade/Buy button. The redesign fills Buy with the performance color and leaves Sell outlined ([Pratt IxD](https://ixd.prattsi.org/2025/02/design-critique-robinhood-ios-app/)) [REPORTED].
- **Ekalight: KEEP.** On the PDP the sticky primary is "Add to collection" (or "Update" if owned). Secondary actions (watch, share, list) go in the header or overflow. Do **not** tint the Add button green or red with price direction. Robinhood ties action color to market direction, and for us that nudges "buy on green", the exact gamification vector we want to avoid.

---

## Appendix B — Motion and haptic spec (proposed starting values)

All values are proposals to tune on a device, not Robinhood measurements.

| Element | Duration / easing | Haptic |
|---|---|---|
| Ticker digit roll | 450 ms, `Easing.out(Easing.back(1.2))` (slight overshoot, cf. RH Ticker's OvershootInterpolator example) | none |
| Range-switch line morph | 300 ms, `Easing.out(Easing.cubic)` | `selectionAsync` on pill press |
| Scrub enter | immediate | `impactAsync(Light)` (exists) |
| Scrub across sale point (graded, ≤ ~40 points) | — | `selectionAsync`, throttled ≥ 40 ms |
| Scrub crosses baseline | color crossfade 150 ms | `impactAsync(Soft)` once per crossing |
| Scrub release snap-back | ticker roll 300 ms | none |
| Theme wash change | 400 ms color interpolate | none |
| Freshness pulse (only after a real change) | 1.6 s loop, scale 1→2.2, opacity .4→0, max 2 min | none |
| Added to collection | button → check morph 250 ms, total ticker rolls up | `notificationAsync(Success)` |
| Reduce motion on | crossfade 150 ms, no roll, no pulse, no morph | haptics still honor the app toggle |

---

## Appendix C — "Robinhood for X" in collectibles: what worked, what was gimmicky

- **Collectr** (TCG portfolio). It has a clean finance-app look and portfolio value plus a trend chart. A "biggest movers" view sits behind IAP ([mydextcg comparison](https://mydextcg.com/compare/mydex-vs-collectr), [JustUseApp](https://justuseapp.com/en/app/1603892248/collectr-tcg-collector-app/reviews)) [REPORTED]. Our 9/9 competitor research found the top gripes were a 35-lifetime-scan cap, JP mis-attribution and NM×haircut condition pricing. **Lesson:** the finance skin earns installs, but pricing trust and scan limits decide retention.
- **Card Ladder** (sports). Its CL50 market index plus sales-volume chart is credible because it **filters outlier/manipulated sales** and shows volume next to price ([App Store](https://apps.apple.com/app/id1541535971), [cllct on eBay adopting CL Index](https://www.cllct.com/sports-collectibles/memorabilia/ebay-to-add-card-ladder-data-to-its-price-guide)) [REPORTED]. **Lesson:** a volume strip under the price chart is the collectibles-native addition Robinhood lacks. We already have sales bars in chart mode.
- **Alt.** Alt Value comes with a **confidence bar (High/Med/Low)** tied to sale frequency, plus a value range when data is sparse ([Alt support](https://support.alt.xyz/en/articles/9213564-alt-value-confidence-levels), [How Alt Value works](https://www.alt.xyz/blog/how-alt-value-works)) [DOC]. **Lesson:** this is the best existing answer to "illiquid price honesty". Copy the idea (build #8).
- **PriceCharting.** It shows ungraded/7–9.5/PSA 10 side by side with a **volume frequency label** ("3 sales per year", "rare") ([example page](https://www.pricecharting.com/game/pokemon-sealdass-fancy-graffiti/pikachu-and-others-10)) [DOC]. **Lesson:** label liquidity in words, not just numbers.
- **StockX** ("stock market of things"). Live bid/ask, last sale, 12-month history, 52-week high/low ([StockX](https://stockx.com/news/fr-fr/stockx-launches-watches-and-handbags), [Fortune 2016](https://fortune.com/2016/08/23/stock-market-for-sneakers/)) [REPORTED]. **Lesson:** "last sale" plus "lowest ask" is more honest than a single "value". Our PDP already has recent-sales and lowest-listed panels; surface "Last sale $X · 4d ago" under the headline for graded lanes.
- **Rally / Otis / Collectable** (fractional shares). Collectable halted secondary trading in 2024. Otis was acquired by Public and liquidated its offerings ([Angel Investors Network](https://angelinvestorsnetwork.com/alternative-investments/fractional-collectibles-investing-platforms-compared-2026), [SI](https://www.si.com/collectibles/news/fractional-investing-in-sports-cards-has-been-a-failure)) [REPORTED]. Rally's status is disputed. **Lesson:** making cards *literally tradable like stocks* failed. The finance *presentation* survives; the finance *mechanics* did not.
- **Courtyard / digital repacks.** Instant buyback at ~85–93% FMV, with an unpublished value model ([Datawallet](https://www.datawallet.com/crypto/best-platforms-to-buy-pokemon-cards-with-crypto), [GoCollect](https://gocollect.com/blog/graded-vaulted-and-virtual)). Users call it "gambling with extra steps" ([Trustpilot](https://www.trustpilot.com/review/courtyard.io?page=3)), and the category faces gambling lawsuits ([on360](https://on360.ca/?p=920)) [REPORTED]. **Lesson:** no rip-reveal-with-price-flash UX. If we ever show pack EV (the what-to-buy plan), present it as a sober distribution ("most packs return $1–3") and never as a reveal.
- **Ludex** (scanner plus portfolio). Its value tracking over time runs on a proprietary algorithm, and reviews are mixed on ID accuracy ([JustUseApp](https://justuseapp.com/en/app/1616691213/ludex-scan-sports-cards-tcg/reviews)) [REPORTED]. **Lesson:** accuracy is the floor. No chart polish rescues a wrong ID.

---

## Appendix D — Card-specific problems and the proposed rule for each

1. **Illiquid, daily prices vs "live".** Never imply real time. Show a solid dot with "as of". Pulse only on a witnessed change. Chart granularity is never finer than one day. 1D is not a range we offer (correct today).
2. **What is "the price"?** The headline is always the selected **lane** (variant × condition-or-grade × language), declared in a chip under the number. The Collection total uses each entry's owned lane (already the case). The PDP default lane follows existing seeding: owned, then Normal, then first. Switching the lane rolls the ticker and morphs the chart, which makes the switch legible.
3. **Noisy, sparse sales.** On graded lanes, draw **dots for actual sales** connected by a thin line, with no smoothing or curve that overshoots between sales. Mark outliers that the PPT verification tier already hides as hollow dots (or omit them). Add a volume strip. With fewer than 3 points, show a sales list instead of a line.
4. **Collection value vs. realizable value.** Show the headline as the market total, with the quick-sell line under it (#7) and cost basis as an optional baseline (A2). Never call it "profit" until sold.
5. **Gambling vibes.** No confetti, streaks or scratch-reveal. No action-colored buy buttons. No "most scanned" social proof. Alerts are opt-in and informational. Pack EV, if built, is a distribution and never a reveal. The MA consent order is the checklist of what to avoid ([Tearsheet](https://tearsheet.co/?p=59230)).
6. **Vendor speed.** A dense mode (A14): $-first rows, no theme wash, ticker roll shortened to about 200 ms or off. At a show the number must be *readable*, not *entertaining*.

---

## Appendix E — Code-fit notes (read-only skim)

- `apps/spotlight-rn/src/features/portfolio/components/portfolio-chart-card.tsx` (1212 lines) is a react-native-svg chart with a hand-rolled responder plus a long-press scrub lock. It plays `Haptics.impactAsync(Light)` on lock, has corner-trimmed path building, a dashed guide (`strokeDasharray [4,4]`), a sales-bar mode with `salesCount`, and a `MEANINGFUL_BASELINE_VALUE` guard. Extract the path and scrub math into a reusable core before building the PDP hero (#3). The scrub currently lives on the JS thread via responder events. For the morph and the ticker, keep animated values in Reanimated shared values, so the scrub stays smooth when the ticker is added.
- `portfolio-balance-header.tsx` renders the total as a plain `Text`, with an eye toggle (privacy) and a colored delta row with an arrow icon. Swap the `Text` for `<RollingNumber>`. When the eye toggle hides the value, render a masked string with no roll.
- `card-price-trend-list.tsx` has per-lane 62×22 sparkline rows. Keep them as the "lane picker with previews" under the new hero chart. Tapping a row selects that lane (rolls the ticker, morphs the chart).
- `card-detail-hero.tsx` already uses Reanimated `useAnimatedStyle`.
- `packages/design-system/src/tokens.ts` has `green400 #4CAF6E` / `red400 #E0524C` and several delta ramps. Consolidate into semantic `trend.up/down/neutral` (+ `accessible` variants), and add a `motion` token group (durations and easings from Appendix B). Per CLAUDE.md, Figma is the source of truth, so mirror these in Figma first.
- Deps: reanimated 4.2.1, worklets 0.7.4, gesture-handler 2.30, svg 15.15, expo-haptics 55 are **present**. **Skia is absent** (native build needed; build #13 only). Reanimated provides `useReducedMotion()`; only the trend skeleton checks reduce-motion today.

---

## Sources

Robinhood primary:
- [robinhood/ticker (GitHub)](https://github.com/robinhood/ticker) · [robinhood/spark (GitHub)](https://github.com/robinhood/spark)
- [Google Design: Robinhood investing material](https://design.google/library/robinhood-investing-material)
- [Robinhood newsroom: the top-secret design story](https://robinhood.com/newsroom/the-top-secret-robinhood-design-story) · [A new visual identity (2024)](https://robinhood.com/newsroom/a-new-visual-identity) · [2020 identity](https://robinhood.com/newsroom/a-visual-identity-that-better-reflects-our-vision/) · [Gold Card](https://robinhood.com/us/en/newsroom/the-new-gold-standard-introducing-the-robinhood-gold-card/)
- Support: [Using charts](https://robinhood.com/support/articles/using-charts) · [Advanced charts](https://robinhood.com/us/en/support/articles/using-advanced-charts) · [Legend widgets](https://robinhood.com/us/en/support/articles/widgets-in-robinhood-legend) · [Price alerts](https://robinhood.com/support/articles/price-alerts) · [Lists/watchlists](https://robinhood.com/us/en/support/articles/lists) · [Accessibility options](https://robinhood.com/us/en/support/articles/accessibility-options) · [Legend](https://robinhood.com/us/en/legend)

Confetti / gamification:
- [CNBC 2021-03-31](https://www.cnbc.com/2021/03/31/robinhood-gets-rid-of-confetti-feature-amid-scrutiny-over-gamification.html) · [Tearsheet](https://tearsheet.co/?p=59230) · [WealthManagement](https://www.wealthmanagement.com/regulation-compliance/robinhood-pays-7-5m-to-settle-massachusetts-gamification-charge) · [Insurance Journal](https://www.insurancejournal.com/news/east/2024/01/19/756246.htm) · [InvestmentNews](https://www.investmentnews.com/robinhood-drops-the-confetti-but-advisers-arent-convinced-204828)

Typography / brand (secondary):
- [Design Compass 2024 rebrand](https://designcompass.org/en/2024/10/18/robinhood-rebranding) · [1000logos](https://1000logos.net/news/robinhood-an-identity-for-a-mature-brand) · [Porto Rocha](https://www.portorocha.com/robinhood) · [Pratt IxD critique](https://ixd.prattsi.org/2025/02/design-critique-robinhood-ios-app/)

Platform guidance and libs:
- [Apple HIG: Playing haptics](https://developer.apple.com/design/human-interface-guidelines/playing-haptics) · [react-native-wagmi-charts](https://github.com/coinjar/react-native-wagmi-charts) · [react-native-graph (Margelo)](https://github.com/margelo/react-native-graph)

Collectibles:
- [Alt confidence](https://support.alt.xyz/en/articles/9213564-alt-value-confidence-levels) · [How Alt Value works](https://www.alt.xyz/blog/how-alt-value-works) · [Card Ladder App Store](https://apps.apple.com/app/id1541535971) · [cllct: eBay + Card Ladder](https://www.cllct.com/sports-collectibles/memorabilia/ebay-to-add-card-ladder-data-to-its-price-guide) · [PriceCharting example](https://www.pricecharting.com/game/pokemon-sealdass-fancy-graffiti/pikachu-and-others-10) · [Collectr vs MyDex](https://mydextcg.com/compare/mydex-vs-collectr) · [Collectr reviews](https://justuseapp.com/en/app/1603892248/collectr-tcg-collector-app/reviews) · [StockX](https://stockx.com/news/fr-fr/stockx-launches-watches-and-handbags) · [Fortune on StockX](https://fortune.com/2016/08/23/stock-market-for-sneakers/) · [SI on fractional](https://www.si.com/collectibles/news/fractional-investing-in-sports-cards-has-been-a-failure) · [Angel Investors Network fractional](https://angelinvestorsnetwork.com/alternative-investments/fractional-collectibles-investing-platforms-compared-2026) · [cllct digital repacks](https://www.cllct.com/sports-collectibles/sports-cards/how-do-digital-repacks-work-cllct-offers-its-guide-to-hobby-s-hottest-trend) · [on360 repack lawsuits](https://on360.ca/?p=920) · [GoCollect Courtyard](https://gocollect.com/blog/graded-vaulted-and-virtual) · [Courtyard Trustpilot](https://www.trustpilot.com/review/courtyard.io?page=3) · [Ludex reviews](https://justuseapp.com/en/app/1616691213/ludex-scan-sports-cards-tcg/reviews)

**Gaps / verify on device:** per-point scrub haptics, the tap-to-toggle price button, pulsing-dot behavior and exact morph timing in the current RH iOS app are not documented anywhere I could find. They are marked [INFERENCE] above. A 10-minute screen recording of the current Robinhood app, with haptics noted by hand, would settle them.
