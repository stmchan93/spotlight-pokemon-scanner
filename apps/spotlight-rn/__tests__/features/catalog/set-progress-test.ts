import type { CatalogSearchResult, ExpansionRecord, InventoryCardEntry } from '@spotlight/api-client';

import {
  completionCountLabel,
  filterSetCards,
  formatSetReleaseDate,
  groupSetsByEra,
  ownedCopyLabel,
  ownedCountsByExpansion,
  rarityChipsForCards,
  setCompletion,
} from '@/features/catalog/set-progress';

jest.mock('@spotlight/api-client', () => require('../../mock-api-client'));

function card(overrides: Partial<CatalogSearchResult> & { cardId: string }): CatalogSearchResult {
  return {
    id: overrides.cardId,
    name: 'Card',
    cardNumber: '#001/120',
    setName: 'Set',
    imageUrl: '',
    ...overrides,
  };
}

describe('setCompletion', () => {
  it('is 0% (not NaN) for a set with no cards', () => {
    expect(setCompletion(0, 0)).toEqual({ owned: 0, total: 0, fraction: 0, percent: 0 });
  });

  it('treats a set missing from the progress response as 0 owned', () => {
    const owned = ownedCountsByExpansion({ game: 'pokemon', sets: [{ expansionId: 'sv8', ownedCount: 3 }] });
    const completion = setCompletion(120, owned.sv3pt5);
    expect(completion).toMatchObject({ owned: 0, total: 120, percent: 0, fraction: 0 });
    expect(completionCountLabel(completion!)).toBe('0 of 120 CARDS');
  });

  it('reads 100% only when every card is owned', () => {
    expect(setCompletion(120, 120)).toMatchObject({ percent: 100, fraction: 1 });
    // 199/200 rounds to 100 — the label must not claim a finished set.
    expect(setCompletion(200, 199)?.percent).toBe(99);
    expect(setCompletion(135, 84)?.percent).toBe(62);
  });

  it('hides completion when the total is unknown (older backend)', () => {
    expect(setCompletion(undefined, 5)).toBeNull();
    expect(setCompletion(null, 5)).toBeNull();
  });

  it('never reports more owned than the set holds', () => {
    expect(setCompletion(10, 14)).toMatchObject({ owned: 10, percent: 100 });
  });
});

describe('formatSetReleaseDate', () => {
  it('renders M/D/YYYY from either separator without a timezone slip', () => {
    expect(formatSetReleaseDate('2026-05-22')).toBe('5/22/2026');
    expect(formatSetReleaseDate('2026/01/09')).toBe('1/9/2026');
    expect(formatSetReleaseDate(null)).toBeNull();
  });
});

describe('rarityChipsForCards', () => {
  it('lists only the buckets present, in chip order, never standard/other', () => {
    const chips = rarityChipsForCards([
      card({ cardId: 'a', rarityBucket: 'ultra' }),
      card({ cardId: 'b', rarityBucket: 'standard' }),
      card({ cardId: 'c', rarityBucket: 'secret' }),
      card({ cardId: 'd', rarityBucket: 'other' }),
      card({ cardId: 'e' }),
    ]);
    expect(chips.map((chip) => chip.label)).toEqual(['HR', 'ULTRA RARE']);
  });

  it('labels the same buckets in each game\'s own shorthand', () => {
    const cards = [
      card({ cardId: 'a', rarityBucket: 'secret' }),
      card({ cardId: 'b', rarityBucket: 'illustration' }),
    ];
    expect(rarityChipsForCards(cards, 'pokemon').map((chip) => chip.label)).toEqual(['HR', 'IR']);
    expect(rarityChipsForCards(cards, 'onepiece').map((chip) => chip.label)).toEqual(['SEC', 'MANGA']);
    expect(rarityChipsForCards(cards, 'lorcana').map((chip) => chip.label)).toEqual(['ICONIC', 'ENCHANTED']);
  });
});

