import {
  HttpSpotlightRepository,
  MockSpotlightRepository,
} from '../../../../packages/api-client/src/spotlight/repository';

function jsonResponse(status: number, body?: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  } as Response;
}

describe('HttpSpotlightRepository AI settings', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('reads the snake_case payload from /api/v1/me/ai-settings', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, { allow_mcp_edits: true }));
    global.fetch = fetchMock as typeof fetch;
    const repository = new HttpSpotlightRepository('http://example.test');

    await expect(repository.getAiSettings()).resolves.toEqual({ allowMcpEdits: true });
    expect(fetchMock.mock.calls[0][0]).toBe('http://example.test/api/v1/me/ai-settings');
  });

  it('returns null (not "off") when the read fails or is malformed', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(500, { error: 'boom' })) as typeof fetch;
    const repository = new HttpSpotlightRepository('http://example.test');
    await expect(repository.getAiSettings()).resolves.toBeNull();

    global.fetch = jest.fn().mockResolvedValue(jsonResponse(200, {})) as typeof fetch;
    await expect(repository.getAiSettings()).resolves.toBeNull();
  });

  it('posts the toggle and reports ok/failed without throwing', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, { allow_mcp_edits: true }));
    global.fetch = fetchMock as typeof fetch;
    const repository = new HttpSpotlightRepository('http://example.test');

    await expect(repository.setAiSettings({ allowMcpEdits: true })).resolves.toEqual({
      settings: { allowMcpEdits: true },
      status: 'ok',
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://example.test/api/v1/me/ai-settings');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ allow_mcp_edits: true });

    global.fetch = jest.fn().mockResolvedValue(jsonResponse(400, { error: 'bad' })) as typeof fetch;
    await expect(repository.setAiSettings({ allowMcpEdits: false })).resolves.toEqual({
      settings: null,
      status: 'failed',
    });
  });
});

describe('MockSpotlightRepository AI settings', () => {
  it('defaults off and round-trips', async () => {
    const repository = new MockSpotlightRepository();
    await expect(repository.getAiSettings()).resolves.toEqual({ allowMcpEdits: false });
    await repository.setAiSettings({ allowMcpEdits: true });
    await expect(repository.getAiSettings()).resolves.toEqual({ allowMcpEdits: true });
  });
});
