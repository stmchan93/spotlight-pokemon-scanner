import { HttpSpotlightRepository } from '../../../../packages/api-client/src/spotlight/repository';

function jsonResponse(status: number, body?: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  } as Response;
}

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

function deckEntry(id: string, pricing: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    id,
    itemKind: 'raw',
    card: { id: `sv1-${id}`, name: `Card ${id}`, setName: 'Scarlet & Violet', number: '1/198', pricing },
    condition: 'near_mint',
    quantity: 2,
    addedAt: '2026-11-01T00:00:00Z',
    ...extra,
  };
}

describe('HttpSpotlightRepository.getProfilesTopHoldings', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('reads every collector in one request and keeps only USD, served prices', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse(200, {
        currency: 'USD',
        limit: 6,
        profiles: [
          {
            userId: A,
            available: true,
            entries: [
              deckEntry('usd', { currencyCode: 'USD', market: 120 }),
              deckEntry('yen', { currencyCode: 'JPY', market: 9000 }),
              deckEntry('stale', { currencyCode: 'USD', market: 80, priceStatus: 'stale' }),
            ],
          },
          { userId: B, available: false, entries: [] },
        ],
      }),
    ) as typeof fetch;
    const repository = new HttpSpotlightRepository('https://api.test');

    const result = await repository.getProfilesTopHoldings([A, B, A], { limit: 6 });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const url = new URL(String((global.fetch as jest.Mock).mock.calls[0][0]));
    expect(url.pathname).toBe('/api/v1/profiles/top-holdings');
    expect(url.searchParams.get('userIds')).toBe(`${A},${B}`);
    expect(url.searchParams.get('limit')).toBe('6');
    expect(result.map((profile) => profile.userId)).toEqual([A, B]);
    expect(result[0].entries.map((entry) => entry.id)).toEqual(['usd']);
    expect(result[0].entries[0]).toEqual(expect.objectContaining({ marketPrice: 120, quantity: 2 }));
    expect(result[1]).toEqual({ userId: B, entries: [], available: false });
  });

  it('makes no request for an empty list', async () => {
    global.fetch = jest.fn() as typeof fetch;
    const repository = new HttpSpotlightRepository('https://api.test');

    await expect(repository.getProfilesTopHoldings([])).resolves.toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
