# Market Analytics tab — backend contract and definitions (2026-11-23)

Owner goal: a Market Analytics tab, with a game picker, for collectors checking
their stuff and for deal hunters. Code: `backend/market_analytics.py` (job,
reads, price position), routes in `backend/server.py`, client types and
methods in `packages/api-client/src/spotlight/{types,repository,market-analytics-wire,market-analytics-mock-data}.ts`.
Tests: `backend/tests/test_market_analytics.py`,
`apps/spotlight-rn/__tests__/repository/market-analytics-repository-test.ts`.

## Endpoints

| Route | Auth | Returns |
| --- | --- | --- |
| `GET /api/v1/market/analytics?game=&window=` | public; a signed-in (non-guest) caller also gets `you`, `yourMovers` and `grading[].owned` | `MarketAnalytics` |
| `GET /api/v1/market/heatmap/set?game=&setId=&window=` | public | `MarketHeatmapSet`, 404 when the set has no stored zoom |
| `GET /api/v1/cards/{cardId}/price-position?variant=&condition=&grader=&grade=` | public | `CardPricePosition`, 204 when there is not enough trustworthy data, 404 for an unknown card |

`game` is any of `SUPPORTED_GAMES` (default `pokemon`); `window` is `7d`, `30d`
(default) or `90d`. A bad token on `/market/analytics` is a 401; no token, an
anonymous (guest) session, or an access-gated user reads as a guest
(`you: null`). Client methods: `getMarketAnalytics({game, window})` (throws on
failure, like `getTopMovers`), `getMarketHeatmapSet({game, setId, window})`
(null on 404), `getCardPricePosition({cardId, variant, condition, grader, grade})`
(null on 204/404).

Shapes are exactly the contract in the task brief (camelCase). Two nullability
notes the UI must handle: `pulse.changePct`/`indexValueUsd`/`breadth.upPct`,
heatmap/list `changePct`, and `you.changePct`/`you.beatsMarket` can be `null`
(thin data, a card that can't be compared over the window, or a collection
without price history). A game with thin data returns the full shape with empty
lists, never an error.

## How it runs

- `market_analytics.refresh_market_analytics` is the daily job. It runs on the
  existing ops prewarm hook (`/api/v1/ops/prewarm-portfolio`), in the same
  thread right after `price_lows` (breakingOut reads its new-highs table):
  `SpotlightScanService.refresh_market_signals`. CLI:
  `python backend/market_analytics.py --compute --database-path <db> [--force] [--as-of YYYY-MM-DD]`.
- It writes one JSON payload per (game, window) to `market_analytics`, one per
  (game, window, set) to `market_analytics_sets`, and its version to
  `market_analytics_runs`. Version token = the price_lows token (newest price
  date + `pricing_sync_generation`) + the 90-day `price_highs` run version + the
  Market Watch (meta_pulse) run token + the grading fee + the stale-days rule.
  An unchanged version is a no-op.
- Requests only read those tables (plus an in-process cache keyed on the
  version). When the stored version is behind the inputs (e.g. Market Watch ran
  later), the request keeps serving the stored payload and kicks ONE
  background refresh (at most every 15 minutes). Nothing runs at startup.
- No Scrydex or other paid calls anywhere: everything is read from SQLite.

## Price rules (apply to every number)

- USD only. One source per card: the TCGplayer (TCGCSV) main lane when the card
  has a main price now, else Scrydex default-raw for non-Japanese USD rows.
  Scrydex raw-JP values are yen anchors and are never used (Japanese cards only
  appear with TCGplayer USD). Same printing (`main_raw_variant`) at both ends
  of any change (`market_movers._usd_pair`).
