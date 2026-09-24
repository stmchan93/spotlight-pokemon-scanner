# Meta, trends and news feed: plan (2026-09-23)

Status: PLAN + MOCKUP ONLY. Nothing built. Mockup canvas: https://claude.ai/artifact/CHc1V3nYsSSUm4p8q5RU38
Builds on `docs/meta-radar-research-2026-09-09.md` (source research) and `docs/listing-feed-concept-2026-08-28.md`.

## Plain-English summary

Make the feed feel alive with four things, all at zero added cost. **No new tabs**: they all live in the existing Social tab as scrollable blocks, and each block's "See more ›" link opens a full page on top (like opening a card page).

1. **Meta pulse → Meta page**: which groups of cards are rising or cooling **in price** (vintage low-pop PSA 10s, Gold Stars, SIRs, JP promos, and so on), with raw and graded shown as separate rows, total $ value change, and one auto-written headline.
2. **Hot on Ekalight**: the cards people are checking and scanning right now. This is the only traffic-based block and it stays hidden until enough people use the app.
3. **Set spotlight**: the top 10 cards in a set (by price, biggest movers or most checked), plus videos and news about that set.
4. **News & videos**: headlines from free RSS feeds and YouTube, tagged to games, sets and cards, linking out to the source.

The friend's "Twitter feed of San Mateo Costco people" idea is dropped: X charges per read and location search is gone.

## How Meta pulse works (price-driven)

Nightly job, no new data sources:

1. **Tag each card into groups**: era from set release date (e.g. vintage = before 2003), rarity bucket, language, and for slabs the grader + grade + PSA pop band (pop from `card_price_snapshots.population_json`).
2. **Raw price change**: TCGplayer main price via TCGCSV (`card_price_history_daily`), today vs 7/30 days ago, same printing, same source (the `market_movers.py` pairing rule).
3. **Graded price change**: Scrydex graded prices per grader/grade (`card_price_history_cell`, lane `graded`), written by the daily Scrydex sync we already pay for. **TCGCSV has no graded prices**; TCGplayer only prices raw.
4. **Per group**: median % change among cards whose price actually moved in the window (low-pop slabs sell rarely, so unchanged cards are skipped and the median stops one odd sale swinging it), plus the summed $ value change.
5. **Pick** the biggest risers/fallers above a minimum card count; fill the headline template.
6. **Popularity (optional, later)**: share of distinct users checking each group, added once traffic is big enough to trust.

Graded caveats:
- **Staging writes no graded history by design**; only prod does. Test against prod data or turn graded writes on for staging for a while.
- Graded coverage is mainly Pokémon (Scrydex also has Lorcana graded); pop counts are Pokémon only. Other games are raw-only for now.
- PPT graded signals are overwritten daily (no history) and are not used for trends.

## Have vs need

| Piece | Have | Need | Added cost |
|---|---|---|---|
| Raw group price change (median %, $ value) | TCGCSV raw history (`card_price_history_daily`), same-source pairing in `backend/market_movers.py` | GROUP BY group job, losers as well as gainers | $0 |
| Graded group price change | Scrydex graded history (`card_price_history_cell` lane `graded`), **prod only** | same job over graded cells; "price moved in window" filter | $0 |
| Segment attributes | release date, rarity bucket (`catalog_tools.rarity_bucket`), language, lane/grader/grade | "Era" derived from release date (no column) | $0 |
| Low-pop filter | `card_price_snapshots.population_json` (PPT/GemRate, Pokémon only, daily) | none | $0 |
| Pop growth over time | overwritten daily | new daily pop snapshot table | $0 (already downloaded) |
| Sales velocity | PPT export already downloaded | parse `salesVelocityWeekly` / `marketTrend` | $0 |
| Most checked / share of checks | `card_views` (1 row per user per card per day, signed-in only), `scan_events`, `card_favorites`, `deck_entry_events` | distinct-user counts per card and segment; floor + per-user cap so one vendor can't dominate | $0 |
| Viral | movers + attention | 7d vs prior-7d join | $0 |
| Set top 10 | snapshots + expansions | price-sorted endpoint | $0 |
| News | nothing | RSS poller + tagger | $0 |
| Videos | nothing | YouTube Data API v3 free key (10k units/day; `search.list` 100/day) | $0 |
| Tournament meta | nothing | Limitless API (free) | $0 |
| Headline text | none | fill-in-the-blanks template from the numbers (no LLM) | $0 |

