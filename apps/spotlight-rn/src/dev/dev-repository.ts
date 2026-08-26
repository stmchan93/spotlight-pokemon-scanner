import {
  MockSpotlightRepository,
  type CardFavoriteEntry,
  type PortfolioPerformance,
  type PortfolioPerformanceRow,
  type SpotlightRepository,
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
