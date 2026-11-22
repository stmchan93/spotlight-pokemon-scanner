import { HttpSpotlightRepository } from '../../../../packages/api-client/src/spotlight/repository';

/**
 * The backend withholds a stale (no observation in 14 days) or untrusted (raw
 * above the card's own PSA 10) price: `market` is null and `priceStatus` says
 * why. The holding must read as unpriced (out of every client total) and carry
 * the status so rows can say "Price unavailable".
 */

function jsonResponse(status: number, body?: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  } as Response;
}

function card(id: string, pricing: Record<string, unknown>) {
  return {
    id,
    name: 'Teammates',
    setName: 'Gaia Volcano',
    number: '077/070',
    imageSmallURL: 'https://img.example/small.png',
    imageLargeURL: 'https://img.example/large.png',
    pricing: { currencyCode: 'USD', variant: 'Holofoil', ...pricing },
  };
}

describe('withheld price wire mapping', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('maps a withheld holding as unpriced with its status', async () => {
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/v1/deck/entries')) {
        return jsonResponse(200, {
          entries: [
            {
              id: 'entry-stale',
              itemKind: 'raw',
              quantity: 1,
              condition: 'near_mint',
              addedAt: '2026-09-28T18:00:00Z',
              card: card('xy5g_ja-77', { market: null, priceStatus: 'stale', priceAsOf: '2026-07-19' }),
            },
            {
              id: 'entry-fresh',
              itemKind: 'raw',
              quantity: 2,
              condition: 'near_mint',
              addedAt: '2026-09-28T18:00:00Z',
              card: card('sv1-1', { market: 50 }),
            },
          ],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    const [stale, fresh] = await repository.getInventoryEntries();

    expect(stale.hasMarketPrice).toBe(false);
    expect(stale.priceStatus).toBe('stale');
    expect(fresh.hasMarketPrice).toBe(true);
    expect(fresh.marketPrice).toBe(50);
    expect(fresh.priceStatus).toBeNull();
  });
});
