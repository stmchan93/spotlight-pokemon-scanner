import {
  formatEditableSellPrice,
  parseSellPrice,
  sanitizeSellPriceText,
} from '@/lib/price-input';

describe('sanitizeSellPriceText', () => {
  it('strips non-numeric characters', () => {
    expect(sanitizeSellPriceText('$1,2a3')).toBe('123');
  });

  it('keeps a single decimal point and caps the fraction at two digits', () => {
    expect(sanitizeSellPriceText('12.3456')).toBe('12.34');
    expect(sanitizeSellPriceText('1.2.3')).toBe('1.23');
  });

  it('normalizes a leading decimal point', () => {
    expect(sanitizeSellPriceText('.')).toBe('0.');
    expect(sanitizeSellPriceText('.5')).toBe('0.5');
  });
});

describe('parseSellPrice', () => {
  it('parses a valid non-negative number', () => {
    expect(parseSellPrice('10.5')).toBe(10.5);
    expect(parseSellPrice(' 0 ')).toBe(0);
  });

  it('returns null for empty, invalid, or negative input', () => {
    expect(parseSellPrice('')).toBeNull();
    expect(parseSellPrice('abc')).toBeNull();
    expect(parseSellPrice('-5')).toBeNull();
  });
});

describe('formatEditableSellPrice', () => {
  it('drops trailing zeros from the editable representation', () => {
    expect(formatEditableSellPrice(10)).toBe('10');
    expect(formatEditableSellPrice(10.5)).toBe('10.5');
    expect(formatEditableSellPrice(10.55)).toBe('10.55');
  });
});
