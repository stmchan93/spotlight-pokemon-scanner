import { HttpSpotlightRepository } from '../../../../packages/api-client/src/spotlight/repository';

/**
 * The set browser's half of the lane.
 *
 * `/expansions` and `/expansions/{id}/cards` are both scoped per game on the
 * backend, and both default to Pokémon when the param is absent. So the wire
 * has two jobs that pull in opposite directions: a One Piece lane must actually
 * SEND its game (or it browses Pokémon's 449 sets and then drills into an empty
 * one, because `set_id` is only unique within a game), while a caller that
 * passes nothing must produce exactly the request the shipped Pokémon app makes.
 */

function jsonResponse(status: number, body?: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  } as Response;
}

describe('expansion requests carry the lane', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function captureUrls(bodies: Record<string, unknown>) {
    const urls: string[] = [];
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      urls.push(url);
      for (const [fragment, body] of Object.entries(bodies)) {
        if (url.includes(fragment)) {
          return jsonResponse(200, body);
        }
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;
    return urls;
  }

  it('sends game=pokemon when no lane is given, exactly as the shipped app does', async () => {
    const urls = captureUrls({ '/api/v1/expansions': { expansions: [] } });

    const repository = new HttpSpotlightRepository('http://example.test');
    await repository.listExpansions();

    expect(urls).toEqual(['http://example.test/api/v1/expansions?game=pokemon']);
  });

  it('sends the lane it was given', async () => {
    const urls = captureUrls({
      '/api/v1/expansions': {
        expansions: [
          { id: 'onepiece-OP01', name: 'Romance Dawn', series: null, code: 'OP01', releaseDate: '2022-12-02', imageUrl: '' },
        ],
      },
    });

    const repository = new HttpSpotlightRepository('http://example.test');
    const expansions = await repository.listExpansions('onepiece');

    expect(urls).toEqual(['http://example.test/api/v1/expansions?game=onepiece']);
    expect(expansions.map((row) => row.id)).toEqual(['onepiece-OP01']);
  });

  it('carries the lane into the set it drills into', async () => {
    const urls = captureUrls({
      '/api/v1/expansions/': { results: [] },
      '/api/v1/deck/entries': { entries: [] },
    });

    const repository = new HttpSpotlightRepository('http://example.test');
    await repository.listCardsInExpansion('onepiece-OP01', '', 60, 'onepiece');

    expect(urls.find((url) => url.includes('/cards?'))).toBe(
      'http://example.test/api/v1/expansions/onepiece-OP01/cards?game=onepiece&limit=60',
    );
  });

  it('defaults the set drill-in to Pokémon', async () => {
    const urls = captureUrls({
      '/api/v1/expansions/': { results: [] },
      '/api/v1/deck/entries': { entries: [] },
    });

    const repository = new HttpSpotlightRepository('http://example.test');
    await repository.listCardsInExpansion('sv1');

    expect(urls.find((url) => url.includes('/cards?'))).toBe(
      'http://example.test/api/v1/expansions/sv1/cards?game=pokemon&limit=50',
    );
  });
});
