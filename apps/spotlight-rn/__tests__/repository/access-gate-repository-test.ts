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

describe('HttpSpotlightRepository access gate', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('normalizes the access status payload', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse(200, {
        accessOpen: false,
        allowed: true,
        isAdmin: true,
        showMode: { active: true, until: '2026-06-18T00:00:00.000Z', remainingSeconds: 3600 },
      }),
    ) as typeof fetch;
    const repository = new HttpSpotlightRepository('http://example.test');

    const status = await repository.getAccessStatus();

    expect(status).toEqual({
      accessOpen: false,
      allowed: true,
      isAdmin: true,
      showMode: { active: true, until: '2026-06-18T00:00:00.000Z', remainingSeconds: 3600 },
      // Absent in the payload → false: an older backend must read as "no claim gate".
      handleClaimRequired: false,
    });
  });

  it('passes the handle-claim flag through when the backend sends it', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse(200, {
        accessOpen: true,
        allowed: true,
        isAdmin: false,
        showMode: { active: false, until: null, remainingSeconds: 0 },
        handleClaimRequired: true,
      }),
    ) as typeof fetch;
    const repository = new HttpSpotlightRepository('http://example.test');

    const status = await repository.getAccessStatus();

    expect(status.handleClaimRequired).toBe(true);
  });

  it('fails open when the access status request errors', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('offline')) as typeof fetch;
    const repository = new HttpSpotlightRepository('http://example.test');

    const status = await repository.getAccessStatus();

    expect(status.allowed).toBe(true);
    expect(status.accessOpen).toBe(true);
    expect(status.isAdmin).toBe(false);
    // The claim gate fails open the OTHER way: no server answer → no gate.
    expect(status.handleClaimRequired).toBe(false);
  });

  it('redeems a valid invite code', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse(200, { redeemed: true, allowed: true }),
    ) as typeof fetch;
    const repository = new HttpSpotlightRepository('http://example.test');

    await expect(repository.redeemInviteCode('ekalight_special_guest')).resolves.toEqual({
      redeemed: true,
      allowed: true,
    });
  });

  it('returns a non-throwing failure on a 400 invalid_code response', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse(400, { error: 'invalid_code' }),
    ) as typeof fetch;
    const repository = new HttpSpotlightRepository('http://example.test');

    await expect(repository.redeemInviteCode('nope')).resolves.toEqual({
      redeemed: false,
      allowed: false,
    });
  });

  it('joins the waitlist', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(200, { ok: true })) as typeof fetch;
    const repository = new HttpSpotlightRepository('http://example.test');

    await expect(repository.joinAccessWaitlist('you@example.com')).resolves.toEqual({ ok: true });
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/v1/access/waitlist');
    expect(JSON.parse(String(init.body))).toEqual({ email: 'you@example.com' });
  });

  it('sets card show mode and forwards the optional hours', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse(200, { active: true, accessOpen: true }),
    ) as typeof fetch;
    const repository = new HttpSpotlightRepository('http://example.test');

    await expect(repository.setCardShowMode(true, 6)).resolves.toEqual({ accessOpen: true });
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/v1/ops/card-show-mode');
    expect(JSON.parse(String(init.body))).toEqual({ active: true, hours: 6 });
  });

  it('throws on a 403 forbidden card-show-mode response', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse(403, { error: 'forbidden' }),
    ) as typeof fetch;
    const repository = new HttpSpotlightRepository('http://example.test');

    await expect(repository.setCardShowMode(true)).rejects.toThrow();
  });
});
