import {
  MockSpotlightRepository,
  type CardFavoriteEntry,
  type PortfolioPerformance,
  type PortfolioPerformanceRow,
  type SpotlightRepository,
  type TopMovers,
} from '@spotlight/api-client';

import { devImageUriForUrl } from '@/dev/dev-fixtures';

/**
 * The repository behind dev screen routes: the stock in-memory mock (fixed
 * clock, seeded catalog/inventory) with two adjustments for reproducible
 * screenshots:
 *   - wishlist favorites are pre-seeded (the mock starts empty, which would
 *     screenshot the empty state)
 *   - every image URL in every result is rewritten to a bundled local asset,
 *     removing the images.pokemontcg.io network dependency
 */

// Fixed timestamps, not new Date(): setCardFavorite's wall-clock stamps can
// tie at millisecond resolution, which flips the wishlist's newest-first sort
// between reloads and breaks pixel reproducibility. Only cards present in
// mock-data's `mockCardDetails` resolve into favorite rows — others are
// silently dropped by the mock's getCardFavorites.
const seededFavorites: readonly [cardId: string, favoritedAt: string][] = [
  ['mcdonalds25-21', '2026-04-21T18:12:00.000Z'],
  ['xyp-111', '2026-04-21T18:11:00.000Z'],
  ['sm7-1', '2026-04-21T18:10:00.000Z'],
];

// Per-card favorite overrides so dev screenshots exercise every content SHAPE
// the Figma rows show — a graded (slab-framed, "PSA 10") row and a whole-dollar
// price (formatter drops the ".00") — not just the raw/cents happy path. That
// gap is exactly how the missing grade line and "$1,100.00" both slipped past
// the first sync.
const devFavoriteOverrides: Record<string, Partial<CardFavoriteEntry>> = {
  'mcdonalds25-21': {
    conditionLabel: null,
    kind: 'graded',
    marketPrice: 1100,
    slabContext: { grade: '10', grader: 'PSA' },
  },
};

// PDP detail overrides: the browse-state PDP renders a release/illustrator
// line and a like count that the base mock never populates — cover those
// content shapes so screenshots exercise them (same lesson as the favorites
// overrides above).
const devCardDetailOverrides: Record<string, Record<string, unknown>> = {
  'sm7-1': {
    artist: 'Ken Sugimori',
    likeCount: 10100,
    releaseDate: '2018-09-07',
  },
};

// Insights overrides: the mock's derived rows are all raw/NM with empty
// sparklines — these cover the graded, variant, long-name, up/down shapes.
// entry-5 stays untouched as the null-history "—" row.
const devPerformanceRowOverrides: Record<string, Partial<PortfolioPerformanceRow>> = {
  'entry-1': {
    sparkline: [0.3, 0.33, 0.31, 0.36, 0.38],
    monthGainDollar: 0.06,
    monthGainPercent: 19,
    ytdGainPercent: 26.7,
  },
  'entry-2': {
    kind: 'graded',
    grade: 'PSA 10',
    condition: null,
    sparkline: [0.5, 0.52, 0.5, 0.56],
    monthGainDollar: 0.12,
    monthGainPercent: 12,
    ytdGainPercent: 12,
  },
  'entry-3': {
    sparkline: [45.2, 41.8, 39.9, 37.54],
    monthGainDollar: -7.66,
    monthGainPercent: -17,
    ytdGainPercent: -17,
  },
  'entry-4': {
    variantName: 'Reverse Holofoil',
    sparkline: [40.1, 42.4, 44.0, 46.57],
    monthGainDollar: 6.47,
    monthGainPercent: 16,
    ytdGainPercent: 16,
  },
  'entry-6': {
    name: 'Origin Forme Palkia VSTAR',
    sparkline: [12.4, 13.1, 14.2, 15.09],
    monthGainDollar: 2.69,
    monthGainPercent: 21,
    ytdGainPercent: 21,
  },
};

