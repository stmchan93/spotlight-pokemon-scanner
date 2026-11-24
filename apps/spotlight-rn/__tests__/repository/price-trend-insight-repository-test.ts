import { HttpSpotlightRepository } from '../../../../packages/api-client/src/spotlight/repository';

function jsonResponse(status: number, body?: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  } as Response;
}

describe('getCardPriceTrends insight', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('parses the row insight, drops unknown facts, and tolerates old payloads', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(jsonResponse(200, {
      mode: 'raw',
      provider: 'tcgplayer',
      rows: [
        {
          label: 'Near Mint', key: 'NM', currentPrice: 11.8, currencyCode: 'USD', points: [10, 11.8],
          insight: {
            text: 'Up 18% in 30 days · near its 90-day high',
            facts: [{ kind: 'change_30d', value: 18 }, { kind: 'mystery', value: 1 }, { kind: 'high_90d', value: 11.8 }],
          },
        },
        { label: 'Lightly Played', key: 'LP', currentPrice: 9, currencyCode: 'USD', points: [], insight: null },
        { label: 'Damaged', key: 'DM', currentPrice: 4, currencyCode: 'USD', points: [] },
      ],
    })) as unknown as typeof fetch;
    const repository = new HttpSpotlightRepository('http://example.test');

    const list = await repository.getCardPriceTrends({ cardId: 'c1', mode: 'raw' });

    expect(list?.rows[0]?.insight).toEqual({
      text: 'Up 18% in 30 days · near its 90-day high',
      facts: [{ kind: 'change_30d', value: 18 }, { kind: 'high_90d', value: 11.8 }],
    });
    expect(list?.rows[1]?.insight).toBeNull();
    expect(list?.rows[2]?.insight).toBeNull();
  });
});
