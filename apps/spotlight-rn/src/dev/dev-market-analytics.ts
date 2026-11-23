import type {
  CardGame,
  CardPricePosition,
  CardPricePositionQuery,
  MarketAnalytics,
  MarketCardTile,
  MarketHeatmapSet,
  MarketHeatmapSetCard,
  MarketHeatmapTile,
  MarketPoint,
  MarketWindow,
} from '@spotlight/api-client';

/**
 * Dense, deterministic Market Analytics fixtures for the dev screen host and UI
 * tests: ~26 Pokémon sets (enough to exercise the treemap's labelled and
 * unlabelled tiles), per-set card zooms, thin games (Riftbound one set, Gundam
 * none), and nulls where the backend may send them. The stock mock repository
 * keeps the backend's small fixture (`mockMarketAnalytics`).
 */

const cdn = 'https://images.pokemontcg.io';
const AS_OF = '2026-11-22';

const WINDOW_DAYS: Record<MarketWindow, number> = { '7d': 7, '30d': 30, '90d': 90 };
// The backend's honest window names (docs/market-analytics-2026-11-23.md).
const WINDOW_LABELS: Record<MarketWindow, string> = {
  '7d': 'past week',
  '30d': 'past 30 days',
  '90d': 'past 90 days',
};
const WINDOW_SCALE: Record<MarketWindow, number> = { '7d': 0.35, '30d': 1, '90d': 1.8 };

