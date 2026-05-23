import {
  formatCompactCurrency,
  formatCurrency,
  formatOptionalCurrency,
  formatPercent,
  formatSignedCurrency,
} from '@/features/portfolio/components/portfolio-formatting';

// Intl currency output uses a non-breaking space between certain prefixes and
// digits (e.g. `CA$1,234.00`). Tests compare using the actual produced string
// rather than hardcoding a specific Unicode whitespace.
function intlCurrency(value: number, currency = 'USD') {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

describe('formatCurrency', () => {
  it('formats a positive USD value with 2 fraction digits', () => {
    expect(formatCurrency(1234.5)).toBe('$1,234.50');
  });

  it('defaults to USD when no currency code is supplied', () => {
    expect(formatCurrency(0)).toBe('$0.00');
  });

  it('respects an explicit currency code', () => {
    // Intl output varies across ICU versions (e.g. `CA$1,234.00` vs `$1,234.00`
    // depending on platform). Compare against the same formatter to stay stable.
    expect(formatCurrency(1234, 'CAD')).toBe(intlCurrency(1234, 'CAD'));
  });

  it('formats negative values with the locale-standard minus prefix', () => {
    expect(formatCurrency(-42.1)).toBe('-$42.10');
  });

  it('handles large numbers with grouping separators', () => {
    expect(formatCurrency(1_234_567.89)).toBe('$1,234,567.89');
  });
});

describe('formatOptionalCurrency', () => {
  it('returns em-dash for null', () => {
    expect(formatOptionalCurrency(null)).toBe('—');
  });

  it('returns em-dash for undefined', () => {
    expect(formatOptionalCurrency(undefined)).toBe('—');
  });

  it('formats numeric values just like formatCurrency', () => {
    expect(formatOptionalCurrency(99.99)).toBe('$99.99');
  });

  it('passes the currency code through to the underlying formatter', () => {
    expect(formatOptionalCurrency(50, 'EUR')).toBe(intlCurrency(50, 'EUR'));
  });

  it('formats explicit zero (not as em-dash)', () => {
    expect(formatOptionalCurrency(0)).toBe('$0.00');
  });
});

describe('formatSignedCurrency', () => {
  it('adds a plus sign to positive values', () => {
    expect(formatSignedCurrency(125)).toBe('+$125.00');
  });

  it('treats zero as non-negative and prefixes a plus sign', () => {
    expect(formatSignedCurrency(0)).toBe('+$0.00');
  });

  it('adds a minus sign to negative values without doubling it', () => {
    // formatCurrency on the absolute value never emits a minus, so the result
    // should be exactly one leading minus.
    expect(formatSignedCurrency(-42.1)).toBe('-$42.10');
  });

  it('passes the currency code through', () => {
    expect(formatSignedCurrency(10, 'GBP')).toBe(`+${intlCurrency(10, 'GBP')}`);
  });
});

describe('formatPercent', () => {
  it('formats whole numbers with two fraction digits', () => {
    expect(formatPercent(10)).toBe('+10.00%');
  });

  it('rounds at the second fraction digit', () => {
    // 1.015 happens to be stored as 1.01499... so it rounds down with
    // toFixed(2). Use a value with a clean binary representation to avoid
    // platform/runtime drift around banker's rounding.
    expect(formatPercent(1.236)).toBe('+1.24%');
    expect(formatPercent(1.234)).toBe('+1.23%');
  });

  it('handles negative values', () => {
    expect(formatPercent(-3.5)).toBe('-3.50%');
  });

  it('handles zero', () => {
    expect(formatPercent(0)).toBe('0.00%');
  });
});

describe('formatCompactCurrency', () => {
  it('returns $0.00 for zero', () => {
    expect(formatCompactCurrency(0)).toBe('$0.00');
  });

  it('returns $0.00 for negative values', () => {
    expect(formatCompactCurrency(-50)).toBe('$0.00');
  });

  it('keeps two fraction digits below 100', () => {
    expect(formatCompactCurrency(12.34)).toBe('$12.34');
  });

  it('drops fraction digits at exactly 100', () => {
    expect(formatCompactCurrency(100)).toBe('$100');
  });

  it('drops fraction digits above 100', () => {
    expect(formatCompactCurrency(1234.56)).toBe('$1,235');
  });

  it('respects an alternate currency code', () => {
    expect(formatCompactCurrency(50, 'EUR')).toBe(
      new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'EUR',
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
      }).format(50),
    );
  });

  it('returns the zero-USD form when negative even with a different currency', () => {
    expect(formatCompactCurrency(-5, 'EUR')).toBe(intlCurrency(0, 'EUR'));
  });
});
