import {
  PRICE_UNAVAILABLE_CAPTION,
  withheldPriceNote,
} from '@/features/portfolio/components/portfolio-formatting';

describe('withheldPriceNote', () => {
  it('is null when every holding is counted', () => {
    expect(withheldPriceNote([{ quantity: 2, priceStatus: null }, { quantity: 1 }])).toBeNull();
  });

  it('counts copies of stale and untrusted holdings', () => {
    expect(withheldPriceNote([
      { quantity: 1, priceStatus: 'stale' },
      { quantity: 2, priceStatus: 'untrusted' },
      { quantity: 5, priceStatus: null },
    ])).toBe('3 cards not counted — no recent price');
    expect(withheldPriceNote([{ quantity: 1, priceStatus: 'stale' }])).toBe(
      '1 card not counted — no recent price',
    );
  });

  it('has a short row caption', () => {
    expect(PRICE_UNAVAILABLE_CAPTION).toBe('Price unavailable');
  });
});
