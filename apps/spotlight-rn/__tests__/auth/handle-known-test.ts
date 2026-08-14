import type { Session } from '@supabase/supabase-js';

/*
  The claim gate blocks the whole app on `handle == null`, so that null must be
  AUTHORITATIVE. Two paths fabricate `handle: null` for users who own one: the
  profile-fetch timeout fallback, and the tiered select that drops the handle
  column on an unmigrated environment. `handleKnown` is the signal that the
  handle column was actually read — these pin that it is false on every
  uncertain path.
*/
describe('auth-service handleKnown', () => {
  type TierResult = { data: Record<string, unknown> | null; error: { code?: string; message?: string } | null };

  function makeSupabaseMock(resultForSelect: (select: string) => TierResult) {
    return {
      auth: {
        getSession: jest.fn().mockResolvedValue({ data: { session: null }, error: null }),
        updateUser: jest.fn(async () => ({ data: {}, error: null })),
      },
      from: jest.fn(() => ({
        select: jest.fn((select: string) => ({
          eq: jest.fn(() => ({
            single: jest.fn(async () => resultForSelect(select)),
            maybeSingle: jest.fn(async () => ({ data: null, error: null })),
          })),
        })),
      })),
      rpc: jest.fn(),
    };
  }

  async function loadService(resultForSelect: (select: string) => TierResult) {
    jest.resetModules();

    const supabase = makeSupabaseMock(resultForSelect);

    jest.doMock('@/lib/supabase', () => ({
      supabase,
      supabaseAuthConfig: {
        configurationIssue: null,
        isConfigured: true,
        redirectURL: 'spotlight://login-callback',
      },
    }));
    jest.doMock('expo-linking', () => ({ openURL: jest.fn() }));
    jest.doMock('expo-web-browser', () => ({ openAuthSessionAsync: jest.fn() }));
    jest.doMock('expo-apple-authentication', () => ({
      AppleAuthenticationScope: { EMAIL: 'EMAIL', FULL_NAME: 'FULL_NAME' },
      isAvailableAsync: jest.fn().mockResolvedValue(false),
      signInAsync: jest.fn(),
    }));

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const service = require('@/features/auth/auth-service') as typeof import('@/features/auth/auth-service');

    return { service, supabase };
  }

  const profileRow = {
    user_id: 'user-1',
    display_name: 'Collector',
    avatar_url: null,
  };

  it('is true when a handle-bearing select tier succeeds — even with handle null', async () => {
    const { service } = await loadService(() => ({
      data: { ...profileRow, handle: null },
      error: null,
    }));

    const profile = await service.fetchProfile('user-1');

    expect(profile?.handleKnown).toBe(true);
    expect(profile?.handle).toBeNull();
  });

  it('is false when the tiers degrade to the base select (handle column dropped)', async () => {
    const { service } = await loadService((select) => {
      // Full and social tiers both include `handle`; the base tier does not.
      if (select.includes('handle')) {
        return { data: null, error: { code: '42703', message: 'column does not exist' } };
      }
      return { data: profileRow, error: null };
    });

    const profile = await service.fetchProfile('user-1');

    expect(profile).not.toBeNull();
    expect(profile?.handleKnown).toBe(false);
  });

  it('is false on the resolved user when the profile fetch fails entirely', async () => {
    const { service } = await loadService(() => ({
      data: null,
      error: { message: 'permission denied' },
    }));

    const session = {
      access_token: 'access-token',
      user: {
        id: 'user-1',
        email: 'collector@example.com',
        identities: [],
        user_metadata: { name: 'Collector' },
      },
    } as unknown as Session;

    const appUser = await service.resolveAppUserFromSession(session);

    expect(appUser.handleKnown).toBe(false);
    expect(appUser.handle).toBeNull();
  });
});
