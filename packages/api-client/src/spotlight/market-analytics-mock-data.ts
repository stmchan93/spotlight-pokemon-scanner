import type {
  CardPricePosition,
  MarketAnalytics,
  MarketCardTile,
  MarketHeatmapSet,
  MarketPoint,
} from './types';

/*
  Offline Market Analytics payloads (docs/market-analytics-2026-11-23.md) for
  the MockSpotlightRepository, dev builds without a backend, and tests. Shaped
  exactly like the server's: USD only, no coverage fields.
*/

const IMG = 'https://images.pokemontcg.io';
const LOGO = 'https://images.pokemontcg.io';

function card(cardId: string, name: string, setId: string, setName: string, number: string, variant?: string): MarketCardTile {
  return {
    cardId,
    name,
    setName,
    number,
    imageUrl: `${IMG}/${setId}/${number}.png`,
    game: 'pokemon',
    ...(variant ? { variant } : {}),
  };
}

// A smooth series ending at `end` that moved `changePct` over `days`.
function series(end: number, changePct: number, days: number, count = 30, asOf = '2026-11-22'): MarketPoint[] {
  const start = end / (1 + changePct / 100);
  const last = new Date(`${asOf}T00:00:00Z`).getTime();
  return Array.from({ length: count }, (_, index) => {
    const t = index / (count - 1);
    const wobble = Math.sin(index * 1.7) * 0.012 * end;
    const value = index === count - 1 ? end : start + (end - start) * t + wobble;
    const date = new Date(last - Math.round((1 - t) * days) * 86_400_000).toISOString().slice(0, 10);
    return { date, value: Number(value.toFixed(2)) };
  });
}

