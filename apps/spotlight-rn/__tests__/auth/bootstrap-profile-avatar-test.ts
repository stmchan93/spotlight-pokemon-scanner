import type { User } from '@supabase/supabase-js';

type SavedProfileRead = {
  data: { user_id: string; avatar_url: string | null } | null;
  error: Error | null;
};

/*
  `bootstrapProfileIfNeeded` runs on EVERY sign-in. On a fresh device it used to
  upsert `avatar_url` unconditionally — null (email user) or the provider photo
  (OAuth) — wiping a custom avatar saved before the reinstall (checklist
  2026-08-12, line 98). These pin the avatar-preserving write rules.
*/
describe('auth-service bootstrapProfileIfNeeded avatar preservation', () => {
  function makeSupabaseMock(savedRead: SavedProfileRead) {
    const upsertRows: Record<string, unknown>[] = [];
    const upsert = jest.fn((row: Record<string, unknown>) => {
      upsertRows.push(row);
      return {
        select: jest.fn(() => ({
          single: jest.fn(async () => ({ data: null, error: null })),
        })),
      };
    });
    const from = jest.fn(() => ({
      select: jest.fn(() => ({
        eq: jest.fn(() => ({
          maybeSingle: jest.fn(async () => savedRead),
          single: jest.fn(async () => ({ data: null, error: new Error('no profile') })),
        })),
      })),
      upsert,
    }));

    return {
      supabase: {
        auth: {
          updateUser: jest.fn(async () => ({ data: {}, error: null })),
        },
        from,
        rpc: jest.fn(),
      },
      upsertRows,
    };
  }

  async function loadService(savedRead: SavedProfileRead) {
    jest.resetModules();

    const { supabase, upsertRows } = makeSupabaseMock(savedRead);

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

    return { service, supabase, upsertRows };
  }

  const googleUser = {
    id: 'user-1',
    email: 'collector@example.com',
    user_metadata: {
      name: 'Trainer',
      picture: 'https://provider.example/photo.jpg',
    },
  } as unknown as User;

  it('never overwrites a saved avatar: the upsert omits avatar_url entirely', async () => {
    const { service, supabase, upsertRows } = await loadService({
      data: { user_id: 'user-1', avatar_url: 'https://cdn.spotlight.test/custom-avatar.jpg' },
      error: null,
    });

    await service.bootstrapProfileIfNeeded(googleUser, null);

    expect(upsertRows).toHaveLength(1);
    expect(upsertRows[0]).not.toHaveProperty('avatar_url');
    expect(upsertRows[0]).toMatchObject({ display_name: 'Trainer', user_id: 'user-1' });
    // The auth-metadata sync must not smuggle the provider photo back in either.
    expect(supabase.auth.updateUser).toHaveBeenCalledWith({
      data: { display_name: 'Trainer' },
    });
  });

  it('omits avatar_url when the saved-avatar read fails — a flaky read is not permission to wipe', async () => {
    const { service, upsertRows } = await loadService({
      data: null,
      error: new Error('network down'),
    });

    await service.bootstrapProfileIfNeeded(googleUser, null);

    expect(upsertRows).toHaveLength(1);
    expect(upsertRows[0]).not.toHaveProperty('avatar_url');
  });

  it('writes the provider photo on a first bootstrap (no saved profile row)', async () => {
    const { service, upsertRows } = await loadService({ data: null, error: null });

    await service.bootstrapProfileIfNeeded(googleUser, null);

    expect(upsertRows).toHaveLength(1);
    expect(upsertRows[0]).toMatchObject({
      avatar_url: 'https://provider.example/photo.jpg',
      display_name: 'Trainer',
      user_id: 'user-1',
    });
  });

  it('writes an explicit preferred avatar even over a saved one — a genuinely new value wins', async () => {
    const { service, upsertRows } = await loadService({
      data: { user_id: 'user-1', avatar_url: 'https://cdn.spotlight.test/custom-avatar.jpg' },
      error: null,
    });

    await service.bootstrapProfileIfNeeded(googleUser, 'Trainer', 'https://cdn.spotlight.test/new-pick.jpg');

    expect(upsertRows).toHaveLength(1);
    expect(upsertRows[0]).toMatchObject({ avatar_url: 'https://cdn.spotlight.test/new-pick.jpg' });
  });
});
