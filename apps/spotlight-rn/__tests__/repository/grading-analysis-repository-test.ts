import {
  HttpSpotlightRepository,
  MockSpotlightRepository,
} from '../../../../packages/api-client/src/spotlight/repository';
import {
  mockCardGradingAnalysis,
  mockCardGradingAnalysisOnlyAt10,
} from '../../../../packages/api-client/src/spotlight/grading-analysis-mock-data';

function jsonResponse(status: number, body?: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  } as Response;
}

function mockFetch(...responses: Response[]) {
  const fetchMock = jest.fn();
  for (const response of responses) {
    fetchMock.mockResolvedValueOnce(response);
  }
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe('HttpSpotlightRepository getCardGradingAnalysis', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('builds the route with the printing and grader', async () => {
    const fetchMock = mockFetch(
      jsonResponse(200, mockCardGradingAnalysis),
      jsonResponse(200, mockCardGradingAnalysis),
    );
    const repository = new HttpSpotlightRepository('http://example.test');

    await repository.getCardGradingAnalysis({ cardId: 'sv2-232', variant: 'Reverse Holofoil', grader: 'PSA' });
    await repository.getCardGradingAnalysis({ cardId: 'base1/4', variant: null, grader: 'PSA' });

    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      'http://example.test/api/v1/cards/sv2-232/grading-analysis?variant=Reverse+Holofoil&grader=PSA',
      'http://example.test/api/v1/cards/base1%2F4/grading-analysis?grader=PSA',
    ]);
  });

  it('round-trips the mock payloads unchanged', async () => {
    mockFetch(jsonResponse(200, mockCardGradingAnalysis), jsonResponse(200, mockCardGradingAnalysisOnlyAt10));
    const repository = new HttpSpotlightRepository('http://example.test');

    await expect(repository.getCardGradingAnalysis({ cardId: 'sv2-232', grader: 'PSA' }))
      .resolves.toEqual(mockCardGradingAnalysis);
    await expect(repository.getCardGradingAnalysis({ cardId: 'sm7-1', grader: 'PSA' }))
      .resolves.toEqual(mockCardGradingAnalysisOnlyAt10);
  });

  it('resolves null on 204 (not enough sales) and 404 (unknown card)', async () => {
    mockFetch(jsonResponse(204), jsonResponse(404, { detail: 'nope' }));
    const repository = new HttpSpotlightRepository('http://example.test');

    await expect(repository.getCardGradingAnalysis({ cardId: 'a', grader: 'PSA' })).resolves.toBeNull();
    await expect(repository.getCardGradingAnalysis({ cardId: 'b', grader: 'PSA' })).resolves.toBeNull();
  });

  it('throws on a server error and on a network failure', async () => {
    mockFetch(jsonResponse(500, { detail: 'boom' }));
    const repository = new HttpSpotlightRepository('http://example.test');
    await expect(repository.getCardGradingAnalysis({ cardId: 'a', grader: 'PSA' })).rejects.toBeTruthy();

    global.fetch = jest.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch;
    await expect(repository.getCardGradingAnalysis({ cardId: 'a', grader: 'PSA' })).rejects.toBeTruthy();
  });

  it('drops malformed outcomes and coerces numbers', async () => {
    mockFetch(jsonResponse(200, {
      ...mockCardGradingAnalysis,
      rawPriceUsd: '42',
      outcomes: [
        { grade: 10, priceUsd: '310', netUsd: 275, gainVsRawUsd: 233, worthIt: true },
        { grade: '9', priceUsd: null, netUsd: 1, gainVsRawUsd: 1 },
        'junk',
        { grade: '8', priceUsd: 58, netUsd: 23, gainVsRawUsd: -19 },
      ],
    }));
    const repository = new HttpSpotlightRepository('http://example.test');

    const analysis = await repository.getCardGradingAnalysis({ cardId: 'sv2-232', grader: 'PSA' });
    expect(analysis?.rawPriceUsd).toBe(42);
    expect(analysis?.outcomes).toEqual([
      { grade: '10', priceUsd: 310, netUsd: 275, gainVsRawUsd: 233, worthIt: true },
      // worthIt missing: falls back to the gain's sign.
      { grade: '8', priceUsd: 58, netUsd: 23, gainVsRawUsd: -19, worthIt: false },
    ]);
  });

  it('treats non-USD, unknown verdicts, and outcome-less payloads as unavailable', async () => {
    mockFetch(
      jsonResponse(200, { ...mockCardGradingAnalysis, currencyCode: 'JPY' }),
      jsonResponse(200, { ...mockCardGradingAnalysis, verdict: 'maybe' }),
      jsonResponse(200, { ...mockCardGradingAnalysis, outcomes: [{ grade: '10' }] }),
      jsonResponse(200, { ...mockCardGradingAnalysis, tier: {} }),
    );
    const repository = new HttpSpotlightRepository('http://example.test');

    for (let index = 0; index < 4; index += 1) {
      await expect(repository.getCardGradingAnalysis({ cardId: 'x', grader: 'PSA' })).resolves.toBeNull();
    }
  });
});

describe('MockSpotlightRepository getCardGradingAnalysis', () => {
  it('serves the worth-it case and the only-at-10 case for sm7-1', async () => {
    const repository = new MockSpotlightRepository();

    const worth = await repository.getCardGradingAnalysis({ cardId: 'sv2-232', variant: 'Holofoil', grader: 'PSA' });
    const onlyAt10 = await repository.getCardGradingAnalysis({ cardId: 'sm7-1', grader: 'PSA' });

    expect(worth?.verdict).toBe('worth_it');
    expect(worth?.variant).toBe('Holofoil');
    expect(onlyAt10?.verdict).toBe('only_at_10');
    expect(onlyAt10?.outcomes[0]?.grade).toBe('10');
  });
});
