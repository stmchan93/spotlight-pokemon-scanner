# Meta feed: API contracts (2026-09-23)

Shared contract between the backend modules and the RN app for the feed blocks in
`docs/meta-trends-news-feed-plan-2026-09-23.md`. Mockups: `docs/meta-feed-mockup/*.dc.html`
(Main = Social feed, Meta = Meta page, Set = Set page, News = News page).

Feed order on the Social tab: **Meta pulse → Hot on Ekalight → Set spotlight → Top Trends → Card news → posts.**

All payloads are camelCase JSON. Money is USD (`currencyCode: "USD"`). Percent values are signed
percents (`12.5` = +12.5%). Every endpoint is GET, cached server-side from a precomputed table,
and returns `404 {"error": "disabled"}` when its feature flag is off. The app hides a block on 404,
on network error, or when its list is empty. Games use the existing `CardGame` values.

## TypeScript types (add to `packages/api-client/src/spotlight/types.ts`)

```ts
export type MetaLane = 'raw' | 'graded';
export type MetaLaneFilter = 'all' | MetaLane;

export type MetaCard = {
  cardId: string;
  game: CardGame;
  name: string;
  number: string | null;
  setName: string | null;
  imageUrl: string | null;
  lane: MetaLane;
  grader: string | null;        // 'PSA' | 'CGC' | 'BGS' ... (graded only)
  grade: string | null;         // '10', '9.5' ... (graded only)
  population: number | null;    // pop at this grade (Pokémon graded only)
  priceNow: number;
  priceThen: number;
  changePercent: number;
  currencyCode: string;
};

export type MetaGroup = {
  groupKey: string;             // stable id, e.g. 'vintage:graded:psa10:pop_le_50'
  label: string;                // 'Vintage PSA 10 · pop ≤ 50'
  lane: MetaLane;
  description: string;          // 'pre-2003 · 1,840 cards'
  medianChangePercent: number;  // median over cards whose price moved in the window
  valueNow: number;             // sum of market prices now
  valueThen: number;
  valueChangeUsd: number;
  cardCount: number;            // cards in the group with a price at both ends
  movedCardCount: number;       // of those, how many actually changed price
  sparkPoints: number[];        // group value index, oldest → newest, ≤ 30 points
  topCards: MetaCard[];         // ≤ 5 biggest contributors, same direction as the group
};

export type MetaLadderRung = { label: string; lane: MetaLane; medianChangePercent: number };
export type MetaLadder = { title: string; rungs: MetaLadderRung[] };  // e.g. 'Vintage: raw vs graded'

export type MetaPulse = {
  game: CardGame;
  windowDays: number;           // 7 | 30 | 90
  lane: MetaLaneFilter;
  availableWindows: number[];   // windows with enough history
  availableGames: CardGame[];
  computedAt: string;
  asOfDate: string | null;
  headline: { title: string; body: string };   // filled from a template, no LLM
  summary: {
    rawValueChangePercent: number | null;
    rawValueChangeUsd: number | null;
    gradedValueChangePercent: number | null;   // null when no graded history (e.g. staging before graded writes)
    gradedValueChangeUsd: number | null;
    risingCount: number;
    coolingCount: number;
  };
  groups: MetaGroup[];          // sorted by medianChangePercent desc (risers first, then coolers)
  ladders: MetaLadder[];
};

export type HotCard = {
  cardId: string;
  game: CardGame;
  name: string;
  number: string | null;
  setName: string | null;
  imageUrl: string | null;
  distinctUsers: number;        // distinct signed-in users who viewed or scanned it in the window
  baselineRatio: number;        // window rate / trailing baseline rate, e.g. 4.2
  priceNow: number | null;
  changePercent7d: number | null;
  currencyCode: string;
};

export type HotCards = {
  computedAt: string;
  windowHours: number;          // 24
  minDistinctUsers: number;
  eligible: boolean;            // false → not enough traffic; items is []
  items: HotCard[];             // ≤ 10
};

export type SetSpotlightCard = {
  cardId: string;
  name: string;
  number: string | null;
  imageUrl: string | null;
  lane: MetaLane;
  grader: string | null;
  grade: string | null;
  priceNow: number;
  changePercent7d: number | null;
  currencyCode: string;
};

export type SetSpotlight = {
  computedAt: string;
  set: {
    setId: string;
    game: CardGame;
    name: string;
    code: string | null;
    series: string | null;
    releaseDate: string | null;
    logoUrl: string | null;
    cardCount: number;
    valueNow: number;                    // sum of raw NM market prices
    valueChangePercent7d: number | null;
    psa10ValueNow: number | null;        // sum of PSA 10 prices where known
    psa10ChangePercent7d: number | null;
    collectorsCount: number;             // distinct users with a card from the set in their collection
  };
  topByPrice: SetSpotlightCard[];        // ≤ 10, raw
  topMovers: SetSpotlightCard[];         // ≤ 10, raw, by |changePercent7d|
  topPsa10: SetSpotlightCard[];          // ≤ 10, graded PSA 10
  callout: { cardId: string; title: string; body: string } | null;   // "Umbreon ☆ PSA 10 is up 14% this week"
  videos: NewsItem[];                    // kind 'video', tagged to this set (may be [])
  news: NewsItem[];                      // non-video items tagged to this set (may be [])
};

export type NewsKind = 'news' | 'market' | 'video' | 'community';

export type NewsItem = {
  id: string;
  kind: NewsKind;
  source: string;               // 'PokéBeach', 'onepiece.gg', 'TCGplayer Seller Blog', 'YouTube · PokeRev'
  title: string;
  url: string;                  // link-out target
  imageUrl: string | null;
  publishedAt: string;
  game: CardGame | null;
  setId: string | null;
  cardIds: string[];
  tags: string[];               // 'Set reveal', 'Ban list', 'Market', ...
  video: { channelTitle: string; durationSeconds: number | null; viewCount: number | null } | null;
};

export type NewsFeed = { items: NewsItem[]; nextCursor: string | null };
```

