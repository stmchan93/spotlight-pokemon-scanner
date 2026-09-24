# Meta feed v2: contracts (2026-09-24)

Scope agreed with the user (canvas v4/v6/v7). Mockups: `docs/meta-feed-mockup/v2/`:
`FeedV6` (feed), `MetaPulseV4` (feed block), `MetaV4` (Meta page), `GroupV6` (group page),
`CalendarV5` (Coming up page), `AlertsV6` (alerts — but show ONLY the three switches, NO "built-in
limits" explainer text), `SimilarV7` (similar cards on the card page).

Feed order (Social tab): **Meta pulse → Hot on Ekalight → Set spotlight → Coming up → Top Trends → Card news → posts.**
Top Trends is unchanged. Everything ships behind flags that default OFF; staging only.

All payloads camelCase, money USD, percents signed (12.5 = +12.5%).

## 1. Meta pulse v4 (extends the existing MetaPulse contract in `docs/meta-feed-api-contracts-2026-09-23.md`)

Existing `GET /api/v1/market/meta` stays. Changes:
- `MetaGroup.topCards` → up to **20** cards per group (feed shows the group's lead card only; the group page shows the list).
- New field on `MetaGroup`: `cardIds: string[]` is NOT added (too big). Membership for "you own" is computed server-side per user (below).

New endpoints:

```ts
// GET /api/v1/market/meta/groups/{groupKey}?game=&window=&lane=   (public, flag META_PULSE_ENABLED)
export type MetaGroupDetail = {
  game: CardGame;
  windowDays: number;
  group: MetaGroup;              // same shape, topCards up to 20, sorted by changePercent (desc for risers, asc for coolers)
  asOfDate: string | null;
};

// GET /api/v1/market/meta/me?game=&window=   (AUTHED, owner-scoped; flag META_PULSE_ENABLED)
// Computed on request from the caller's collection (deck_entries) — never global.
export type MetaExposure = {
  game: CardGame;
  windowDays: number;
  callout: {                     // null when the user owns nothing in a group that moved
    title: string;               // "Your vintage is up +$312 this week"
    body: string;                // "4 PSA 10s and 11 raw cards in rising groups"
    valueChangeUsd: number;
    imageUrls: string[];         // ≤ 2 of the user's cards, for the fanned thumbnails
  } | null;
  groups: Record<string, {       // keyed by groupKey; only groups where the user owns ≥ 1 card
    ownedCount: number;
    valueChangeUsd: number;      // change in the user's holdings in this group over the window
    ownedCards: MetaCard[];      // ≤ 20, for "Your cards in this group" on the group page
  }>;
};
```

TS types above go in `packages/api-client/src/spotlight/types.ts` next to the existing Meta types.

UI rules: feed block = headline + callout (if any) + **exactly 3 risers and 3 coolers** (fewer if fewer exist) as
bar rows (lead-card thumb, group name, "You own N" tag, bar length ∝ |median %| relative to the largest shown,
mini sparkline from `sparkPoints`, % and $). Meta page = headline + graded/raw value tiles only (no
rising/cooling count, no "written from…" line), then full up/cooling bar lists with All/Raw/Graded + game
chips + window. Tapping a row → group page `/meta/group/[groupKey]` (params game, window, lane).

## 2. Coming up

```ts
// GET /api/v1/market/calendar?game=&limit=   (public, flag CALENDAR_ENABLED)
export type CalendarEventKind = 'release' | 'ban_list' | 'reveal' | 'event';
export type CalendarEvent = {
  id: string;
  date: string;                  // YYYY-MM-DD
  kind: CalendarEventKind;
  game: CardGame;
  title: string;                 // "Delta Reign (English)"
  subtitle: string | null;       // one short line
  setId: string | null;
  url: string | null;            // official source, link-out
};
export type CalendarFeed = { items: CalendarEvent[] };   // upcoming only (date >= today), ascending
```

Sources: `expansions` rows with a future `release_date` (automatic) + a small hand-maintained
`backend/data/calendar_events.json` (ban lists, reveals) — only verified dates with a source URL.
Feed block shows the next 3; "All dates ›" opens `/calendar`.

## Flags

`META_PULSE_ENABLED` (existing), `CALENDAR_ENABLED`, `SIMILAR_CARDS_ENABLED`, `MARKET_ALERTS_ENABLED`.
On in `backend/.env.staging` only.
