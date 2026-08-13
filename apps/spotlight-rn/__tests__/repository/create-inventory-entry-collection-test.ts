import { HttpSpotlightRepository } from '../../../../packages/api-client/src/spotlight/repository';

/*
  `createInventoryEntry` builds its body field by field, and `collectionID` was
  missing from that list — so every add landed in the owner's default collection
  no matter which one the user was looking at, while both callers and the backend
  had it wired correctly.
*/

function jsonResponse(status: number, body?: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  } as Response;
}

function createBody() {
  const calls = (global.fetch as jest.Mock).mock.calls as Array<[string, RequestInit | undefined]>;
  const match = calls.find(([url]) => String(url).endsWith('/api/v1/deck/entries'));
  if (!match) {
    throw new Error('create request was never issued');
  }
  return JSON.parse(String(match[1]?.body)) as Record<string, unknown>;
}

describe('HttpSpotlightRepository.createInventoryEntry', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse(200, { deckEntryID: 'entry-1', cardID: 'card-1', addedAt: '2026-08-12T00:00:00.000Z' }),
    );
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function repository() {
    return new HttpSpotlightRepository('https://api.test');
  }

  const basePayload = {
    addedAt: '2026-08-12T00:00:00.000Z',
    cardID: 'card-1',
    condition: null,
    slabContext: null,
    sourceScanID: null,
  } as const;

  it('sends the collection the card should join', async () => {
    await repository().createInventoryEntry({ ...basePayload, collectionID: 'collection-7' });

    expect(createBody().collectionID).toBe('collection-7');
  });

  it('sends null when no collection was named, so the backend files it into the default', async () => {
    await repository().createInventoryEntry({ ...basePayload });

    expect(createBody().collectionID).toBeNull();
  });

  it('passes "all" through rather than resolving it here', async () => {
    // The backend owns that fallback — it also verifies ownership, which the
    // client cannot.
    await repository().createInventoryEntry({ ...basePayload, collectionID: 'all' });

    expect(createBody().collectionID).toBe('all');
  });
});