// Top Trends (Figma 4969:4101): two games x three movers, covering the label
// shapes the tiles must handle — a three-digit move (no decimal), a modest
// one (one decimal), a decline, a JP printing (" · JP" marker), a set with no
// code, and a whole-dollar price. Card ids reuse the mock catalog so a tap
// lands on a PDP that resolves.
const devTopMovers: TopMovers = {
  windowDays: 30,
  computedAt: '2026-04-21T18:00:00.000Z',
  asOfDate: '2026-04-21',
  games: [
    {
      game: 'pokemon',
      items: [
        {
          cardId: 'sm7-1',
          game: 'pokemon',
          name: 'Celebi',
          number: '1',
          setCode: 'SM7',
          setName: 'Celestial Storm',
          language: 'English',
          imageUrl: 'https://images.pokemontcg.io/sm7/1.png',
          priceNow: 12.4,
          priceThen: 3.9,
          changePercent: 217.9,
          currencyCode: 'USD',
          sparkPoints: [3.9, 4.2, 4.1, 6.8, 9.3, 11.0, 12.4],
        },
        {
          cardId: 'xyp-111',
          game: 'pokemon',
          name: 'Celebi',
          number: 'XY111',
          setCode: 'XYP',
          setName: 'XY Black Star Promos',
          language: 'English',
          imageUrl: 'https://images.pokemontcg.io/xyp/XY111.png',
          priceNow: 37.54,
          priceThen: 33.36,
          changePercent: 12.5,
          currencyCode: 'USD',
          sparkPoints: [33.36, 34.1, 33.9, 35.2, 36.4, 37.54],
        },
        {
          cardId: 'mcdonalds25-21',
          game: 'pokemon',
          name: 'Oshawott',
          number: '21',
          setCode: null,
          setName: "McDonald's Collection 2021",
          language: 'Japanese',
          imageUrl: 'https://images.pokemontcg.io/mcdonalds25/21.png',
          priceNow: 1100,
          priceThen: 1240.5,
          changePercent: -11.3,
          currencyCode: 'USD',
          sparkPoints: [1240.5, 1210, 1180.25, 1150, 1120, 1100],
        },
      ],
    },
    {
      game: 'onepiece',
      items: [
        {
          cardId: 'sm7-1',
          game: 'onepiece',
          name: 'Monkey.D.Luffy',
          number: 'OP05-119',
          setCode: 'OP05',
          setName: 'Awakening of the New Era',
          language: 'English',
          imageUrl: 'https://images.pokemontcg.io/sm7/1.png',
          priceNow: 486,
          priceThen: 312.75,
          changePercent: 55.4,
          currencyCode: 'USD',
          sparkPoints: [312.75, 330, 358.5, 401, 455.2, 486],
        },
        {
          cardId: 'xyp-111',
          game: 'onepiece',
          name: 'Shanks',
          number: 'OP01-120',
          setCode: 'OP01',
          setName: 'Romance Dawn',
          language: 'English',
          imageUrl: 'https://images.pokemontcg.io/xyp/XY111.png',
          priceNow: 129.99,
          priceThen: 98.4,
          changePercent: 32.1,
          currencyCode: 'USD',
          sparkPoints: [98.4, 101.2, 110.9, 118, 124.5, 129.99],
        },
        {
          cardId: 'mcdonalds25-21',
          game: 'onepiece',
          name: 'Nami',
          number: 'OP03-040',
          setCode: 'OP03',
          setName: 'Pillars of Strength',
          language: 'English',
          imageUrl: 'https://images.pokemontcg.io/mcdonalds25/21.png',
          priceNow: 42.1,
          priceThen: 51.3,
          changePercent: -17.9,
          currencyCode: 'USD',
          sparkPoints: [51.3, 49.8, 47.2, 45.9, 43.5, 42.1],
        },
      ],
    },
  ],
};

const imageUrlKeyPattern = /image.*url|url.*image|avatarurl/i;

function rewriteImageUrls<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => rewriteImageUrls(item)) as T;
  }
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
      const child = source[key];
      if (typeof child === 'string' && imageUrlKeyPattern.test(key) && /^https?:\/\//i.test(child)) {
        next[key] = devImageUriForUrl(child);
      } else {
        next[key] = rewriteImageUrls(child);
      }
    }
    return next as T;
  }
  return value;
}

function withLocalImages(repository: SpotlightRepository): SpotlightRepository {
  return new Proxy(repository, {
    get(target, property, receiver) {
      // Served wholesale rather than derived from the mock's catalog: the mock
      // has no price history to compute movers from, and the rail needs fixed
      // numbers anyway (see devTopMovers).
      if (property === 'getTopMovers') {
        return async () => rewriteImageUrls(devTopMovers);
      }
      const original = Reflect.get(target, property, receiver);
      if (typeof original !== 'function') {
        return original;
      }
      const applyOverrides = (resolved: unknown) => {
        const rewritten = rewriteImageUrls(resolved);
        if (property === 'getCardFavorites' && Array.isArray(rewritten)) {
          return rewritten.map((entry) => {
            const override = devFavoriteOverrides[(entry as CardFavoriteEntry).cardId];
            return override ? { ...(entry as CardFavoriteEntry), ...override } : entry;
          });
        }
        if (
          property === 'getCardDetail' &&
          rewritten &&
          typeof rewritten === 'object' &&
          'cardId' in rewritten
        ) {
          const override = devCardDetailOverrides[String((rewritten as { cardId: unknown }).cardId)];
          return override ? { ...rewritten, ...override } : rewritten;
        }
        if (
          property === 'getPortfolioPerformance' &&
          rewritten &&
          typeof rewritten === 'object' &&
          'rows' in rewritten
        ) {
          const performance = rewritten as PortfolioPerformance;
          return {
            ...performance,
            rows: performance.rows.map((perfRow) => {
              const override = devPerformanceRowOverrides[perfRow.entryId];
              return override ? { ...perfRow, ...override } : perfRow;
            }),
          };
        }
        return rewritten;
      };
      return (...args: unknown[]) => {
        const result = original.apply(target, args);
        if (result instanceof Promise) {
          return result.then(applyOverrides);
        }
        return applyOverrides(result);
      };
    },
  });
}

export async function createDevRepository(): Promise<SpotlightRepository> {
  const mock = new MockSpotlightRepository();
  // Private-field poke: the mock has no API for seeding favorites at a fixed
  // time, and dev screenshots need one (see seededFavorites).
  const favoriteTimestamps = (
    mock as unknown as { favoriteCardTimestamps: Map<string, string> }
  ).favoriteCardTimestamps;
  for (const [cardId, favoritedAt] of seededFavorites) {
    favoriteTimestamps.set(cardId, favoritedAt);
  }
  return withLocalImages(mock);
}
