import { HttpSpotlightRepository } from '../../../../packages/api-client/src/spotlight/repository';

/**
 * `game` has to survive the trip from the backend onto every card-shaped record
 * the app holds. It is the input to every capability decision (which grading
 * lanes exist, whether a comps drawer has anything to show, which keyword a
 * marketplace link opens with), so a mapper that silently drops it doesn't
 * throw — it just answers "Pokémon" for a One Piece card, and the PDP goes back
 * to offering PSA chips that lead to a permanently empty chart.
 *
 * These tests cover the four entry points a card can arrive through: a scan, a
 * catalog search, the collection, and a direct card-detail load (the only one a
 * deep link can reach).
 */

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

describe('game carried off the wire', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('carries game onto collection entries', async () => {
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/v1/deck/entries')) {
        return jsonResponse(200, {
          entries: [
            {
              id: 'entry-1',
              itemKind: 'raw',
              quantity: 1,
              condition: 'near_mint',
              addedAt: '2026-08-13T18:00:00Z',
              card: {
                id: 'op16-001',
                game: 'onepiece',
                name: 'Monkey D. Luffy',
                setName: 'OP16',
                number: 'OP16-001',
                pricing: { currencyCode: 'usd', market: 12 },
              },
            },
          ],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    const entries = await repository.getInventoryEntries();

    expect(entries[0].game).toBe('onepiece');
  });

  it('carries game onto catalog search results', async () => {
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/v1/cards/search')) {
        return jsonResponse(200, {
          results: [
            {
              id: 'op16-001',
              game: 'onepiece',
              name: 'Monkey D. Luffy',
              setName: 'OP16',
              number: 'OP16-001',
              pricing: { currencyCode: 'USD', market: 12 },
            },
            {
              id: 'sv1-201',
              game: 'pokemon',
              name: 'Skwovet',
              setName: 'Scarlet & Violet',
              number: '201/198',
              pricing: { currencyCode: 'USD', market: 4.2 },
            },
          ],
        });
      }
      if (url.includes('/api/v1/deck/entries')) {
        return jsonResponse(200, { entries: [] });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    const result = await repository.loadCatalogCards('luffy', 20, 0);

    // Search is game-agnostic on the backend, so one result list can legitimately
    // span games — each row must carry its own.
    expect(result.data?.map((row) => row.game)).toEqual(['onepiece', 'pokemon']);
  });

  it('carries game onto scan candidates', async () => {
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/v1/scan/visual-match')) {
        return jsonResponse(200, {
          scanID: 'scan-game',
          topCandidates: [
            {
              rank: 1,
              candidate: {
                id: 'op16-001',
                game: 'onepiece',
                name: 'Monkey D. Luffy',
                setName: 'OP16',
                number: 'OP16-001',
                pricing: { currencyCode: 'usd', market: 12 },
              },
            },
          ],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    const result = await repository.matchScannerCapture({
      jpegBase64: 'bW9jay1zY2Fu',
      height: 1620,
      mode: 'raw',
      width: 1080,
      game: 'onepiece',
    });

    expect(result.candidates[0].game).toBe('onepiece');
  });

  it('carries game onto the card detail, which is all a deep link has', async () => {
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/v1/cards/op16-001/market-history')) {
        return jsonResponse(200, {
          currencyCode: 'USD',
          currentPrice: 12,
          points: [],
          availableVariants: [],
          availableConditions: [],
        });
      }
      if (url.includes('/api/v1/cards/op16-001')) {
        return jsonResponse(200, {
          card: {
            id: 'op16-001',
            game: 'onepiece',
            name: 'Monkey D. Luffy',
            setName: 'OP16',
            number: 'OP16-001',
            pricing: { currencyCode: 'usd', market: 12 },
          },
        });
      }
      if (url.includes('/api/v1/deck/entries')) {
        return jsonResponse(200, { entries: [] });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    const detail = await repository.getCardDetail({ cardId: 'op16-001' });

    expect(detail?.game).toBe('onepiece');
    // And the marketplace link it ships opens on the right game's word — the
    // hardcoded "pokemon" here searched TCGplayer for "pokemon OP16-001".
    expect(detail?.marketplaceUrl).toContain('one+piece');
    expect(detail?.marketplaceUrl).not.toContain('pokemon');
  });

  it('reads an absent game as Pokémon rather than as unknown', async () => {
    // A backend predating multi-game serves no `game` at all. Treating that as
    // unknown would strip PSA pricing from every card in an existing collection.
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/v1/deck/entries')) {
        return jsonResponse(200, {
          entries: [
            {
              id: 'entry-1',
              itemKind: 'raw',
              quantity: 1,
              condition: 'near_mint',
              addedAt: '2026-04-29T18:00:00Z',
              card: {
                id: 'base1-4',
                name: 'Charizard',
                setName: 'Base',
                number: '4/102',
                pricing: { currencyCode: 'usd', market: 300 },
              },
            },
          ],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    const entries = await repository.getInventoryEntries();

    // Undefined, not 'pokemon': the capability helpers own that default, so the
    // mapper stays honest about what the server actually said.
    expect(entries[0].game).toBeUndefined();
  });

  it('drops a game this build has never heard of instead of trusting it', async () => {
    // A newer backend can serve a game this app predates. Passing it through
    // would hand an unknown key to the capability table; dropping it degrades
    // the card to the default lane, which is the safe read.
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/v1/deck/entries')) {
        return jsonResponse(200, {
          entries: [
            {
              id: 'entry-1',
              itemKind: 'raw',
              quantity: 1,
              condition: 'near_mint',
              addedAt: '2026-04-29T18:00:00Z',
              card: {
                id: 'mtg-1',
                game: 'magic',
                name: 'Black Lotus',
                setName: 'Alpha',
                number: '232',
                pricing: { currencyCode: 'usd', market: 100000 },
              },
            },
          ],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const repository = new HttpSpotlightRepository('http://example.test');
    const entries = await repository.getInventoryEntries();

    expect(entries).toHaveLength(1);
    expect(entries[0].game).toBeUndefined();
  });
});
