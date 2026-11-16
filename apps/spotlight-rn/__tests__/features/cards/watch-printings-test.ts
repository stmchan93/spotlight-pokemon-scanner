import type { MarketHistoryOption } from '@spotlight/api-client';

import { findPrintingOption, resolveMainPrintingLabel } from '@/features/cards/watch-printings';

// Computer Search after the merge: TCGplayer's "Normal" is an alias of Scrydex's "Unlimited".
const computerSearch: MarketHistoryOption[] = [
  { id: 'Unlimited Shadowless', label: 'Unlimited Shadowless' },
  { id: 'Unlimited', label: 'Unlimited', aliases: ['Normal'] },
  { id: 'First Edition Shadowless', label: 'First Edition Shadowless' },
];

describe('findPrintingOption', () => {
  it('matches a label case-insensitively', () => {
    expect(findPrintingOption(computerSearch, 'unlimited shadowless')?.id).toBe('Unlimited Shadowless');
  });

  it('matches an alias: a "Normal" copy selects the merged Unlimited chip', () => {
    expect(findPrintingOption(computerSearch, 'Normal')?.id).toBe('Unlimited');
    expect(findPrintingOption(computerSearch, ' normal ')?.id).toBe('Unlimited');
  });

  it('a label beats an alias, and unknown or blank names match nothing', () => {
    const both: MarketHistoryOption[] = [
      { id: 'Unlimited', label: 'Unlimited', aliases: ['Normal'] },
      { id: 'Normal', label: 'Normal' },
    ];
    expect(findPrintingOption(both, 'Normal')?.id).toBe('Normal');
    expect(findPrintingOption(computerSearch, 'Holofoil')).toBeUndefined();
    expect(findPrintingOption(computerSearch, null)).toBeUndefined();
    expect(findPrintingOption(computerSearch, '')).toBeUndefined();
  });

  it('options without aliases (older backends) behave exactly as before', () => {
    const modern: MarketHistoryOption[] = [
      { id: 'Normal', label: 'Normal' },
      { id: 'Holofoil', label: 'Holofoil' },
      { id: 'Reverse Holofoil', label: 'Reverse Holofoil' },
    ];
    expect(findPrintingOption(modern, 'Holofoil')?.id).toBe('Holofoil');
    expect(findPrintingOption(modern, 'Unlimited')).toBeUndefined();
  });
});

describe('resolveMainPrintingLabel', () => {
  it('resolves the server default through an alias', () => {
    expect(resolveMainPrintingLabel(computerSearch, 'Normal')).toBe('Unlimited');
    expect(resolveMainPrintingLabel(computerSearch, 'Unlimited')).toBe('Unlimited');
  });
});
