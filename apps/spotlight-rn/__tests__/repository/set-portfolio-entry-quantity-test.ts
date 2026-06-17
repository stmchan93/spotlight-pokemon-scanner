import { HttpSpotlightRepository } from '../../../../packages/api-client/src/spotlight/repository';

function jsonResponse(status: number, body?: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => {
      if (body === undefined) {
        return '';
      }
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  } as Response;
}

function findQuantityCall(): [string, RequestInit | undefined] {
  const calls = (global.fetch as jest.Mock).mock.calls as Array<[string, RequestInit | undefined]>;
  const match = calls.find(([url]) => String(url).includes('deck/entries/quantity'));
  if (!match) {
    throw new Error('set-quantity request was never issued');
  }
  return match;
}

describe('HttpSpotlightRepository.setPortfolioEntryQuantity', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function mockOkFetch() {
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse(200, {
        deckEntryID: 'entry-1',
        cardID: 'card-1',
        quantity: 3,
        deleted: false,
      }),
    ) as typeof fetch;
  }

  it('POSTs the deckEntryID and quantity to the quantity endpoint', async () => {
    mockOkFetch();
    const repository = new HttpSpotlightRepository('http://example.test');

    const result = await repository.setPortfolioEntryQuantity({
      deckEntryID: 'entry-1',
      quantity: 3,
    });

    const [url, init] = findQuantityCall();
    expect(String(url)).toBe('http://example.test/api/v1/deck/entries/quantity');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ deckEntryID: 'entry-1', quantity: 3 });
    expect(result).toEqual({
      deckEntryID: 'entry-1',
      cardID: 'card-1',
      quantity: 3,
      deleted: false,
    });
  });

  it('forwards quantity 0 to delete the entry', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse(200, {
        deckEntryID: 'entry-9',
        cardID: 'card-9',
        quantity: 0,
        deleted: true,
      }),
    ) as typeof fetch;
    const repository = new HttpSpotlightRepository('http://example.test');

    const result = await repository.setPortfolioEntryQuantity({
      deckEntryID: 'entry-9',
      quantity: 0,
    });

    const [, init] = findQuantityCall();
    expect(JSON.parse(String(init?.body))).toEqual({ deckEntryID: 'entry-9', quantity: 0 });
    expect(result.deleted).toBe(true);
  });
});