describe('filterSetCards', () => {
  const cards = [
    card({ cardId: 'a', name: 'Gengar', cardNumber: '#001/120', rarityBucket: 'standard' }),
    card({ cardId: 'b', name: 'Gengar ex', cardNumber: '#125/120', rarityBucket: 'secret' }),
    card({ cardId: 'c', name: 'Pikachu', cardNumber: '#025/120', rarityBucket: 'standard' }),
  ];

  it('matches name or number and applies the rarity chip', () => {
    expect(filterSetCards(cards, 'gengar', null).map((c) => c.cardId)).toEqual(['a', 'b']);
    expect(filterSetCards(cards, '25', null).map((c) => c.cardId)).toEqual(['c']);
    expect(filterSetCards(cards, 'gengar', 'secret').map((c) => c.cardId)).toEqual(['b']);
  });
});

describe('ownedCopyLabel', () => {
  it('names raw copies by printing + condition and slabs by grader + grade', () => {
    const base = { id: 'x', cardId: 'a', name: 'A', cardNumber: '1', setName: 'S', imageUrl: '', marketPrice: 0, hasMarketPrice: false, currencyCode: 'USD', quantity: 1, addedAt: '' };
    expect(ownedCopyLabel({ ...base, kind: 'raw', variantName: 'Holofoil', conditionLabel: 'Near Mint' } as InventoryCardEntry))
      .toBe('Holofoil · Near Mint');
    expect(ownedCopyLabel({
      ...base,
      kind: 'graded',
      slabContext: { grader: 'PSA', grade: '10', certNumber: null, variantName: 'PSA 10' },
    } as InventoryCardEntry)).toBe('PSA 10');
  });
});

function set(id: string, releaseDate: string, era: string | null, isPromo = false): ExpansionRecord {
  return { id, name: id, series: era, code: null, releaseDate, imageUrl: null, era, isPromo };
}

function rowLabels(expansions: ExpansionRecord[]): string[] {
  return groupSetsByEra(expansions).map((row) => (row.kind === 'era' ? `# ${row.era}` : row.expansion.id));
}

describe('groupSetsByEra', () => {
  it("orders eras newest first by their newest MAIN set, promos after each era's mains", () => {
    // Backend order: newest first. A brand-new promo in the old era must not
    // pull that era above the newer one.
    const expansions = [
      set('sv-promo-2026', '2026/11/06', 'Scarlet & Violet', true),
      set('me2', '2025/11/14', 'Mega Evolution'),
      set('mep', '2025/09/26', 'Mega Evolution', true),
      set('me1', '2025/09/26', 'Mega Evolution'),
      set('sv10', '2025/05/30', 'Scarlet & Violet'),
      set('svp', '2023/01/01', 'Scarlet & Violet', true),
      set('sv1', '2023/03/31', 'Scarlet & Violet'),
    ];
    expect(rowLabels(expansions)).toEqual([
      '# Mega Evolution',
      'me2',
      'me1',
      'mep',
      '# Scarlet & Violet',
      'sv10',
      'sv1',
      'sv-promo-2026',
      'svp',
    ]);
  });

  it('keeps games without eras flat, newest first, promos last', () => {
    const expansions = [
      set('op-promo', '2026/01/01', null, true),
      set('op10', '2025/03/21', null),
      set('op01', '2022/12/02', null),
    ];
    expect(rowLabels(expansions)).toEqual(['op10', 'op01', 'op-promo']);
  });

  it("leaves an older backend's list (no era / isPromo) untouched", () => {
    const legacy: ExpansionRecord[] = [
      { id: 'b', name: 'b', series: null, code: null, releaseDate: '2025/01/01', imageUrl: null },
      { id: 'a', name: 'a', series: null, code: null, releaseDate: '2024/01/01', imageUrl: null },
    ];
    expect(rowLabels(legacy)).toEqual(['b', 'a']);
  });
});
