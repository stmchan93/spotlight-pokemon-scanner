import {
  HttpSpotlightRepository,
  isSpotlightRepositoryRequestError,
} from '../../../../packages/api-client/src/spotlight/repository';

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

const matchesBody = {
  matches: [
    { species: 'Pikachu', pokedexId: 25, confidence: 0.92, reason: 'Energetic.' },
    { species: 'Snorlax', pokedexId: 143, confidence: 0.54, reason: 'Sleepy.' },
    { species: 'Psyduck', pokedexId: 54, confidence: 0.21, reason: 'Chaotic.' },
  ],
};

function lastRequest(): [string, RequestInit | undefined] {
  const calls = (global.fetch as jest.Mock).mock.calls as [string, RequestInit | undefined][];
  return calls[calls.length - 1];
}

describe('HttpSpotlightRepository — whos-that-pokemon', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('POSTs the selfie as JSON+base64 with palette and the auth header', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(200, matchesBody)) as typeof fetch;
    const repository = new HttpSpotlightRepository('http://example.test', {
      getAccessToken: () => 'test-access-token',
    });

    const result = await repository.whosThatPokemon({
      jpegBase64: 'c2VsZmll',
      width: 720,
      height: 1280,
      palette: ['#112233', '#445566'],
    });

    const [url, init] = lastRequest();
    expect(String(url)).toBe('http://example.test/api/v1/whos-that-pokemon');
    expect(init?.method).toBe('POST');

    const headers = new Headers(init?.headers);
    expect(headers.get('Authorization')).toBe('Bearer test-access-token');
    expect(headers.get('Content-Type')).toBe('application/json');

    const body = JSON.parse(String(init?.body)) as Record<string, any>;
    expect(body.image).toEqual({ jpegBase64: 'c2VsZmll', width: 720, height: 1280 });
    expect(body.palette).toEqual(['#112233', '#445566']);

    expect(result.matches).toHaveLength(3);
    expect(result.matches[0]).toEqual({
      species: 'Pikachu',
      pokedexId: 25,
      confidence: 0.92,
      reason: 'Energetic.',
    });
    // No cutout field in the response → null (morph falls back to crossfade).
    expect(result.personCutoutUri).toBeNull();
  });

  it('maps personCutoutPngBase64 into a data URI for the outline morph', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse(200, { ...matchesBody, personCutoutPngBase64: 'Y3V0b3V0' }),
    ) as typeof fetch;
    const repository = new HttpSpotlightRepository('http://example.test', {
      getAccessToken: () => 'test-access-token',
    });

    const result = await repository.whosThatPokemon({
      jpegBase64: 'c2VsZmll',
      width: 720,
      height: 1280,
    });

    expect(result.personCutoutUri).toBe('data:image/png;base64,Y3V0b3V0');
  });

  it('passes through the segmentation geometry the reveal lock-on needs', async () => {
    const speciesOutline = Array.from({ length: 12 }, (_, index) => ({
      x: index / 12,
      y: 1 - index / 12,
    }));
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse(200, {
        ...matchesBody,
        personBounds: { x: 0.2, y: 0.05, width: 0.6, height: 0.9 },
        headBox: { x: 0.34, y: 0.08, width: 0.3, height: 0.24 },
        speciesOutline,
      }),
    ) as typeof fetch;
    const repository = new HttpSpotlightRepository('http://example.test');

    const result = await repository.whosThatPokemon({
      jpegBase64: 'c2VsZmll',
      width: 720,
      height: 1280,
    });

    expect(result.headBox).toEqual({ x: 0.34, y: 0.08, width: 0.3, height: 0.24 });
    expect(result.personBounds).toEqual({ x: 0.2, y: 0.05, width: 0.6, height: 0.9 });
    expect(result.speciesOutline).toEqual(speciesOutline);
  });

  it('nulls out missing, degenerate, or too-short geometry instead of half-trusting it', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse(200, {
        ...matchesBody,
        // Zero-width box and a 4-point "outline" are both unusable.
        headBox: { x: 0.3, y: 0.1, width: 0, height: 0.2 },
        speciesOutline: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
      }),
    ) as typeof fetch;
    const repository = new HttpSpotlightRepository('http://example.test');

    const result = await repository.whosThatPokemon({
      jpegBase64: 'c2VsZmll',
      width: 720,
      height: 1280,
    });

    expect(result.headBox).toBeNull();
    expect(result.personBounds).toBeNull();
    expect(result.speciesOutline).toBeNull();
  });

  it('omits the palette field entirely when no colors were extracted', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(200, matchesBody)) as typeof fetch;
    const repository = new HttpSpotlightRepository('http://example.test');

    await repository.whosThatPokemon({ jpegBase64: 'c2VsZmll', width: 720, height: 1280 });

    const [, init] = lastRequest();
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect('palette' in body).toBe(false);
  });

  it('surfaces a repository error with the status when the backend answers 502 match_unavailable', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse(502, { error: 'match_unavailable' }),
    ) as typeof fetch;
    const repository = new HttpSpotlightRepository('http://example.test');

    const failure = await repository
      .whosThatPokemon({ jpegBase64: 'c2VsZmll', width: 720, height: 1280 })
      .then(() => null)
      .catch((error: unknown) => error);

    expect(isSpotlightRepositoryRequestError(failure)).toBe(true);
    if (isSpotlightRepositoryRequestError(failure)) {
      expect(failure.status).toBe(502);
    }
  });

  it('rejects a 200 whose matches are missing or empty', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(200, { matches: [] })) as typeof fetch;
    const repository = new HttpSpotlightRepository('http://example.test');

    await expect(
      repository.whosThatPokemon({ jpegBase64: 'c2VsZmll', width: 720, height: 1280 }),
    ).rejects.toThrow();
  });

  it('POSTs the share-card payload and returns the composed PNG', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse(200, { pngBase64: 'cG5n' }),
    ) as typeof fetch;
    const repository = new HttpSpotlightRepository('http://example.test', {
      getAccessToken: () => 'test-access-token',
    });

    const result = await repository.whosThatShareCard({
      jpegBase64: 'c2VsZmll',
      species: 'Pikachu',
      pokedexId: 25,
      reason: 'Energetic.',
      confidence: 0.92,
    });

    const [url, init] = lastRequest();
    expect(String(url)).toBe('http://example.test/api/v1/whos-that-pokemon/share-card');

    const headers = new Headers(init?.headers);
    expect(headers.get('Authorization')).toBe('Bearer test-access-token');

    const body = JSON.parse(String(init?.body)) as Record<string, any>;
    expect(body.image).toEqual({ jpegBase64: 'c2VsZmll' });
    expect(body.species).toBe('Pikachu');
    expect(body.pokedexId).toBe(25);
    expect(body.reason).toBe('Energetic.');
    expect(body.confidence).toBe(0.92);

    expect(result.pngBase64).toBe('cG5n');
  });

  it('rejects a share-card response without pngBase64', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(200, {})) as typeof fetch;
    const repository = new HttpSpotlightRepository('http://example.test');

    await expect(
      repository.whosThatShareCard({
        jpegBase64: 'c2VsZmll',
        species: 'Pikachu',
        pokedexId: 25,
        reason: 'Energetic.',
        confidence: 0.92,
      }),
    ).rejects.toThrow();
  });
});