- `price_quality` withholds a card everywhere: stale (no observation in 14 days)
  or untrusted (raw above the same card's own PSA 10).
- A then-to-now pair moving more than 3x either way is a data glitch and is
  left out of changes (the card's current value still counts in set totals).
- "Then" = the newest row within the tolerance before the window start
  (7d: 2 days, 30d: 7, 90d: 14), so every `changePct` spans the full window.
- Market-wide lists (index, breadth, bargains, breaking out, grading) use the
  collectibility filter from `mcp_server/tools.py`: no basic/bulk Energy or
  Common/Uncommon Trainers (premium rarities stay), image required, and the
  $10 floor (`COLLECTIBLE_MIN_PRICE_USD`).

## Definitions

- **Market Index (`pulse.index`, added 2026-11-23)**: `backend/market_index.py`.
  Per game: the top 100 English raw singles (no sealed, no Japanese,
  collectible, >= $10) by price as of the selection day, each with no >3x
  day-to-day step in the 30 days before it. Basket FIXED per calendar month
  (picked on the 1st, held all month). Equal-weighted: each day = yesterday x
  mean of every member's price ratio vs yesterday (last price carried forward,
  single-point glitches dropped). Chain-linked: on the 1st the old basket sets
  the level, the new one moves it from the 2nd. Base 100 on the first day of
  stored history within a year (a game whose prices start later begins on its
  first 1st with >= 20 cards). Tables `market_index_daily`,
  `market_index_baskets`, `market_index_runs`; refreshed at the top of
  `refresh_market_analytics` (backfill once, then resume from the latest
  basket). CLI: `python backend/market_index.py --compute --database-path <db>
  [--game pokemon] [--force]`. Payload: `{name, points, value, changePct,
  rangeLow, rangeHigh, basketSize, rebalancedOn}` over the window (<= 60
  points; change = last vs first point); `null` when there is no index yet.
  `window` also accepts `1y` (set movers / bargains are empty there: Market
  Watch stores 7/30/90 only). The legacy dollar basket fields below stay for
  older app builds.
- **Market index (`pulse`)**: a value basket of the game's top **200** priced
  collectible singles (by current price, sealed excluded) that have a
  same-source price at the window start and no >3x day-to-day step in the
  window. `indexValueUsd` = the basket's current total; `changePct` = basket
  total now vs at the window start (fixed basket, value-weighted). `sparkline`
  = the basket's daily total (each card's last price carried forward), ~30
  points, first point = window-start total, last = now.
- **Breadth**: every liquid single (collectible, >= $10 now) priced at both
  ends of the window. Up = change > +1%, down < -1%, else flat; `upPct` =
  up / all.
- **Heatmap**: the game's top **40** sets by `totalValueUsd` = sum of current
  prices of the set's priced singles (quality-passed, sealed excluded; no
  collectibility filter: it is the whole set's value). `changePct` = sum now
  vs sum then over the set's cards priced at both ends. `cardCount` = priced
  singles. The zoom (`/heatmap/set`) is that set's top **40** cards by price.
