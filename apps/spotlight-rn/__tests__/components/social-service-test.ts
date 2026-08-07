type QueryResult = { data: unknown; error: unknown };

/**
 * A chainable, thenable PostgREST-builder stand-in: every filter method returns
 * the same builder, and awaiting the builder at any point resolves the preset
 * result. That lets one mock serve reads that terminate on `.eq()`, `.in()`,
 * `.order()`, or `.limit()` alike.
 */
function makeBuilder(result: QueryResult) {
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'is', 'neq', 'in', 'eq', 'lt', 'order', 'limit']) {
    builder[method] = jest.fn(() => builder);
  }
  builder.then = (resolve: (value: QueryResult) => unknown) => Promise.resolve(result).then(resolve);
  return builder;
}

// A table may be read more than once per call (the post read retries without the
// embedded-media select when the embed fails), so a result can be a queue: each
// read takes the next entry and the last one sticks.
type Results = {
  posts?: QueryResult | QueryResult[];
  authors?: QueryResult | QueryResult[];
  media?: QueryResult | QueryResult[];
  follows?: QueryResult | QueryResult[];
};

const TABLE_TO_KEY: Record<string, keyof Results> = {
  posts: 'posts',
  public_profiles: 'authors',
  post_media: 'media',
  follows: 'follows',
};

function makeSupabase(results: Results, userId: string | null = 'me') {
  const empty: QueryResult = { data: [], error: null };
  const builders: Record<string, ReturnType<typeof makeBuilder>> = {};
  const queues: Partial<Record<keyof Results, QueryResult[]>> = {};
  const from = jest.fn((table: string) => {
    const key = TABLE_TO_KEY[table];
    const configured = key ? results[key] : undefined;
    let result: QueryResult = empty;
    if (Array.isArray(configured)) {
      const queue = (queues[key!] ??= [...configured]);
      result = (queue.length > 1 ? queue.shift() : queue[0]) ?? empty;
    } else if (configured) {
      result = configured;
    }
    builders[table] = makeBuilder(result);
    return builders[table];
  });
  return {
    auth: {
      // The service reads the persisted session first and only falls back to
      // getUser() (a network revalidation) when there is none.
      getSession: jest.fn(async () => ({
        data: { session: userId ? { user: { id: userId } } : null },
      })),
      getUser: jest.fn(async () => ({ data: { user: userId ? { id: userId } : null } })),
    },
    from,
  };
}

function loadService(supabase: unknown) {
  jest.resetModules();
  jest.doMock('@/lib/supabase', () => ({ supabase }));
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('@/features/social/social-service') as typeof import('@/features/social/social-service');
}

const postRow = {
  id: 'post-1',
  author_id: 'author-1',
  body: 'A post',
  card_id: 'card-9',
  like_count: 3,
  comment_count: 1,
  created_at: '2026-05-01T00:00:00.000Z',
  content_status: 'visible',
  deleted_at: null,
};

const authorRow = {
  user_id: 'author-1',
  display_name: 'Ash',
  avatar_url: 'https://example.com/a.png',
  handle: 'ash',
  is_verified: true,
};

const mediaRow = {
  id: 'media-1',
  post_id: 'post-1',
  width: 800,
  height: 600,
  blurhash: 'LKO2',
  position: 0,
};