export const mockMarketAnalytics: MarketAnalytics = {
  game: 'pokemon',
  window: '30d',
  windowLabel: 'past 30 days',
  asOf: '2026-11-22',
  pulse: {
    changePct: 3.84,
    indexValueUsd: 58214.37,
    breadth: { up: 1482, down: 911, flat: 604, upPct: 49.4 },
    sparkline: series(58214.37, 3.84, 30),
    index: {
      name: 'Pokémon Market Index',
      points: series(218.6, 4.1, 30),
      value: 218.6,
      changePct: 4.1,
      rangeLow: 207.9,
      rangeHigh: 218.6,
      basketSize: 100,
      rebalancedOn: '2026-11-01',
    },
  },
  you: { changePct: 5.12, valueUsd: 4381.55, marketChangePct: 3.84, beatsMarket: true },
  heatmap: [
    { setId: 'sv3pt5', name: '151', logoUrl: `${LOGO}/sv3pt5/logo.png`, game: 'pokemon', totalValueUsd: 9412.18, changePct: 6.2, cardCount: 207 },
    { setId: 'swsh7', name: 'Evolving Skies', logoUrl: `${LOGO}/swsh7/logo.png`, game: 'pokemon', totalValueUsd: 8875.4, changePct: 2.1, cardCount: 237 },
    { setId: 'base1', name: 'Base', logoUrl: `${LOGO}/base1/logo.png`, game: 'pokemon', totalValueUsd: 7720.92, changePct: -1.4, cardCount: 102 },
    { setId: 'sv8pt5', name: 'Prismatic Evolutions', logoUrl: `${LOGO}/sv8pt5/logo.png`, game: 'pokemon', totalValueUsd: 6984.33, changePct: -7.9, cardCount: 180 },
    { setId: 'swsh12pt5', name: 'Crown Zenith', logoUrl: `${LOGO}/swsh12pt5/logo.png`, game: 'pokemon', totalValueUsd: 4210.06, changePct: 0.4, cardCount: 230 },
    { setId: 'neo1', name: 'Neo Genesis', logoUrl: `${LOGO}/neo1/logo.png`, game: 'pokemon', totalValueUsd: 3655.71, changePct: 3.3, cardCount: 111 },
    { setId: 'sv4pt5', name: 'Paldean Fates', logoUrl: `${LOGO}/sv4pt5/logo.png`, game: 'pokemon', totalValueUsd: 2988.12, changePct: -3.6, cardCount: 245 },
    { setId: 'ex8', name: 'Deoxys', logoUrl: `${LOGO}/ex8/logo.png`, game: 'pokemon', totalValueUsd: 2410.5, changePct: 11.8, cardCount: 108 },
  ],
  bargains: [
    {
      ...card('swsh7-215', 'Umbreon VMAX', 'swsh7', 'Evolving Skies', '215', 'Holofoil'),
      priceUsd: 1312.4, changePct: -6.1, position: { lowUsd: 1290.0, highUsd: 1580.25, percentile: 8 },
    },
    {
      ...card('sv3pt5-199', 'Charizard ex', 'sv3pt5', '151', '199', 'Holofoil'),
      priceUsd: 214.87, changePct: -4.3, position: { lowUsd: 205.5, highUsd: 262.0, percentile: 17 },
    },
    {
      ...card('neo1-9', 'Lugia', 'neo1', 'Neo Genesis', '9', 'Unlimited Holofoil'),
      priceUsd: 318.0, changePct: -2.2, position: { lowUsd: 309.99, highUsd: 371.5, percentile: 13 },
    },
  ],
  breakingOut: [
    {
      ...card('ex8-107', 'Rayquaza ex', 'ex8', 'Deoxys', '107', 'Holofoil'),
      priceUsd: 486.12, changePct: 18.4, previousHighUsd: 431.0, sparkline: series(486.12, 18.4, 30),
    },
    {
      ...card('base1-4', 'Charizard', 'base1', 'Base', '4', 'Unlimited Holofoil'),
      priceUsd: 512.5, changePct: 9.7, previousHighUsd: 489.99, sparkline: series(512.5, 9.7, 30),
    },
  ],
  setsRising: [
    { setId: 'ex8', name: 'Deoxys', logoUrl: `${LOGO}/ex8/logo.png`, game: 'pokemon', changePct: 11.8 },
    { setId: 'sv3pt5', name: '151', logoUrl: `${LOGO}/sv3pt5/logo.png`, game: 'pokemon', changePct: 6.2 },
    { setId: 'neo1', name: 'Neo Genesis', logoUrl: `${LOGO}/neo1/logo.png`, game: 'pokemon', changePct: 3.3 },
  ],
  setsFalling: [
    { setId: 'sv8pt5', name: 'Prismatic Evolutions', logoUrl: `${LOGO}/sv8pt5/logo.png`, game: 'pokemon', changePct: -7.9 },
    { setId: 'sv4pt5', name: 'Paldean Fates', logoUrl: `${LOGO}/sv4pt5/logo.png`, game: 'pokemon', changePct: -3.6 },
  ],
  grading: [
    {
      ...card('sv3pt5-173', 'Venusaur ex', 'sv3pt5', '151', '173', 'Holofoil'),
      rawUsd: 38.5, psa10Usd: 162.0, feeUsd: 30, netGainUsd: 93.5, owned: true,
    },
    {
      ...card('swsh12pt5-GG44', 'Mewtwo VSTAR', 'swsh12pt5', 'Crown Zenith', 'GG44', 'Holofoil'),
      rawUsd: 41.2, psa10Usd: 118.75, feeUsd: 30, netGainUsd: 47.55, owned: false,
    },
  ],
};

export const mockMarketHeatmapSet: MarketHeatmapSet = {
  setId: 'sv3pt5',
  name: '151',
  window: '30d',
  windowLabel: 'past 30 days',
  cards: [
    { ...card('sv3pt5-199', 'Charizard ex', 'sv3pt5', '151', '199', 'Holofoil'), priceUsd: 214.87, changePct: -4.3 },
    { ...card('sv3pt5-205', 'Mew ex', 'sv3pt5', '151', '205', 'Holofoil'), priceUsd: 142.3, changePct: 2.4 },
    { ...card('sv3pt5-200', 'Blastoise ex', 'sv3pt5', '151', '200', 'Holofoil'), priceUsd: 88.15, changePct: 7.9 },
    { ...card('sv3pt5-198', 'Venusaur ex', 'sv3pt5', '151', '198', 'Holofoil'), priceUsd: 74.02, changePct: 1.1 },
    { ...card('sv3pt5-201', 'Alakazam ex', 'sv3pt5', '151', '201', 'Holofoil'), priceUsd: 39.6, changePct: null },
  ],
};

export const mockCardPricePosition: CardPricePosition = {
  currentUsd: 214.87,
  lowUsd: 205.5,
  highUsd: 262.0,
  percentile: 17,
  windowLabel: 'past 90 days',
};