- **Bargains** (≈12): liquid cards in the bottom **20%** of their own recent
  range, whose set basket is flat or rising. Range = the last **90 days**
  (regardless of the selected window; needs >= 30 days of the card's prices
  and a spread (high - low) / high of at least 15%). `position.percentile` =
  (price - low) / (high - low) x 100. The set rule reads Market Watch's
  per-set basket (meta_pulse `set_index`, top-10 basket change over the
  selected window): change >= -3% (Market Watch's flat band) counts as flat or
  rising; a card whose set has no basket is left out. Series guards: >= 3
  distinct prices and no >3x step. Ranked lowest percentile first, then
  pricier; one card per name+set. `changePct` is over the selected window.
- **Breaking out** (≈10): the `price_highs` table (`find_new_highs`, 90-day
  window: now at a 90-day high first reached in the last 7 days, >= 15% above
  the window low, series guards) through the same collectibility and quality
  gates. `previousHighUsd` = the highest price before that 7-day span;
  `sparkline` = the card's prices over the selected window.
- **Sets rising / falling** (5 each): Market Watch set baskets (meta_pulse
  `set` segment, the same data `get_market_trends` uses): English main sets,
  top-10 basket change with the breadth and one-chase-card gates.
- **Card movers (`cardsRising` / `cardsFalling`, added 2026-11-24)**: up to
  **20** each, per game and window (1y included). The game's priced singles
  (sealed excluded) with a same-source window-start price, collectible, and
  **>= $5 at both ends** (`MOVERS_MIN_PRICE_USD`, so penny cards can't post
  +300%); Japanese cards only on the TCGplayer main lane; one card per
  name+set. Rising = `changePct > 0` desc, falling = `< 0` asc. Each item is a
  card tile + `priceUsd`, `thenPriceUsd`, `changePct`, `changeUsd` (2dp). These
  drive the redesigned tab ("Moving in <game>", Rising | Falling, 10 rows +
  "Show 10 more"); `pulse`/`setsRising`/etc. stay in the payload for older
  app builds.
- **Your movers (`yourMovers`, request-time, added 2026-11-24)**: null for
  guests. Signed in: the same cached portfolio summary as `you`
  (`get_portfolio_summary` `top_gainers` / `top_losers`, ranked by the
  holding's `change_usd`), filtered to cards whose `cards.game` is the
  requested game, sealed excluded, <= 5 each: card tile + `quantity`,
  `priceUsd` (one copy now), `changeUsd` (whole holding), `changePct`. Null
  when both lists are empty. The summary keeps only the top 5 across ALL
  games, so a multi-game collection can show fewer than 5 for a game.
- **Grading** (≈10): the card's own PSA 10 (same printing as its raw price;
  when the raw price's printing is unknown, only a card with a single PSA 10
  printing compares) minus raw minus a flat fee. PSA 10 = the newest graded
  cell day within 7 days, else snapshot graded contexts refreshed within 14
  days (find_top_graded's rule); placeholder ($99,999) and outlier graded
  prices are dropped (`_graded_distrust_reason`); Japanese cards excluded
  (Scrydex JP graded values can be yen). `feeUsd` = `MARKET_GRADING_FEE_USD`
  (env, default **$30**: one flat assumption covering a value-tier submission;
  no shipping, no grade risk). Only `netGainUsd > 0`, sorted desc. The $10
  collectibility floor applies to the PSA 10 price (the item's headline), not
  the raw price: a $4 raw with a $120 PSA 10 is exactly what this list is for.
  Games without graded pricing return `[]`. `owned` is filled per request.
- **You**: the caller's collection move over the window from the assistant's
  portfolio summary (`get_portfolio_summary`): the market move of the cards
  currently held, from each card's add day if added mid-window, buys/sells
  excluded, so it is comparable to the index. `valueUsd` = current collection
  value; `beatsMarket` = `changePct > marketChangePct`. Null for guests and
  empty collections. Cached per (owner, window) on the dashboard + price
  version tokens.
- **Card price position**: raw (default) = the card's main-lane series for the
  requested printing (else its newest printing; Scrydex default-raw for
  non-Japanese USD when it has no main lane); `condition` LP/MP/HP/DMG = the
  Scrydex raw condition cells (USD); `grader`+`grade` = the graded cells for
  that printing (newest printing when none is given). Range = the largest of
  1 year / 90 days / 30 days that the card's own history covers (label "past
  year" / "past 90 days" / "past 30 days"); a card with less than 30 days gets
  its whole history (>= 14 days) labelled "recently". Single-point spikes (>3x
  both neighbours) are dropped; null (204) when the newest point is stale,
  teleported from the one before, raw is above its own PSA 10, fewer than 3
  distinct prices, or no spread.

## Windows and labels

`window` 7d/30d/90d. `windowLabel` is "past week" / "past 30 days" / "past 90
days" when stored history covers the window (starts within 2/7/7 days of its
start), else "recently" — never how much history exists. No field carries
coverage counts, and no field uses prediction or "buy" language.

## Performance (synthetic staging-size DB)

Measured 2026-11-23 on a synthetic DB (45k cards in 400 sets across 3 games,
220 days of daily rows = 9.9M rows, 70% main lane, 15k PSA cells; 4.3 GB),
M-series laptop:

- Job (`refresh_market_analytics`, all games x 3 windows, 15 payloads + set
  zooms): **35 s** (price_lows on the same DB: 27 s; meta_pulse: 37 s).
- `GET /market/analytics` service read: cold (first read after a refresh)
  ~1 ms, warm median **0.3-0.5 ms** (version check + in-process cache);
  payload 19-29 KB.
- `GET /market/heatmap/set`: median 0.08 ms.
- `GET /cards/{id}/price-position`: median 0.8 ms, max 1.7 ms (one indexed
  per-card read of up to a year + one price_quality read).
- `you` (signed in) adds `get_portfolio_summary` on a cache miss (per owner,
  window, dashboard/price version), then ~0 on hits.

On the (stale, thin) local DB copy with `--as-of 2026-05-11` the job takes 1.1 s.
