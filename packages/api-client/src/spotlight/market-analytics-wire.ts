import {
  CARD_GAMES,
  DEFAULT_CARD_GAME,
  MARKET_WINDOWS,
  type CardGame,
  type CardPricePosition,
  type MarketAnalytics,
  type MarketBargain,
  type MarketBreakout,
  type MarketCardMove,
  type MarketCardTile,
  type MarketGradingPick,
  type MarketHeatmapSet,
  type MarketHeatmapSetCard,
  type MarketHeatmapTile,
  type MarketIndex,
  type MarketPoint,
  type MarketSetMove,
  type MarketSetTile,
  type MarketWindow,
  type MarketYou,
  type MarketYourMover,
  type MarketYourMovers,
} from './types';

/*
  Defensive wire mapping for the Market Analytics payloads
  (docs/market-analytics-2026-11-23.md). Same rules as the meta feed: lists
  default to [], numbers are coerced and non-finite values dropped, strings
  default to null. A malformed row is skipped, never thrown.
*/

type Raw = Record<string, unknown>;

function asRecord(value: unknown): Raw {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Raw) : {};
}

function asArray(value: unknown): Raw[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function num(value: unknown, fallback = 0): number {
  const parsed = numOrNull(value);
  return parsed ?? fallback;
}

function numOrNull(value: unknown): number | null {
  if (value == null || value === '' || typeof value === 'boolean') {
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

export function parseMarketWindow(value: unknown, fallback: MarketWindow = '30d'): MarketWindow {
  return MARKET_WINDOWS.includes(value as MarketWindow) ? (value as MarketWindow) : fallback;
}

function points(value: unknown): MarketPoint[] {
  return asArray(value)
    .map((point) => ({ date: str(point.date) ?? '', value: numOrNull(point.value) }))
    .filter((point): point is MarketPoint => point.date !== '' && point.value != null);
}

function cardTile(raw: Raw, fallbackGame: CardGame): MarketCardTile | null {
  const cardId = str(raw.cardId);
  if (!cardId) {
    return null;
  }
  const tile: MarketCardTile = {
    cardId,
    name: str(raw.name) ?? '',
    setName: str(raw.setName),
    number: str(raw.number),
    imageUrl: str(raw.imageUrl),
    game: game(raw.game, fallbackGame),
  };
  const variant = str(raw.variant);
  if (variant) {
    tile.variant = variant;
  }
  return tile;
}

function setTile(raw: Raw, fallbackGame: CardGame): MarketSetTile | null {
  const setId = str(raw.setId);
  if (!setId) {
    return null;
  }
  return {
    setId,
    name: str(raw.name) ?? setId,
    logoUrl: str(raw.logoUrl),
    game: game(raw.game, fallbackGame),
  };
}

function compact<T>(items: (T | null)[]): T[] {
  return items.filter((item): item is T => item != null);
}

function setMoves(value: unknown, fallbackGame: CardGame): MarketSetMove[] {
  return compact(asArray(value).map((raw) => {
    const tile = setTile(raw, fallbackGame);
    const changePct = numOrNull(raw.changePct);
    return tile && changePct != null ? { ...tile, changePct } : null;
  }));
}

function marketIndex(value: unknown): MarketIndex | null {
  if (value == null || typeof value !== 'object') {
    return null;
  }
  const raw = asRecord(value);
  const level = numOrNull(raw.value);
  const indexPoints = points(raw.points);
  if (level == null || indexPoints.length < 2) {
    return null;
  }
  const values = indexPoints.map((point) => point.value);
  return {
    name: str(raw.name) ?? 'Market Index',
    points: indexPoints,
    value: level,
    changePct: numOrNull(raw.changePct),
    rangeLow: numOrNull(raw.rangeLow) ?? Math.min(...values),
    rangeHigh: numOrNull(raw.rangeHigh) ?? Math.max(...values),
    basketSize: num(raw.basketSize),
    rebalancedOn: str(raw.rebalancedOn),
  };
}

function you(value: unknown): MarketYou | null {
  if (value == null || typeof value !== 'object') {
    return null;
  }
  const raw = asRecord(value);
  const valueUsd = numOrNull(raw.valueUsd);
  if (valueUsd == null) {
    return null;
  }
  return {
    changePct: numOrNull(raw.changePct),
    valueUsd,
    marketChangePct: numOrNull(raw.marketChangePct),
    beatsMarket: typeof raw.beatsMarket === 'boolean' ? raw.beatsMarket : null,
  };
}

function cardMoves(value: unknown, fallbackGame: CardGame): MarketCardMove[] {
  return compact(asArray(value).map((raw): MarketCardMove | null => {
    const tile = cardTile(raw, fallbackGame);
    const priceUsd = numOrNull(raw.priceUsd);
    const changePct = numOrNull(raw.changePct);
    if (!tile || priceUsd == null || changePct == null) {
      return null;
    }
    const thenPriceUsd = numOrNull(raw.thenPriceUsd) ?? priceUsd / (1 + changePct / 100);
    return {
      ...tile,
      priceUsd,
      thenPriceUsd,
      changePct,
      changeUsd: numOrNull(raw.changeUsd) ?? priceUsd - thenPriceUsd,
    };
  }));
}

function yourMoverList(value: unknown, fallbackGame: CardGame): MarketYourMover[] {
  return compact(asArray(value).map((raw): MarketYourMover | null => {
    const tile = cardTile(raw, fallbackGame);
    const changeUsd = numOrNull(raw.changeUsd);
    return tile && changeUsd != null
      ? {
        ...tile,
        quantity: Math.max(1, num(raw.quantity, 1)),
        priceUsd: numOrNull(raw.priceUsd),
        changeUsd,
        changePct: numOrNull(raw.changePct),
      }
      : null;
  }));
}

function yourMovers(value: unknown, fallbackGame: CardGame): MarketYourMovers | null {
  if (value == null || typeof value !== 'object') {
    return null;
  }
  const raw = asRecord(value);
  const gainers = yourMoverList(raw.gainers, fallbackGame);
  const losers = yourMoverList(raw.losers, fallbackGame);
  return gainers.length || losers.length ? { gainers, losers } : null;
}

export function parseMarketAnalyticsPayload(
  value: unknown,
  query?: { game?: CardGame; window?: MarketWindow },
): MarketAnalytics {
  const raw = asRecord(value);
  const fallbackGame = game(raw.game, query?.game ?? DEFAULT_CARD_GAME);
  const pulse = asRecord(raw.pulse);
  const breadth = asRecord(pulse.breadth);
  return {
    game: fallbackGame,
    window: parseMarketWindow(raw.window, query?.window ?? '30d'),
    windowLabel: str(raw.windowLabel) ?? 'recently',
    asOf: str(raw.asOf),
    pulse: {
      changePct: numOrNull(pulse.changePct),
      indexValueUsd: numOrNull(pulse.indexValueUsd),
      breadth: {
        up: num(breadth.up),
        down: num(breadth.down),
        flat: num(breadth.flat),
        upPct: numOrNull(breadth.upPct),
      },
      sparkline: points(pulse.sparkline),
      index: marketIndex(pulse.index),
    },
    you: you(raw.you),
    heatmap: compact(asArray(raw.heatmap).map((item): MarketHeatmapTile | null => {
      const tile = setTile(item, fallbackGame);
      return tile
        ? {
          ...tile,
          totalValueUsd: num(item.totalValueUsd),
          changePct: numOrNull(item.changePct),
          cardCount: num(item.cardCount),
        }
        : null;
    })),
    bargains: compact(asArray(raw.bargains).map((item): MarketBargain | null => {
      const tile = cardTile(item, fallbackGame);
      const position = asRecord(item.position);
      const priceUsd = numOrNull(item.priceUsd);
      const lowUsd = numOrNull(position.lowUsd);
      const highUsd = numOrNull(position.highUsd);
      if (!tile || priceUsd == null || lowUsd == null || highUsd == null) {
        return null;
      }
      return {
        ...tile,
        priceUsd,
        changePct: numOrNull(item.changePct),
        position: { lowUsd, highUsd, percentile: num(position.percentile) },
      };
    })),
    breakingOut: compact(asArray(raw.breakingOut).map((item): MarketBreakout | null => {
      const tile = cardTile(item, fallbackGame);
      const priceUsd = numOrNull(item.priceUsd);
      return tile && priceUsd != null
        ? {
          ...tile,
          priceUsd,
          changePct: numOrNull(item.changePct),
          previousHighUsd: numOrNull(item.previousHighUsd),
          sparkline: points(item.sparkline),
        }
        : null;
    })),
    setsRising: setMoves(raw.setsRising, fallbackGame),
    setsFalling: setMoves(raw.setsFalling, fallbackGame),
    cardsRising: cardMoves(raw.cardsRising, fallbackGame),
    cardsFalling: cardMoves(raw.cardsFalling, fallbackGame),
    yourMovers: yourMovers(raw.yourMovers, fallbackGame),
    grading: compact(asArray(raw.grading).map((item): MarketGradingPick | null => {
      const tile = cardTile(item, fallbackGame);
      const rawUsd = numOrNull(item.rawUsd);
      const psa10Usd = numOrNull(item.psa10Usd);
      const netGainUsd = numOrNull(item.netGainUsd);
      if (!tile || rawUsd == null || psa10Usd == null || netGainUsd == null) {
        return null;
      }
      return {
        ...tile,
        rawUsd,
        psa10Usd,
        feeUsd: num(item.feeUsd),
        netGainUsd,
        owned: item.owned === true,
      };
    })),
  };
}

export function parseMarketHeatmapSetPayload(
  value: unknown,
  query: { game: CardGame; setId: string; window: MarketWindow },
): MarketHeatmapSet {
  const raw = asRecord(value);
  return {
    setId: str(raw.setId) ?? query.setId,
    name: str(raw.name) ?? query.setId,
    window: parseMarketWindow(raw.window, query.window),
    windowLabel: str(raw.windowLabel) ?? 'recently',
    cards: compact(asArray(raw.cards).map((item): MarketHeatmapSetCard | null => {
      const tile = cardTile(item, query.game);
      const priceUsd = numOrNull(item.priceUsd);
      return tile && priceUsd != null ? { ...tile, priceUsd, changePct: numOrNull(item.changePct) } : null;
    })),
  };
}

export function parseCardPricePositionPayload(value: unknown): CardPricePosition | null {
  if (value == null || typeof value !== 'object') {
    return null;
  }
  const raw = asRecord(value);
  const currentUsd = numOrNull(raw.currentUsd);
  const lowUsd = numOrNull(raw.lowUsd);
  const highUsd = numOrNull(raw.highUsd);
  const percentile = numOrNull(raw.percentile);
  if (currentUsd == null || lowUsd == null || highUsd == null || percentile == null) {
    return null;
  }
  return { currentUsd, lowUsd, highUsd, percentile, windowLabel: str(raw.windowLabel) ?? 'recently' };
}
