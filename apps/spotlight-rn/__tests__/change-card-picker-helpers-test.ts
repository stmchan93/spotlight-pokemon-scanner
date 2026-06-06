import { matchConfidence } from '@spotlight/design-system';

import {
  matchConfidenceColor,
  matchConfidenceLevel,
  matchPercentFromScore,
  matchPillColors,
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
  it('uses the red caption color below 34%', () => {
    expect(matchConfidenceColor(0)).toBe(matchConfidence.red.text);
    expect(matchConfidenceColor(33)).toBe(matchConfidence.red.text);
  });

  it('uses the yellow caption color from 34% through 66%', () => {
    expect(matchConfidenceColor(34)).toBe(matchConfidence.yellow.text);
    expect(matchConfidenceColor(66)).toBe(matchConfidence.yellow.text);
  });

  it('uses the green caption color at 67% and above', () => {
    expect(matchConfidenceColor(67)).toBe(matchConfidence.green.text);
    expect(matchConfidenceColor(100)).toBe(matchConfidence.green.text);
  });
});

describe('matchConfidenceLevel', () => {
  it('returns red below 34%', () => {
    expect(matchConfidenceLevel(0)).toBe('red');
    expect(matchConfidenceLevel(33)).toBe('red');
  });

  it('returns yellow from 34% through 66%', () => {
    expect(matchConfidenceLevel(34)).toBe('yellow');
    expect(matchConfidenceLevel(66)).toBe('yellow');
  });

  it('returns green at 67% and above', () => {
    expect(matchConfidenceLevel(67)).toBe('green');
    expect(matchConfidenceLevel(100)).toBe('green');
  });
});

describe('matchPillColors', () => {
  it('returns red chip colors below 34%', () => {
    expect(matchPillColors(0)).toEqual({
      backgroundColor: matchConfidence.red.chipBg,
      color: matchConfidence.red.chipText,
    });
  });

  it('returns yellow chip colors from 34% through 66%', () => {
    expect(matchPillColors(50)).toEqual({
      backgroundColor: matchConfidence.yellow.chipBg,
      color: matchConfidence.yellow.chipText,
    });
  });

  it('returns green chip colors at 67% and above', () => {
    expect(matchPillColors(80)).toEqual({
      backgroundColor: matchConfidence.green.chipBg,
      color: matchConfidence.green.chipText,
    });
  });
});