describe('social-service', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('normalizes a global-feed post from the embedded-media read, without a second media query', async () => {
    const supabase = makeSupabase({
      posts: { data: [{ ...postRow, post_media: [mediaRow] }], error: null },
      authors: { data: [authorRow], error: null },
    });
    const { fetchGlobalFeed } = loadService(supabase);

    const posts = await fetchGlobalFeed();

    expect(supabase.from).toHaveBeenCalledWith('posts');
    expect(supabase.from).not.toHaveBeenCalledWith('post_media');
    expect(posts).toEqual([
      {
        id: 'post-1',
        authorId: 'author-1',
        author: { displayName: 'Ash', handle: 'ash', avatarUrl: 'https://example.com/a.png', isVerified: true },
        body: 'A post',
        cardId: 'card-9',
        likeCount: 3,
        commentCount: 1,
        createdAt: '2026-05-01T00:00:00.000Z',
        media: [{ id: 'media-1', width: 800, height: 600, blurhash: 'LKO2' }],
      },
    ]);
  });

  it('leaves author null when the author is not publicly visible', async () => {
    const supabase = makeSupabase({
      posts: { data: [postRow], error: null },
      authors: { data: [], error: null },
      media: { data: [], error: null },
    });
    const { fetchGlobalFeed } = loadService(supabase);

    const [post] = await fetchGlobalFeed();

    expect(post.author).toBeNull();
    expect(post.media).toEqual([]);
  });

  it('falls back to a separate media read when the embedded post select errors', async () => {
    const supabase = makeSupabase({
      posts: [
        { data: null, error: { message: 'could not find a relationship' } },
        { data: [postRow], error: null },
      ],
      authors: { data: [authorRow], error: null },
      media: { data: [mediaRow], error: null },
    });
    const { fetchGlobalFeed } = loadService(supabase);

    const posts = await fetchGlobalFeed();

    expect(supabase.from).toHaveBeenCalledWith('post_media');
    expect(posts).toHaveLength(1);
    expect(posts[0].media).toEqual([{ id: 'media-1', width: 800, height: 600, blurhash: 'LKO2' }]);
  });

  it('skips the author read when the caller already knows the author', async () => {
    const supabase = makeSupabase({
      posts: { data: [{ ...postRow, post_media: [] }], error: null },
    });
    const { fetchAuthorPosts } = loadService(supabase);

    const knownAuthor = {
      displayName: 'Ash',
      handle: 'ash',
      avatarUrl: 'https://example.com/a.png',
      isVerified: true,
    };
    const posts = await fetchAuthorPosts('author-1', { knownAuthor });

    expect(supabase.from).not.toHaveBeenCalledWith('public_profiles');
    expect(posts[0].author).toEqual(knownAuthor);
  });

  it('returns [] for the following feed when the user follows nobody', async () => {
    const supabase = makeSupabase({
      follows: { data: [], error: null },
      posts: { data: [postRow], error: null },
    });
    const { fetchFollowingFeed } = loadService(supabase);

    await expect(fetchFollowingFeed()).resolves.toEqual([]);
    // Never reads posts when there are no followees.
    expect(supabase.from).not.toHaveBeenCalledWith('posts');
  });

  it('reads followee posts when the user follows someone', async () => {
    const supabase = makeSupabase({
      follows: { data: [{ followee_id: 'author-1' }], error: null },
      posts: { data: [postRow], error: null },
      authors: { data: [authorRow], error: null },
      media: { data: [], error: null },
    });
    const { fetchFollowingFeed } = loadService(supabase);

    const posts = await fetchFollowingFeed();

    expect(supabase.from).toHaveBeenCalledWith('follows');
    expect(supabase.from).toHaveBeenCalledWith('posts');
    expect(posts).toHaveLength(1);
    expect(posts[0].id).toBe('post-1');
  });

  it('does not query for a blank card id or author id', async () => {
    const supabase = makeSupabase({});
    const { fetchCardPosts, fetchAuthorPosts } = loadService(supabase);

    await expect(fetchCardPosts('  ')).resolves.toEqual([]);
    await expect(fetchAuthorPosts('')).resolves.toEqual([]);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('resolves to [] when Supabase is unavailable, never throwing', async () => {
    const { fetchGlobalFeed, fetchFollowingFeed, fetchAuthorPosts, fetchCardPosts } = loadService(null);

    await expect(fetchGlobalFeed()).resolves.toEqual([]);
    await expect(fetchFollowingFeed()).resolves.toEqual([]);
    await expect(fetchAuthorPosts('author-1')).resolves.toEqual([]);
    await expect(fetchCardPosts('card-9')).resolves.toEqual([]);
  });

  it('resolves to [] when the posts read errors', async () => {
    const supabase = makeSupabase({
      posts: { data: null, error: { message: 'boom' } },
    });
    const { fetchGlobalFeed } = loadService(supabase);

    await expect(fetchGlobalFeed()).resolves.toEqual([]);
  });
});
