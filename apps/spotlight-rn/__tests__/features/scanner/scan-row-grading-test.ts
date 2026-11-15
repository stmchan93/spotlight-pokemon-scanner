import type { RawPricingMatrixVariant } from '@spotlight/api-client';

import {
  applyScanRowGradingPick,
  effectiveScanRowGrading,
  gradedPriceFromTrendRows,
  scanRowGradeOptions,
  scanRowInventoryTarget,
} from '@/features/scanner/scan-row-grading';
import { isPersistedPriceSelection } from '@/features/scanner/tray-row-codec';

const rawCapture = { mode: 'raw' as const, slabContext: null };
const slabCapture = {
  mode: 'slabs' as const,
  slabContext: { grader: 'PSA', grade: '9', certNumber: '12345678', variantName: 'PSA 9' },
};
const variants: RawPricingMatrixVariant[] = [{
  variant: 'Holofoil',
  variantKey: 'holofoil',
  conditions: [
    { code: 'NM', label: 'Near Mint', market: 10, low: null, mid: null, high: null },
    { code: 'LP', label: 'Lightly Played', market: 7, low: null, mid: null, high: null },
  ],
}];

describe('scan row grading', () => {
  it('offers 10 down to 1 in half grades', () => {
    expect(scanRowGradeOptions.map((option) => option.key)).toEqual([
      '10', '9.5', '9', '8.5', '8', '7.5', '7', '6.5', '6', '5.5', '5', '4.5', '4', '3.5', '3', '2.5', '2', '1.5', '1',
    ]);
  });

  it('a raw row starts on RAW; a grader pick defaults to 10 and RAW goes back', () => {
    expect(effectiveScanRowGrading(rawCapture, null)).toEqual({ grader: null, grade: null, isScanDefault: true });

    const psa = applyScanRowGradingPick(rawCapture, null, variants, 'grader', 'PSA');
    expect(psa?.grading).toEqual({ grader: 'PSA', grade: '10' });
    // Printing + NM condition come from the row's default printing.
    expect(psa).toEqual(expect.objectContaining({ variantKey: 'holofoil', conditionCode: 'near_mint', marketPrice: 10 }));

    const psa9 = applyScanRowGradingPick(rawCapture, psa, variants, 'detail', '9');
    expect(psa9?.grading).toEqual({ grader: 'PSA', grade: '9' });
    // Switching grader keeps the grade.
    expect(applyScanRowGradingPick(rawCapture, psa9, variants, 'grader', 'CGC')?.grading)
      .toEqual({ grader: 'CGC', grade: '9' });

    const raw = applyScanRowGradingPick(rawCapture, psa9, variants, 'grader', 'RAW');
    expect(raw?.grading).toBeUndefined();
    expect(raw?.marketPrice).toBe(10);
  });

  it('a RAW condition pick prices off the matrix and keeps the printing', () => {
    const lp = applyScanRowGradingPick(rawCapture, null, variants, 'detail', 'LP');
    expect(lp).toEqual(expect.objectContaining({
      variantKey: 'holofoil',
      conditionCode: 'lightly_played',
      conditionShortLabel: 'LP',
      marketPrice: 7,
    }));
  });

  it('a slab row starts on its detected grade, and RAW is an explicit pick', () => {
    expect(effectiveScanRowGrading(slabCapture, null)).toEqual({ grader: 'PSA', grade: '9', isScanDefault: true });
    expect(applyScanRowGradingPick(slabCapture, null, variants, 'grader', 'RAW')?.grading)
      .toEqual({ grader: null, grade: null });
    const psa10 = applyScanRowGradingPick(slabCapture, null, variants, 'detail', '10');
    expect(psa10?.grading).toEqual({ grader: 'PSA', grade: '10' });
    // Back on the detected grade = back on the scan's own default.
    expect(applyScanRowGradingPick(slabCapture, psa10, variants, 'detail', '9')?.grading).toBeUndefined();
  });

  it('files a grade pick as a graded holding, RAW with its condition', () => {
    expect(scanRowInventoryTarget(rawCapture, { conditionCode: 'near_mint', grading: { grader: 'PSA', grade: '9' } }))
      .toEqual({
        mode: 'slabs',
        conditionCode: null,
        slabContext: { grader: 'PSA', grade: '9', certNumber: null, variantName: 'PSA 9' },
      });
    expect(scanRowInventoryTarget(rawCapture, { conditionCode: 'lightly_played' }))
      .toEqual({ mode: 'raw', conditionCode: 'lightly_played', slabContext: null });
    // A slab left on its own grade keeps its cert.
    expect(scanRowInventoryTarget(slabCapture, null))
      .toEqual({ mode: 'slabs', conditionCode: null, slabContext: slabCapture.slabContext });
    expect(scanRowInventoryTarget(slabCapture, { conditionCode: 'near_mint', grading: { grader: null, grade: null } }))
      .toEqual({ mode: 'raw', conditionCode: 'near_mint', slabContext: null });
  });

  it('reads a grade price from the trend rows in USD only', () => {
    const rows = [
      { label: 'PSA 10', key: 'PSA 10', currentPrice: 120, currencyCode: 'USD', points: [] },
      { label: 'PSA 9.5', key: 'PSA 9.5', currentPrice: 80, currencyCode: 'USD', points: [] },
      { label: 'PSA 9', key: 'PSA 9', currentPrice: 4000, currencyCode: 'JPY', points: [] },
    ];
    expect(gradedPriceFromTrendRows(rows, 'PSA', '10')).toBe(120);
    expect(gradedPriceFromTrendRows(rows, 'psa', '9.5')).toBe(80);
    expect(gradedPriceFromTrendRows(rows, 'PSA', '9')).toBeNull();
    expect(gradedPriceFromTrendRows(rows, 'CGC', '10')).toBeNull();
    expect(gradedPriceFromTrendRows(null, 'PSA', '10')).toBeNull();
  });

  it('decodes old selections (no grading) and new ones; rejects a malformed grading', () => {
    const base = {
      variantKey: 'holofoil',
      variantLabel: 'Holofoil',
      conditionCode: 'near_mint',
      conditionShortLabel: 'NM',
      marketPrice: 10,
    };
    expect(isPersistedPriceSelection(base)).toBe(true);
    expect(isPersistedPriceSelection({ ...base, grading: { grader: 'PSA', grade: '9', marketPrice: 45 } })).toBe(true);
    expect(isPersistedPriceSelection({ ...base, grading: { grader: 'PSA', grade: '9' } })).toBe(true);
    expect(isPersistedPriceSelection({ ...base, grading: { grader: 9 } })).toBe(false);
  });
});
