type QueryMock = {
  select: jest.Mock;
  eq: jest.Mock;
  maybeSingle: jest.Mock;
};

type SupabaseMock = {
  from: jest.Mock;
};

function makeQuery(result: { data: unknown; error: unknown }): QueryMock {
  const query: Partial<QueryMock> = {};
  query.select = jest.fn(() => query as QueryMock);
  query.eq = jest.fn(() => query as QueryMock);
  query.maybeSingle = jest.fn(async () => result);
  return query as QueryMock;
}

function loadProfileService(supabase: SupabaseMock | null) {
  jest.resetModules();
  jest.doMock('@/lib/supabase', () => ({
    supabase,
    supabaseAuthConfig: {
      configurationIssue: null,
      isConfigured: true,
      redirectURL: 'spotlight://login-callback',
    },
  }));

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('@/features/profile/profile-service') as typeof import('@/features/profile/profile-service');
}

const fullRow = {
  user_id: 'user-1',
  display_name: 'Ash Ketchum',
  avatar_url: 'https://example.com/a.png',
  handle: 'ash',
  bio: 'Gotta collect them all.',
  location: 'Pallet Town',
  social_link: 'ash.example.com',
  is_verified: true,
  reputation: 42,
  follower_count: 7,
  following_count: 3,
  post_count: 5,
};

describe('profile-service', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('maps a public profile row fetched by handle', async () => {
    const query = makeQuery({ data: fullRow, error: null });
    const supabase = { from: jest.fn(() => query) };
    const { fetchProfileByHandle } = loadProfileService(supabase);

    const profile = await fetchProfileByHandle('Ash');

    // Cross-user reads go through the curated, moderation-filtered view — never
    // `user_profiles`, which carries moderation state and capability flags.
    expect(supabase.from).toHaveBeenCalledWith('public_profiles');
    expect(supabase.from).not.toHaveBeenCalledWith('user_profiles');
    expect(query.eq).toHaveBeenCalledWith('handle', 'Ash');
    expect(profile).toEqual({
      userID: 'user-1',
      displayName: 'Ash Ketchum',
      avatarURL: 'https://example.com/a.png',
      labelerEnabled: false,
      adminEnabled: false,
      handle: 'ash',
      bio: 'Gotta collect them all.',
      location: 'Pallet Town',
      socialLink: 'ash.example.com',
      isVerified: true,
      reputation: 42,
      followerCount: 7,
      followingCount: 3,
      postCount: 5,
    });
  });

  it('strips a leading @ from the requested handle', async () => {
    const query = makeQuery({ data: fullRow, error: null });
    const supabase = { from: jest.fn(() => query) };
    const { fetchProfileByHandle } = loadProfileService(supabase);

    await fetchProfileByHandle('@ash');

    expect(query.eq).toHaveBeenCalledWith('handle', 'ash');
  });

  it('fetches by user id for handle-less profiles', async () => {
    const query = makeQuery({ data: { ...fullRow, handle: null }, error: null });
    const supabase = { from: jest.fn(() => query) };
    const { fetchProfileById } = loadProfileService(supabase);

    const profile = await fetchProfileById('user-1');

    expect(query.eq).toHaveBeenCalledWith('user_id', 'user-1');
    expect(profile?.handle).toBeNull();
  });

  it('returns null when no row matches', async () => {
    const query = makeQuery({ data: null, error: null });
    const supabase = { from: jest.fn(() => query) };
    const { fetchProfileByHandle } = loadProfileService(supabase);

    await expect(fetchProfileByHandle('nobody')).resolves.toBeNull();
  });

  it('selects only the columns the public view exposes', async () => {
    const query = makeQuery({ data: fullRow, error: null });
    const supabase = { from: jest.fn(() => query) };
    const { fetchProfileByHandle } = loadProfileService(supabase);

    await fetchProfileByHandle('ash');

    const selected = String(query.select.mock.calls[0][0]);
    for (const forbidden of [
      'admin_enabled',
      'labeler_enabled',
      'status',
      'is_shadowbanned',
      'updated_at',
    ]) {
      expect(selected).not.toContain(forbidden);
    }
    expect(selected).toContain('follower_count');
  });

  it('returns null when the query errors', async () => {
    const query = makeQuery({ data: null, error: { message: 'relation missing' } });
    const supabase = { from: jest.fn(() => query) };
    const { fetchProfileByHandle } = loadProfileService(supabase);

    await expect(fetchProfileByHandle('ash')).resolves.toBeNull();
  });

  it('returns the ordinary not-found result for a row the view filters out', async () => {
    // Suspended / shadowbanned users are simply absent from `public_profiles`;
    // the viewer must not be able to tell that apart from "no such handle".
    const query = makeQuery({ data: null, error: null });
    const supabase = { from: jest.fn(() => query) };
    const { fetchProfileByHandle } = loadProfileService(supabase);

    await expect(fetchProfileByHandle('suspended')).resolves.toBeNull();
  });

  it('never throws when Supabase is unavailable', async () => {
    const { fetchProfileByHandle, fetchProfileById } = loadProfileService(null);

    await expect(fetchProfileByHandle('ash')).resolves.toBeNull();
    await expect(fetchProfileById('user-1')).resolves.toBeNull();
  });

  it('never throws when the query itself rejects', async () => {
    const supabase = {
      from: jest.fn(() => {
        throw new Error('network down');
      }),
    };
    const { fetchProfileById } = loadProfileService(supabase);

    await expect(fetchProfileById('user-1')).resolves.toBeNull();
  });

  it('returns null for an empty handle or user id without querying', async () => {
    const supabase = { from: jest.fn() };
    const { fetchProfileByHandle, fetchProfileById } = loadProfileService(supabase);

    await expect(fetchProfileByHandle('  ')).resolves.toBeNull();
    await expect(fetchProfileById('')).resolves.toBeNull();
    expect(supabase.from).not.toHaveBeenCalled();
  });
});
