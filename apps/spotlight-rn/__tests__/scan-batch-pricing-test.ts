import type { CatalogSearchResult, RawPricingMatrixVariant } from '@spotlight/api-client';

import {
  matchedPrintingLabel,
  matchedPrintingSelection,
  printingAbbreviation,
  resolveMatchedPrintingDefaults,
} from '@/features/scanner/scan-batch-pricing';
import type { ScanPriceSheetSelection } from '@/features/scanner/screens/scan-price-sheet';
import type { RecentCapture } from '@/features/scanner/screens/scanner-screen-types';

/*
  The binder tile names a printing on the SAME line as the price, which leaves
  it about half a ~100pt tile. These have to READ — an ellipsized "Reverse
  Holof…" tells the user nothing (user, 2026-09-10).
*/
describe('printingAbbreviation', () => {
  it('shortens the printings the batch dropdown offers', () => {
    expect(printingAbbreviation('Normal')).toBe('Normal');
    expect(printingAbbreviation('Holofoil')).toBe('Holo');
    expect(printingAbbreviation('Reverse Holofoil')).toBe('Rev Holo');
    expect(printingAbbreviation('Unlimited')).toBe('Unltd');
    expect(printingAbbreviation('1st Edition')).toBe('1st Ed');
    expect(printingAbbreviation('First Edition')).toBe('1st Ed');
  });

  it('drops trailing words rather than truncating mid-word', () => {
    // "Crk Ice Holo" is 12 characters; the words that survive stay whole.
    expect(printingAbbreviation('Cracked Ice Holofoil')).toBe('Crk Ice');
  });

  it('marks a single over-long word as an abbreviation', () => {
    expect(printingAbbreviation('Prerelease')).toBe('Prerelea.');
  });

  it('is stable on whitespace and empty input', () => {
    expect(printingAbbreviation('  Reverse   Holofoil ')).toBe('Rev Holo');
    expect(printingAbbreviation('   ')).toBe('');
  });

  it('leaves a printing it has no shorthand for alone when it already fits', () => {
    expect(printingAbbreviation('Poke Ball')).toBe('Poke Ball');
  });
});

describe('matched alt-art printing default', () => {
  const variants: RawPricingMatrixVariant[] = [
    {
      variant: 'Normal',
      variantKey: 'normal',
      conditions: [{ code: 'NM', market: 2 }, { code: 'LP', market: 1.5 }],
    },
    {
      variant: 'Manga Alt Art',
      variantKey: 'manga-alt-art',
      conditions: [{ code: 'NM', market: 400 }],
    },
  ] as RawPricingMatrixVariant[];
  const variantsByCardId = new Map([['op-1', variants]]);

  function candidate(matchedLabel?: string | null): CatalogSearchResult {
    return {
      id: 'op-1',
      cardId: 'op-1',
      name: 'Monkey.D.Luffy',
      cardNumber: '#OP05-119',
      setName: 'Awakening of the New Era',
      imageUrl: 'https://img/luffy.png',
      currencyCode: 'USD',
      marketPrice: 2,
      ...(matchedLabel === undefined
        ? {}
        : {
          matchedVariant: matchedLabel === null
            ? null
            : { label: matchedLabel, tcgplayerProductId: '527026', imageUrl: null, source: 'tcgplayer' },
        }),
    };
  }

  function capture(id: string, entry: CatalogSearchResult, overrides: Partial<RecentCapture> = {}): RecentCapture {
    return {
      id,
      mode: 'raw',
      candidates: [entry],
      activeCandidateIndex: 0,
      isLoadingCandidates: false,
      ...overrides,
    } as RecentCapture;
  }

  it('defaults the printing to the matched label, priced from the matrix', () => {
    const selection = matchedPrintingSelection(candidate('manga alt  art'), variants);
    expect(selection).toMatchObject({
      variantKey: 'manga-alt-art',
      variantLabel: 'Manga Alt Art',
      conditionCode: 'near_mint',
      marketPrice: 400,
      variantIsNonDefault: true,
    });
  });

  it('falls back to the default printing when the label is not in the matrix', () => {
    expect(matchedPrintingSelection(candidate('Special Alt Art'), variants)).toBeNull();
    expect(resolveMatchedPrintingDefaults(
      [capture('c1', candidate('Special Alt Art'))],
      new Map(),
      variantsByCardId,
    )).toEqual([]);
  });

  it('changes nothing when the field is absent or null, or the matrix has not landed', () => {
    expect(matchedPrintingLabel(candidate())).toBeNull();
    expect(matchedPrintingLabel(candidate(null))).toBeNull();
    expect(resolveMatchedPrintingDefaults(
      [capture('c1', candidate()), capture('c2', candidate(null))],
      new Map(),
      variantsByCardId,
    )).toEqual([]);
    expect(resolveMatchedPrintingDefaults(
      [capture('c1', candidate('Manga Alt Art'))],
      new Map(),
      new Map(),
    )).toEqual([]);
  });

  it("never overrides a row that already has a selection (the user's pick wins)", () => {
    const userPick: ScanPriceSheetSelection = {
      variantKey: 'normal',
      variantLabel: 'Normal',
      conditionCode: 'lightly_played',
      conditionShortLabel: 'LP',
      marketPrice: 1.5,
    };
    const entries = resolveMatchedPrintingDefaults(
      [capture('picked', candidate('Manga Alt Art')), capture('fresh', candidate('Manga Alt Art'))],
      new Map([['picked', userPick]]),
      variantsByCardId,
    );
    expect(entries.map((entry) => entry.captureId)).toEqual(['fresh']);
    expect(entries[0].selection.variantLabel).toBe('Manga Alt Art');
  });

  it('skips loading, slab, and empty binder-pocket rows', () => {
    const matched = candidate('Manga Alt Art');
    expect(resolveMatchedPrintingDefaults(
      [
        capture('loading', matched, { isLoadingCandidates: true }),
        capture('slab', matched, { mode: 'slabs' }),
        capture('empty', matched, { binderPage: { empty: true } as RecentCapture['binderPage'] }),
      ],
      new Map(),
      variantsByCardId,
    )).toEqual([]);
  });
});
