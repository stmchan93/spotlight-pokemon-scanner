import type {
  CardPricePosition,
  MarketAnalytics,
  MarketCardMove,
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

function move(tile: MarketCardTile, priceUsd: number, changePct: number): MarketCardMove {
  const thenPriceUsd = Number((priceUsd / (1 + changePct / 100)).toFixed(2));
  return { ...tile, priceUsd, thenPriceUsd, changePct, changeUsd: Number((priceUsd - thenPriceUsd).toFixed(2)) };
}

// 14 rising rows so "Show 10 more" has something to reveal.
const mockCardsRising: MarketCardMove[] = [
  move(card('ex8-107', 'Rayquaza ex', 'ex8', 'Deoxys', '107', 'Holofoil'), 486.12, 38.4),
  move(card('sv3pt5-200', 'Blastoise ex', 'sv3pt5', '151', '200', 'Holofoil'), 88.15, 31.2),
  move(card('neo1-17', 'Typhlosion', 'neo1', 'Neo Genesis', '17', 'Unlimited Holofoil'), 64.5, 27.9),
  move(card('swsh7-218', 'Rayquaza VMAX', 'swsh7', 'Evolving Skies', '218', 'Holofoil'), 512.0, 22.6),
  move(card('sv4pt5-232', 'Mew ex', 'sv4pt5', 'Paldean Fates', '232', 'Holofoil'), 71.3, 19.8),
  move(card('base1-2', 'Blastoise', 'base1', 'Base', '2', 'Unlimited Holofoil'), 219.99, 17.1),
  move(card('sv3pt5-205', 'Mew ex', 'sv3pt5', '151', '205', 'Holofoil'), 142.3, 15.4),
  move(card('swsh12pt5-GG70', 'Pikachu VMAX', 'swsh12pt5', 'Crown Zenith', 'GG70', 'Holofoil'), 58.75, 13.2),
  move(card('neo1-9', 'Lugia', 'neo1', 'Neo Genesis', '9', 'Unlimited Holofoil'), 318.0, 11.6),
  move(card('sv8pt5-161', 'Umbreon ex', 'sv8pt5', 'Prismatic Evolutions', '161', 'Holofoil'), 1105.4, 10.3),
  move(card('base1-15', 'Venusaur', 'base1', 'Base', '15', 'Unlimited Holofoil'), 164.0, 8.8),
  move(card('ex8-108', 'Deoxys ex', 'ex8', 'Deoxys', '108', 'Holofoil'), 92.4, 7.5),
  move(card('swsh7-203', 'Dragonite V', 'swsh7', 'Evolving Skies', '192', 'Holofoil'), 46.1, 6.2),
  move(card('sv3pt5-166', 'Dragonair', 'sv3pt5', '151', '181', 'Holofoil'), 39.9, 5.1),
];

const mockCardsFalling: MarketCardMove[] = [
  move(card('sv8pt5-156', 'Sylveon ex', 'sv8pt5', 'Prismatic Evolutions', '156', 'Holofoil'), 248.3, -21.7),
  move(card('sv4pt5-234', 'Charizard ex', 'sv4pt5', 'Paldean Fates', '234', 'Holofoil'), 96.4, -14.2),
  move(card('swsh7-215', 'Umbreon VMAX', 'swsh7', 'Evolving Skies', '215', 'Holofoil'), 1312.4, -6.1),
  move(card('sv3pt5-199', 'Charizard ex', 'sv3pt5', '151', '199', 'Holofoil'), 214.87, -4.3),
];

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
  cardsRising: mockCardsRising,
  cardsFalling: mockCardsFalling,
  yourMovers: {
    gainers: [
      { ...card('neo1-9', 'Lugia', 'neo1', 'Neo Genesis', '9', 'Unlimited Holofoil'), quantity: 1, priceUsd: 318.0, changeUsd: 33.0, changePct: 11.58 },
      { ...card('sv3pt5-173', 'Venusaur ex', 'sv3pt5', '151', '173', 'Holofoil'), quantity: 2, priceUsd: 38.5, changeUsd: 22.0, changePct: 40.0 },
    ],
    losers: [
      { ...card('sv4pt5-234', 'Charizard ex', 'sv4pt5', 'Paldean Fates', '234', 'Holofoil'), quantity: 1, priceUsd: 96.4, changeUsd: -8.0, changePct: -7.66 },
    ],
  },
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