/** djb2 → [0, 1). */
function unit(seed: string): number {
  let hash = 5381;
  for (let index = 0; index < seed.length; index += 1) {
    hash = ((hash << 5) + hash + seed.charCodeAt(index)) >>> 0;
  }
  return (hash % 10_000) / 10_000;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function isoDaysBefore(end: string, days: number): string {
  const date = new Date(`${end}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function series(seed: string, start: number, end: number, days: number): MarketPoint[] {
  const step = days > 45 ? 3 : 1;
  const count = Math.floor(days / step) + 1;
  return Array.from({ length: count }, (_, index) => {
    const t = index / (count - 1);
    const wobble = index === 0 || index === count - 1 ? 0 : (unit(`${seed}:${index}`) - 0.5) * 0.008;
    return {
      date: isoDaysBefore(AS_OF, (count - 1 - index) * step),
      value: round((start + (end - start) * t) * (1 + wobble)),
    };
  });
}

type SetSeed = { setId: string; name: string; totalValueUsd: number; changePct: number; cardCount: number };

function seeds(rows: readonly (readonly [string, string, number, number, number])[]): SetSeed[] {
  return rows.map(([setId, name, totalValueUsd, changePct, cardCount]) => ({ setId, name, totalValueUsd, changePct, cardCount }));
}

const SETS_BY_GAME: Partial<Record<CardGame, SetSeed[]>> = {
  pokemon: seeds([
    ['sv3pt5', '151', 4_820_000, 6.4, 207],
    ['sv8pt5', 'Prismatic Evolutions', 4_150_000, -8.2, 180],
    ['swsh7', 'Evolving Skies', 3_960_000, 3.1, 237],
    ['base1', 'Base Set', 3_400_000, 1.2, 102],
    ['sv4pt5', 'Paldean Fates', 1_980_000, -2.4, 245],
    ['swsh12pt5', 'Crown Zenith', 1_720_000, 4.8, 230],
    ['sv6', 'Twilight Masquerade', 1_310_000, -5.6, 226],
    ['sv8', 'Surging Sparks', 1_480_000, 11.9, 252],
    ['neo1', 'Neo Genesis', 1_120_000, 0.3, 111],
    ['swsh11', 'Lost Origin', 980_000, 2.2, 247],
    ['sv7', 'Stellar Crown', 760_000, -12.7, 175],
    ['sv5', 'Temporal Forces', 690_000, -3.3, 218],
    ['base2', 'Jungle', 640_000, 0.8, 64],
    ['sv9', 'Journey Together', 610_000, 17.4, 190],
    ['swsh9', 'Brilliant Stars', 540_000, 1.9, 216],
    ['sv2', 'Paldea Evolved', 480_000, -0.4, 279],
    ['base3', 'Fossil', 430_000, -1.1, 62],
    ['sv10', 'Destined Rivals', 820_000, 22.6, 244],
    ['ecard1', 'Expedition', 390_000, 4.1, 165],
    ['sv1', 'Scarlet & Violet', 310_000, -6.9, 258],
    ['swsh10', 'Astral Radiance', 280_000, 0.1, 246],
    ['sm12', 'Cosmic Eclipse', 520_000, 7.6, 271],
    ['sv6pt5', 'Shrouded Fable', 210_000, -9.8, 99],
    ['gym1', 'Gym Heroes', 190_000, 2.7, 132],
    ['sm7', 'Celestial Storm', 150_000, -0.2, 183],
    ['xy12', 'Evolutions', 360_000, 3.6, 113],
  ]),
  onepiece: seeds([
    ['op01', 'Romance Dawn', 1_240_000, 4.2, 154],
    ['op05', 'Awakening of the New Era', 980_000, -3.1, 154],
    ['op09', 'Emperors in the New World', 860_000, 9.8, 156],
    ['eb01', 'Memorial Collection', 420_000, -1.6, 80],
    ['op02', 'Paramount War', 390_000, 0.4, 154],
    ['op07', '500 Years in the Future', 340_000, -7.4, 152],
    ['op06', 'Wings of the Captain', 300_000, 2.8, 150],
    ['st13', 'The Three Brothers', 120_000, 13.3, 19],
  ]),
  lorcana: seeds([
    ['1', 'The First Chapter', 520_000, -2.2, 216],
    ['5', 'Shimmering Skies', 310_000, 5.1, 222],
    ['4', "Ursula's Return", 260_000, -4.6, 222],
    ['7', 'Archazia’s Island', 240_000, 8.9, 222],
  ]),
  riftbound: seeds([['ogn', 'Origins', 84_000, -1.8, 298]]),
};

function scaledChange(seed: SetSeed, window: MarketWindow): number {
  return round(seed.changePct * WINDOW_SCALE[window] + (unit(`${seed.setId}:${window}`) - 0.5) * 0.6, 1);
}

function card(game: CardGame, setId: string, number: string, name: string, setName: string): MarketCardTile {
  return { cardId: `${setId}-${number}`, name, setName, number, imageUrl: `${cdn}/${setId}/${number}.png`, game, variant: null };
}

export function buildDevMarketAnalytics(
  game: CardGame,
  window: MarketWindow,
  options: { includeYou?: boolean } = {},
): MarketAnalytics {
  const days = WINDOW_DAYS[window];
  const scale = WINDOW_SCALE[window];
  const sets = SETS_BY_GAME[game] ?? [];
  const heatmap: MarketHeatmapTile[] = sets.map((seed) => ({
    setId: seed.setId,
    name: seed.name,
    logoUrl: `${cdn}/${seed.setId}/logo.png`,
    game,
    totalValueUsd: seed.totalValueUsd,
    // One set with no comparable history: the backend sends null.
    changePct: seed.setId === 'gym1' ? null : scaledChange(seed, window),
    cardCount: seed.cardCount,
  }));

  const totalValue = sets.reduce((sum, seed) => sum + seed.totalValueUsd, 0);
  const weighted = totalValue > 0
    ? heatmap.reduce((sum, tile) => sum + (tile.changePct ?? 0) * tile.totalValueUsd, 0) / totalValue
    : 0;
  const changePct = sets.length ? round(weighted, 1) : null;
  const cardTotal = sets.reduce((sum, seed) => sum + seed.cardCount, 0);
  const upShare = sets.length ? Math.min(0.8, Math.max(0.2, 0.5 + (changePct ?? 0) / 20)) : 0;
  const up = Math.round(cardTotal * upShare);
  const down = Math.round(cardTotal * (1 - upShare) * 0.8);
  const flat = Math.max(0, cardTotal - up - down);

  const movers = heatmap.filter((tile) => tile.changePct != null) as (MarketHeatmapTile & { changePct: number })[];
  const byChange = [...movers].sort((a, b) => b.changePct - a.changePct);
  const toMove = (tile: MarketHeatmapTile & { changePct: number }) => ({
    setId: tile.setId, name: tile.name, logoUrl: tile.logoUrl, game, changePct: tile.changePct,
  });

  const pokemon = game === 'pokemon';
  const p = (setId: string, number: string, name: string, setName: string) => card(game, setId, number, name, setName);

  const bargains = pokemon
    ? [
        { tile: p('sv8pt5', '156', 'Sylveon ex', 'Prismatic Evolutions'), price: 318, low: 296, high: 512 },
        { tile: p('swsh7', '215', 'Umbreon VMAX', 'Evolving Skies'), price: 1_240, low: 1_180, high: 1_690 },
        { tile: p('sv7', '170', 'Terapagos ex', 'Stellar Crown'), price: 64.5, low: 61, high: 118 },
        { tile: p('sv6', '214', 'Greninja ex', 'Twilight Masquerade'), price: 189.99, low: 172, high: 260 },
        { tile: p('sv8pt5', '155', 'Espeon ex', 'Prismatic Evolutions'), price: 142, low: 128, high: 214 },
        { tile: p('swsh11', '186', 'Giratina V', 'Lost Origin'), price: 412, low: 380, high: 530 },
      ].map(({ tile, price, low, high }, index) => ({
        ...tile,
        priceUsd: price,
        changePct: index === 4 ? null : round(-((high - price) / high) * 40 * scale, 1),
        position: { lowUsd: low, highUsd: high, percentile: Math.round(((price - low) / (high - low)) * 100) },
      }))
    : [];

  const breakingOut = pokemon
    ? [
        { tile: p('sv10', '230', "Ethan's Ho-Oh ex", 'Destined Rivals'), price: 214, prev: 188, pct: 18.2 },
        { tile: p('sv8', '238', 'Pikachu ex', 'Surging Sparks'), price: 486, prev: 452, pct: 9.4 },
        { tile: p('sv9', '173', "Lillie's Clefairy ex", 'Journey Together'), price: 129.5, prev: 104, pct: 27.6 },
        { tile: p('sv3pt5', '199', 'Charizard ex', '151'), price: 612, prev: 590, pct: 6.1 },
        { tile: p('sv4', '249', 'Iron Valiant ex', 'Paradox Rift'), price: 41.25, prev: null, pct: 14.9 },
      ].map(({ tile, price, prev, pct }) => {
        const changed = round(pct * scale, 1);
        return {
          ...tile,
          priceUsd: price,
          changePct: changed,
          previousHighUsd: prev,
          sparkline: series(tile.cardId, price / (1 + changed / 100), price, Math.min(days, 30)),
        };
      })
    : game === 'onepiece'
      ? [{
          ...card(game, 'op09', '118', 'Monkey.D.Luffy', 'Emperors in the New World'),
          imageUrl: null,
          variant: 'Manga',
          priceUsd: 1_820,
          changePct: round(12.4 * scale, 1),
          previousHighUsd: 1_640,
          sparkline: series('op09-118', 1_620, 1_820, Math.min(days, 30)),
        }]
      : [];

  const grading = pokemon
    ? [
        { tile: p('sv3pt5', '199', 'Charizard ex', '151'), raw: 612, psa10: 1_480, owned: true },
        { tile: p('swsh7', '215', 'Umbreon VMAX', 'Evolving Skies'), raw: 1_240, psa10: 3_150, owned: false },
        { tile: p('sv3pt5', '205', 'Mew ex', '151'), raw: 38, psa10: 205, owned: true },
        { tile: p('swsh7', '218', 'Rayquaza VMAX', 'Evolving Skies'), raw: 520, psa10: 1_190, owned: false },
        { tile: p('swsh12', '186', 'Lugia V', 'Silver Tempest'), raw: 180, psa10: 455, owned: false },
      ].map(({ tile, raw, psa10, owned }) => ({
        ...tile, rawUsd: raw, psa10Usd: psa10, feeUsd: 30, netGainUsd: Math.round(psa10 - raw - 30), owned,
      }))
    : [];

  const indexValueUsd = sets.length ? Math.round(totalValue) : null;
  const yourChange = changePct != null ? round(changePct + (pokemon ? 1.9 : -2.3) * scale, 1) : null;

  return {
    game,
    window,
    windowLabel: WINDOW_LABELS[window],
    asOf: AS_OF,
    pulse: {
      changePct,
      indexValueUsd,
      breadth: { up, down, flat, upPct: cardTotal ? round((up / cardTotal) * 100, 1) : null },
      sparkline: indexValueUsd != null && changePct != null
        ? series(`${game}:index`, indexValueUsd / (1 + changePct / 100), indexValueUsd, days)
        : [],
    },
    you: options.includeYou !== false && sets.length > 0
      ? {
          changePct: yourChange,
          valueUsd: pokemon ? 14_382.5 : 1_210,
          marketChangePct: changePct,
          beatsMarket: yourChange != null && changePct != null ? yourChange > changePct : null,
        }
      : null,
    heatmap,
    bargains,
    breakingOut,
    setsRising: byChange.filter((tile) => tile.changePct > 0).slice(0, 6).map(toMove),
    setsFalling: [...byChange].reverse().filter((tile) => tile.changePct < 0).slice(0, 6).map(toMove),
    grading,
  };
}

const CARD_NAMES = [
  'Charizard ex', 'Pikachu', 'Mewtwo', 'Gengar', 'Umbreon', 'Eevee', 'Snorlax', 'Lugia', 'Rayquaza', 'Gardevoir ex',
  'Dragonite', 'Gyarados', 'Alakazam', 'Blastoise', 'Venusaur', 'Mew', 'Lucario', 'Greninja', 'Sylveon', 'Espeon',
  'Arcanine', 'Lapras', 'Jigglypuff', 'Psyduck', 'Bulbasaur', 'Squirtle', 'Charmander', 'Machamp', 'Zapdos', 'Moltres',
  'Articuno', 'Ditto', 'Magikarp', 'Togepi', 'Tyranitar', 'Scizor',
];

export function buildDevMarketHeatmapSet(game: CardGame, setId: string, window: MarketWindow): MarketHeatmapSet | null {
  const seed = (SETS_BY_GAME[game] ?? []).find((candidate) => candidate.setId === setId);
  if (!seed) {
    return null;
  }
  const setChange = scaledChange(seed, window);
  const count = Math.min(36, Math.max(8, Math.round(seed.cardCount / 7)));
  const cards: MarketHeatmapSetCard[] = Array.from({ length: count }, (_, index) => {
    const number = String(Math.round(seed.cardCount * (1 - index / count)));
    const r = unit(`${setId}:${index}`);
    return {
      ...card(game, setId, number, CARD_NAMES[(index + seed.name.length) % CARD_NAMES.length], seed.name),
      // A long tail: a few chase cards hold most of the value.
      priceUsd: round(Math.max(1.5, 900 * Math.pow(0.82, index) * (0.7 + r * 0.6))),
      changePct: index === 5
        ? null
        : round(setChange + (unit(`${setId}:${index}:${window}`) - 0.5) * 24 * WINDOW_SCALE[window], 1),
    };
  });
  return { setId, name: seed.name, window, windowLabel: WINDOW_LABELS[window], cards };
}

/** A stable 90-day range per printing/condition/grade. */
export function buildDevCardPricePosition(query: CardPricePositionQuery): CardPricePosition | null {
  if (!query.cardId) {
    return null;
  }
  const key = [query.cardId, query.variant, query.condition, query.grader, query.grade].join('|');
  const graded = Boolean(query.grader && query.grader !== 'Raw');
  const base = (graded ? 420 : 48) * (0.5 + unit(key));
  const lowUsd = round(base * 0.78);
  const highUsd = round(base * 1.34);
  const percentile = Math.round(unit(`${key}:p`) * 100);
  return {
    currentUsd: round(lowUsd + ((highUsd - lowUsd) * percentile) / 100),
    lowUsd,
    highUsd,
    percentile,
    windowLabel: 'past 90 days',
  };
}
