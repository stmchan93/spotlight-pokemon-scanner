import { colors } from '@spotlight/design-system';

import {
  matchConfidenceColor,
  matchPercentFromScore,
} from '@/features/scanner/screens/change-card-picker-helpers';

describe('matchPercentFromScore', () => {
  it('converts a normalized [0,1] score to an integer percentage', () => {
    expect(matchPercentFromScore(0)).toBe(0);
    expect(matchPercentFromScore(0.21)).toBe(21);
    expect(matchPercentFromScore(0.5)).toBe(50);
    expect(matchPercentFromScore(1)).toBe(100);
  });

  it('rounds to the nearest whole percent', () => {
    expect(matchPercentFromScore(0.214)).toBe(21);
    expect(matchPercentFromScore(0.215)).toBe(22);
    expect(matchPercentFromScore(0.666)).toBe(67);
  });

  it('returns null for missing or non-finite scores', () => {
    expect(matchPercentFromScore(null)).toBeNull();
    expect(matchPercentFromScore(undefined)).toBeNull();
    expect(matchPercentFromScore(Number.NaN)).toBeNull();
    expect(matchPercentFromScore(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('matchConfidenceColor', () => {
  it('uses red below 34%', () => {
    expect(matchConfidenceColor(0)).toBe(colors.danger);
    expect(matchConfidenceColor(21)).toBe(colors.danger);
    expect(matchConfidenceColor(33)).toBe(colors.danger);
  });

  it('uses yellow from 34% through 66%', () => {
    expect(matchConfidenceColor(34)).toBe(colors.warning);
    expect(matchConfidenceColor(50)).toBe(colors.warning);
    expect(matchConfidenceColor(66)).toBe(colors.warning);
  });

  it('uses green at 67% and above', () => {
    expect(matchConfidenceColor(67)).toBe(colors.success);
    expect(matchConfidenceColor(80)).toBe(colors.success);
    expect(matchConfidenceColor(100)).toBe(colors.success);
  });
});
