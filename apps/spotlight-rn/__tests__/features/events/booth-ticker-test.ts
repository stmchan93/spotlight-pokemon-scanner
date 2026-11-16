import { buildBoothTickerItems } from '@/features/events/booth-ticker';

describe('buildBoothTickerItems', () => {
  it('shows only the browsing count', () => {
    expect(buildBoothTickerItems({ browsingNow: 42 })).toEqual([
      { key: 'browsing', text: '👀 42 people browsing', vendorId: null },
    ]);
  });

  it('is empty under 3 browsing or when unknown', () => {
    expect(buildBoothTickerItems({ browsingNow: 2 })).toEqual([]);
    expect(buildBoothTickerItems({ browsingNow: null })).toEqual([]);
  });
});