90-day windows are limited until the TCGCSV lane has 90+ days of history (it has ~32 on staging).

## Verified free sources (checked 2026-09-23)

- **News:** PokéBeach front-page RSS (browser UA needed; `/feed` 403s), DotGG per-game `/category/news/feed/` (onepiece.gg, lorcana.gg, riftbound.gg, gundamcard.gg; NOT the root feeds, which carry spam), Polygon Pokémon RSS, Dexerto Pokémon RSS (keyword-filter both for TCG).
- **Market:** TCGplayer Seller Blog `price-trends` tag RSS (weekly "cards climbing in price" posts, game tags); Elite Fourum Discourse RSS (vintage/low-pop chatter).
- **Video:** YouTube Data API with a free key. Channel RSS was returning 404/500/empty for most channels during this check, so treat it as a fallback only.
- **Rejected:** Google News RSS (robots disallow), PriceCharting / Card Ladder / PSA (Cloudflare 403), PokeGuardian / Serebii / Limitless blog / Pokémon.com (no feed), TCGplayer Infinite internal API (unsanctioned), Reddit (policy; internal signal at most).

Rules: show headline + source + thumbnail + link-out only; never copy article text. Hourly poll with ETag/Last-Modified; alert on 403s and empty YouTube responses.

## Tagging news to game / set / card

Game from the source first (domain, TCGplayer tag). Set by longest-match against a nightly alias table from `expansions` (names + codes); ambiguous one-word set names only with a game keyword. Card by `\d{1,3}/\d{2,3}` or set-code+number, else name match within the matched set. Store `(item_id, game, set_id?, card_id?, confidence)`.

## Suggested order

1. Meta pulse + Meta page: raw and graded groups + headline template (own data, price only).
2. Hot on Ekalight (own data; gated on minimum distinct users).
3. Set spotlight top 10 (own data) — videos/news slot in later.
4. RSS news poller + tagger.
5. YouTube Data API videos.
6. Pop snapshots + PPT velocity persistence (unlocks "pop growth" and "sales velocity" segments).
7. Limitless tournament meta.

## Open questions

- DECIDED 2026-09-23: no new tabs. Blocks in the Social feed + pages that open from them.
- Staging testing for graded groups: turn on graded history writes on staging, or test against a prod snapshot.
- Minimum distinct users before a card can appear in Hot on Ekalight (small user base today).
- Whether to count signed-out views (currently not logged).

## Build plan (2026-09-23)

Feed order (user decision): **Meta pulse → Hot on Ekalight → Set spotlight → Top Trends (existing) → Card news → posts.**

Pattern for every block (same as Top Trends): a nightly/periodic backend job computes a small result and stores it; the feed reads a cached payload. No heavy queries at request time (27.5M-row cells table lesson), no index builds at startup.

| # | Piece | Backend | App | Estimate |
|---|---|---|---|---|
| 1 | Meta pulse + Meta page | group tagger (era, rarity bucket, language, grader/grade, pop band); nightly job over raw (TCGCSV) + graded (Scrydex cells) 7/30d pairs → median %, $ value, card count, top cards per group; `meta_groups_daily` table; `GET /api/v1/market/meta`; headline template; turn on graded history writes on staging | Meta pulse block + Meta page (filters, groups table, raw-vs-graded ladder, driving cards) | 5-7 evenings |
| 2 | Hot on Ekalight | distinct-user counts from `card_views` + `scan_events`, 24h vs trailing baseline, per-user cap, minimum-users gate (block hidden below it) | rail block | 2 evenings |
| 3 | Set spotlight | weekly set pick (biggest value move among sets with enough priced cards), top-10 by price / movers / PSA 10 | block + set page (video/news slots empty until #5/#6) | 3 evenings |
| 4 | Top Trends | exists | move below Set spotlight | <1 hour |
| 5 | Card news | RSS poller (hourly, ETag) + game/set/card tagger + `news_items` table + endpoint | news block + News page | 3-4 evenings |
| 6 | Videos | YouTube Data API (free key) channel uploads + weekly set search, cached | video rows in Set page / News | 2 evenings |

Core (1-4): about 2 weeks of evenings. With news + videos: about 3-4 weeks. Ship each block to staging behind a feature flag as it lands; prod only with explicit approval.