## Endpoints

| Endpoint | Query | Returns | Flag (env) |
|---|---|---|---|
| `GET /api/v1/market/meta` | `game` (default `pokemon`), `window` (7\|30\|90, default 7), `lane` (all\|raw\|graded, default all) | `MetaPulse` | `META_PULSE_ENABLED` |
| `GET /api/v1/market/hot` | `game` (optional; omitted = all games) | `HotCards` | `HOT_CARDS_ENABLED` |
| `GET /api/v1/market/set-spotlight` | — (this week's pick) | `SetSpotlight` | `SET_SPOTLIGHT_ENABLED` |
| `GET /api/v1/market/sets/{setId}/spotlight` | — | `SetSpotlight` | `SET_SPOTLIGHT_ENABLED` |
| `GET /api/v1/feed/news` | `game`, `kind`, `setId`, `cardId`, `limit` (≤ 50, default 20), `cursor` | `NewsFeed` | `NEWS_FEED_ENABLED` |

Flags default OFF in code and are turned on per environment in the env files.

## Backend module ownership

- `backend/meta_pulse.py` — group tagging, nightly compute into `meta_pulse_groups` (+ card rows), payload builder.
- `backend/hot_cards.py` — distinct-user attention counts, gating, payload builder.
- `backend/set_spotlight.py` — weekly set pick + per-set payload builder.
- `backend/news_feed.py` — RSS polling, tagging, `news_items` storage, payload builder.
- `backend/youtube_feed.py` — YouTube Data API ingestion into `news_items` (kind `video`); no-op without `YOUTUBE_API_KEY`.
- `backend/server.py` — ONLY the integration step adds routes, caching and startup wiring.

Each module exposes `ensure_schema(conn)`, a `compute_*`/`refresh_*` entry point for the scheduled job, and a
`build_*_payload(conn, ...)` function returning the dict above. Heavy work happens only in the scheduled job;
payload builders read the precomputed tables. Never build large indexes at server startup.
