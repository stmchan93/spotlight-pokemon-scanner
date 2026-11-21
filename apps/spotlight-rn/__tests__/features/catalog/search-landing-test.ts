import type { ExpansionRecord } from '@spotlight/api-client';

import {
  formatCompactCount,
  resultsCountLabel,
  singlesSourceSets,
  totalCardCount,
} from '@/features/catalog/search-landing';

function set(overrides: Partial<ExpansionRecord> & { id: string }): ExpansionRecord {
  return {
    name: overrides.id,
    series: null,
    code: null,
    language: 'English',
    releaseDate: null,
    imageUrl: null,
    ...overrides,
  };
}

describe('formatCompactCount', () => {
  it.each([
    [0, '0'],
    [182, '182'],
    [999, '999'],
    [1000, '1K'],
    [1234, '1.2K'],
    [9960, '10K'],
    [44123, '44K'],
    [999_499, '999K'],
    [999_500, '1M'],
    [2_345_678, '2.3M'],
  ])('%d → %s', (value, label) => {
    expect(formatCompactCount(value)).toBe(label);
  });
});

describe('resultsCountLabel', () => {
  it('wraps a known count and hides an unknown one', () => {
    expect(resultsCountLabel(44123)).toBe('(44K RESULTS)');
    expect(resultsCountLabel(null)).toBeNull();
  });
});

describe('totalCardCount', () => {
  it('sums the sets that carry a count', () => {
    expect(totalCardCount([set({ id: 'a', cardCount: 120 }), set({ id: 'b' }), set({ id: 'c', cardCount: 80 })])).toBe(200);
  });

  it('is unknown when no set carries one (older backend)', () => {
    expect(totalCardCount([set({ id: 'a' })])).toBeNull();
    expect(totalCardCount([])).toBeNull();
  });
});

describe('singlesSourceSets', () => {
  it('skips promos and empty sets, puts English first, keeps list order', () => {
    const sources = singlesSourceSets([
      set({ id: 'jp-new', language: 'Japanese', cardCount: 100 }),
      set({ id: 'promo', isPromo: true, cardCount: 40 }),
      set({ id: 'empty', cardCount: 0 }),
      set({ id: 'en-1', cardCount: 200 }),
      set({ id: 'en-2' }),
      set({ id: 'en-3', language: null, cardCount: 10 }),
    ]);
    expect(sources.map((source) => source.id)).toEqual(['en-1', 'en-2', 'en-3']);
  });

  it('falls back to other languages when there is no English set', () => {
    expect(singlesSourceSets([set({ id: 'jp', language: 'Japanese', cardCount: 5 })]).map((s) => s.id)).toEqual(['jp']);
  });
});
