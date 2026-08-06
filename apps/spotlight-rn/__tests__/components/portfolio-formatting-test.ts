import {
  formatAbbreviatedCurrency,
} from '../../src/features/portfolio/components/portfolio-formatting';

describe('formatAbbreviatedCurrency', () => {
  it('abbreviates thousands to one decimal (Figma 2749:4753)', () => {
    expect(formatAbbreviatedCurrency(10342.18)).toBe('$10.3k');
    expect(formatAbbreviatedCurrency(1000)).toBe('$1k');
  });

  it('drops a trailing .0 so a round total reads clean', () => {
    expect(formatAbbreviatedCurrency(10000)).toBe('$10k');
    expect(formatAbbreviatedCurrency(2000000)).toBe('$2M');
  });

  it('steps up through M / B / T', () => {
    expect(formatAbbreviatedCurrency(1250000)).toBe('$1.3M');
    expect(formatAbbreviatedCurrency(4300000000)).toBe('$4.3B');
    expect(formatAbbreviatedCurrency(1100000000000)).toBe('$1.1T');
  });

  it('shows sub-$1k amounts exactly rather than as "$0.9k"', () => {
    expect(formatAbbreviatedCurrency(942)).toBe('$942');
    expect(formatAbbreviatedCurrency(9.5)).toBe('$9.5');
    expect(formatAbbreviatedCurrency(0)).toBe('$0.00');
  });

  it('keeps the sign on a negative total', () => {
    expect(formatAbbreviatedCurrency(-10342.18)).toBe('-$10.3k');
  });
});
