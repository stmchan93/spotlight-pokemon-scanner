import {
  clearCardDetailCache,
  getCardDetailCached,
  getCardPriceTrendsCached,
} from '@/features/cards/card-detail-prefetch';

import type { SpotlightRepository } from '@spotlight/api-client';

/*
  The PDP's two critical reads retry ONCE after a transport failure. A briefly
  contended backend (12s client abort) answered the retry in <1s in practice;
  without it the page kept every control disabled (2026-09-09 staging).
*/
describe('card detail read-through retry', () => {
  beforeEach(() => {
    clearCardDetailCache();
  });

  it('retries the detail read once and resolves with the second answer', async () => {
    const detail = { cardId: 'svp-75', name: 'Mimikyu' } as never;
    const getCardDetail = jest
      .fn()
      .mockRejectedValueOnce(new Error('aborted'))
      .mockResolvedValueOnce(detail);
    const repository = { getCardDetail } as unknown as SpotlightRepository;

    await expect(getCardDetailCached(repository, 'svp-75')).resolves.toBe(detail);
    expect(getCardDetail).toHaveBeenCalledTimes(2);
  });

  it('gives up after the second failure and leaves nothing cached', async () => {
    const getCardDetail = jest.fn().mockRejectedValue(new Error('still down'));
    const repository = { getCardDetail } as unknown as SpotlightRepository;

    await expect(getCardDetailCached(repository, 'svp-75')).rejects.toThrow('still down');
    expect(getCardDetail).toHaveBeenCalledTimes(2);

    // A rejected entry is dropped, so the next read fires again (2 more calls).
    await expect(getCardDetailCached(repository, 'svp-75')).rejects.toThrow('still down');
    expect(getCardDetail).toHaveBeenCalledTimes(4);
  });

  it('retries the price-trend read the same way', async () => {
    const trends = { rows: [] } as never;
    const getCardPriceTrends = jest
      .fn()
      .mockRejectedValueOnce(new Error('aborted'))
      .mockResolvedValueOnce(trends);
    const repository = { getCardPriceTrends } as unknown as SpotlightRepository;

    await expect(
      getCardPriceTrendsCached(repository, 'svp-75', { grader: null, mode: 'raw', variant: 'Holofoil' }),
    ).resolves.toBe(trends);
    expect(getCardPriceTrends).toHaveBeenCalledTimes(2);
  });
});
