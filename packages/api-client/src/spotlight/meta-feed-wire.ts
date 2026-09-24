import {
  CARD_GAMES,
  DEFAULT_CARD_GAME,
  type CalendarEvent,
  type CalendarEventKind,
  type CalendarFeed,
  type CardGame,
  type HotCard,
  type HotCards,
  type MetaCard,
  type MetaExposure,
  type MetaGroup,
  type MetaGroupDetail,
  type MetaLadder,
  type MetaLane,
  type MetaLaneFilter,
  type MetaPulse,
  type NewsFeed,
  type NewsItem,
  type NewsKind,
  type SetSpotlight,
  type SetSpotlightCard,
} from './types';

/*
  Defensive wire mapping for the meta feed payloads
  (docs/meta-feed-api-contracts-2026-09-23.md). Same rules as the top-movers
  mapping: lists default to [], numbers are coerced and non-finite values
  dropped, strings default to null. A malformed row never throws.
*/

type Raw = Record<string, unknown>;

function asRecord(value: unknown): Raw {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Raw) : {};
}

function asArray(value: unknown): Raw[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function num(value: unknown, fallback = 0): number {
  if (value == null || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function numOrNull(value: unknown): number | null {
  if (value == null || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function str(value: unknown): string | null {
  return value != null && value !== '' ? String(value) : null;
}

function game(value: unknown, fallback: CardGame = DEFAULT_CARD_GAME): CardGame {
  return CARD_GAMES.includes(value as CardGame) ? (value as CardGame) : fallback;
}

function lane(value: unknown): MetaLane {
  return value === 'graded' ? 'graded' : 'raw';
}

function laneFilter(value: unknown): MetaLaneFilter {
  return value === 'raw' || value === 'graded' ? value : 'all';
}

function numbers(value: unknown): number[] {
  return Array.isArray(value) ? value.map(Number).filter((v) => Number.isFinite(v)) : [];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(str).filter((v): v is string => v != null) : [];
}

function parseMetaCard(raw: Raw, fallbackGame: CardGame): MetaCard {
  return {
    cardId: String(raw.cardId ?? ''),
    game: game(raw.game, fallbackGame),
    name: String(raw.name ?? ''),
    number: str(raw.number),
    setName: str(raw.setName),
    imageUrl: str(raw.imageUrl),
    lane: lane(raw.lane),
    grader: str(raw.grader),
    grade: str(raw.grade),
    population: numOrNull(raw.population),
    priceNow: num(raw.priceNow),
    priceThen: num(raw.priceThen),
    changePercent: num(raw.changePercent),
    currencyCode: str(raw.currencyCode) ?? 'USD',
  };
}

function parseMetaGroup(raw: Raw, fallbackGame: CardGame): MetaGroup {
  return {
    groupKey: String(raw.groupKey ?? ''),
    label: String(raw.label ?? ''),
    lane: lane(raw.lane),
    description: String(raw.description ?? ''),
    medianChangePercent: num(raw.medianChangePercent),
    valueNow: num(raw.valueNow),
    valueThen: num(raw.valueThen),
    valueChangeUsd: num(raw.valueChangeUsd),
    cardCount: num(raw.cardCount),
    movedCardCount: num(raw.movedCardCount),
    sparkPoints: numbers(raw.sparkPoints),
    topCards: asArray(raw.topCards).map((card) => parseMetaCard(card, fallbackGame)),
  };
}

function parseMetaLadder(raw: Raw): MetaLadder {
  return {
    title: String(raw.title ?? ''),
    rungs: asArray(raw.rungs).map((rung) => ({
      label: String(rung.label ?? ''),
      lane: lane(rung.lane),
      medianChangePercent: num(rung.medianChangePercent),
    })),
  };
}

export function parseMetaPulsePayload(value: unknown, requested?: { windowDays?: number }): MetaPulse {
  const raw = asRecord(value);
  const payloadGame = game(raw.game);
  const headline = asRecord(raw.headline);
  const summary = asRecord(raw.summary);
  return {
    game: payloadGame,
    windowDays: num(raw.windowDays) || requested?.windowDays || 7,
    lane: laneFilter(raw.lane),
    availableWindows: numbers(raw.availableWindows),
    availableGames: (Array.isArray(raw.availableGames) ? raw.availableGames : [])
      .filter((entry): entry is CardGame => CARD_GAMES.includes(entry as CardGame)),
    computedAt: str(raw.computedAt) ?? '',
    asOfDate: str(raw.asOfDate),
    headline: { title: String(headline.title ?? ''), body: String(headline.body ?? '') },
    summary: {
      rawValueChangePercent: numOrNull(summary.rawValueChangePercent),
      rawValueChangeUsd: numOrNull(summary.rawValueChangeUsd),
      gradedValueChangePercent: numOrNull(summary.gradedValueChangePercent),
      gradedValueChangeUsd: numOrNull(summary.gradedValueChangeUsd),
      risingCount: num(summary.risingCount),
      coolingCount: num(summary.coolingCount),
    },
    groups: asArray(raw.groups).map((group) => parseMetaGroup(group, payloadGame)),
    ladders: asArray(raw.ladders).map(parseMetaLadder),
  };
}

function parseHotCard(raw: Raw): HotCard {
  return {
    cardId: String(raw.cardId ?? ''),
    game: game(raw.game),
    name: String(raw.name ?? ''),
    number: str(raw.number),
    setName: str(raw.setName),
    imageUrl: str(raw.imageUrl),
    distinctUsers: num(raw.distinctUsers),
    baselineRatio: num(raw.baselineRatio),
    priceNow: numOrNull(raw.priceNow),
    changePercent7d: numOrNull(raw.changePercent7d),
    currencyCode: str(raw.currencyCode) ?? 'USD',
  };
}

export function parseHotCardsPayload(value: unknown): HotCards {
  const raw = asRecord(value);
  const eligible = raw.eligible !== false;
  return {
    computedAt: str(raw.computedAt) ?? '',
    windowHours: num(raw.windowHours) || 24,
    minDistinctUsers: num(raw.minDistinctUsers),
    eligible,
    // An ineligible payload is empty by contract; enforce it client-side too.
    items: eligible ? asArray(raw.items).map(parseHotCard) : [],
  };
}

function parseSetSpotlightCard(raw: Raw): SetSpotlightCard {
  return {
    cardId: String(raw.cardId ?? ''),
    name: String(raw.name ?? ''),
    number: str(raw.number),
    imageUrl: str(raw.imageUrl),
    lane: lane(raw.lane),
    grader: str(raw.grader),
    grade: str(raw.grade),
    priceNow: num(raw.priceNow),
    changePercent7d: numOrNull(raw.changePercent7d),
    currencyCode: str(raw.currencyCode) ?? 'USD',
  };
}

const NEWS_KINDS: readonly NewsKind[] = ['news', 'market', 'video', 'community'];

function parseNewsItem(raw: Raw): NewsItem {
  const video = raw.video && typeof raw.video === 'object' ? asRecord(raw.video) : null;
  return {
    id: String(raw.id ?? ''),
    kind: NEWS_KINDS.includes(raw.kind as NewsKind) ? (raw.kind as NewsKind) : 'news',
    source: String(raw.source ?? ''),
    title: String(raw.title ?? ''),
    url: String(raw.url ?? ''),
    imageUrl: str(raw.imageUrl),
    publishedAt: str(raw.publishedAt) ?? '',
    game: raw.game != null && CARD_GAMES.includes(raw.game as CardGame) ? (raw.game as CardGame) : null,
    setId: str(raw.setId),
    cardIds: strings(raw.cardIds),
    tags: strings(raw.tags),
    video: video
      ? {
        channelTitle: String(video.channelTitle ?? ''),
        durationSeconds: numOrNull(video.durationSeconds),
        viewCount: numOrNull(video.viewCount),
      }
      : null,
  };
}

export function parseSetSpotlightPayload(value: unknown): SetSpotlight {
  const raw = asRecord(value);
  const set = asRecord(raw.set);
  const callout = raw.callout && typeof raw.callout === 'object' ? asRecord(raw.callout) : null;
  return {
    computedAt: str(raw.computedAt) ?? '',
    set: {
      setId: String(set.setId ?? ''),
      game: game(set.game),
      name: String(set.name ?? ''),
      code: str(set.code),
      series: str(set.series),
      releaseDate: str(set.releaseDate),
      logoUrl: str(set.logoUrl),
      cardCount: num(set.cardCount),
      valueNow: num(set.valueNow),
      valueChangePercent7d: numOrNull(set.valueChangePercent7d),
      psa10ValueNow: numOrNull(set.psa10ValueNow),
      psa10ChangePercent7d: numOrNull(set.psa10ChangePercent7d),
      collectorsCount: num(set.collectorsCount),
    },
    topByPrice: asArray(raw.topByPrice).map(parseSetSpotlightCard),
    topMovers: asArray(raw.topMovers).map(parseSetSpotlightCard),
    topPsa10: asArray(raw.topPsa10).map(parseSetSpotlightCard),
    callout: callout
      ? {
        cardId: String(callout.cardId ?? ''),
        title: String(callout.title ?? ''),
        body: String(callout.body ?? ''),
      }
      : null,
    videos: asArray(raw.videos).map(parseNewsItem),
    news: asArray(raw.news).map(parseNewsItem),
  };
}

export function parseNewsFeedPayload(value: unknown): NewsFeed {
  const raw = asRecord(value);
  return {
    items: asArray(raw.items).map(parseNewsItem),
    nextCursor: str(raw.nextCursor),
  };
}

// Meta feed v2 (docs/meta-feed-v2-contracts-2026-09-24.md).

export function parseMetaGroupDetailPayload(value: unknown, requested?: { windowDays?: number }): MetaGroupDetail {
  const raw = asRecord(value);
  const payloadGame = game(raw.game);
  return {
    game: payloadGame,
    windowDays: num(raw.windowDays) || requested?.windowDays || 7,
    group: parseMetaGroup(asRecord(raw.group), payloadGame),
    asOfDate: str(raw.asOfDate),
  };
}

export function parseMetaExposurePayload(value: unknown, requested?: { windowDays?: number }): MetaExposure {
  const raw = asRecord(value);
  const payloadGame = game(raw.game);
  const callout = raw.callout && typeof raw.callout === 'object' ? asRecord(raw.callout) : null;
  const groups: MetaExposure['groups'] = {};
  for (const [groupKey, entry] of Object.entries(asRecord(raw.groups))) {
    const group = asRecord(entry);
    const ownedCount = num(group.ownedCount);
    if (!groupKey || ownedCount <= 0) {
      continue;
    }
    groups[groupKey] = {
      ownedCount,
      valueChangeUsd: num(group.valueChangeUsd),
      ownedCards: asArray(group.ownedCards).map((card) => parseMetaCard(card, payloadGame)),
    };
  }
  return {
    game: payloadGame,
    windowDays: num(raw.windowDays) || requested?.windowDays || 7,
    callout: callout && str(callout.title)
      ? {
        title: String(callout.title),
        body: String(callout.body ?? ''),
        valueChangeUsd: num(callout.valueChangeUsd),
        imageUrls: strings(callout.imageUrls).slice(0, 2),
      }
      : null,
    groups,
  };
}

const CALENDAR_KINDS: readonly CalendarEventKind[] = ['release', 'ban_list', 'reveal', 'event'];

function parseCalendarEvent(raw: Raw): CalendarEvent | null {
  const date = str(raw.date);
  const title = str(raw.title);
  // A row without a real date or title can't be placed on the list.
  if (!date || !/^\d{4}-\d{2}-\d{2}/.test(date) || !title) {
    return null;
  }
  return {
    id: String(raw.id ?? `${date}:${title}`),
    date: date.slice(0, 10),
    kind: CALENDAR_KINDS.includes(raw.kind as CalendarEventKind) ? (raw.kind as CalendarEventKind) : 'event',
    game: game(raw.game),
    title,
    subtitle: str(raw.subtitle),
    setId: str(raw.setId),
    url: str(raw.url),
  };
}

export function parseCalendarPayload(value: unknown): CalendarFeed {
  const raw = asRecord(value);
  return {
    items: asArray(raw.items)
      .map(parseCalendarEvent)
      .filter((item): item is CalendarEvent => item != null),
  };
}
