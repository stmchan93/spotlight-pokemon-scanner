type QueryResult = { data: unknown; error: unknown };

/**
 * A chainable, thenable PostgREST-builder stand-in: every filter method returns
 * the same builder, and awaiting the builder at any point resolves the preset
 * result. That lets one mock serve reads that terminate on `.eq()`, `.in()`,
 * `.order()`, or `.limit()` alike.
 */
function makeBuilder(result: QueryResult) {
  const builder: Record<string, unknown> = {};
  for (const method of [
    'select',
    'is',
    'neq',
    'in',
    'eq',
    'lt',
    'order',
    'limit',
    'upsert',
    'insert',
    'update',
    'delete',
  ]) {
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
  blocks?: QueryResult | QueryResult[];
  reports?: QueryResult | QueryResult[];
  comments?: QueryResult | QueryResult[];
  reposts?: QueryResult | QueryResult[];
};

const TABLE_TO_KEY: Record<string, keyof Results> = {
  posts: 'posts',
  public_profiles: 'authors',
  post_media: 'media',
  follows: 'follows',
  blocks: 'blocks',
  reports: 'reports',
  comments: 'comments',
  post_reposts: 'reposts',
};

// Every environment that has NOT run social_19 answers `blocked_profiles()` with
// PostgREST's "function not in the schema cache". That is the default here so a
// test has to opt IN to the RPC lane, which is the rarer of the two today.
const MISSING_RPC: QueryResult = {
  data: null,
  error: { code: 'PGRST202', message: 'Could not find the function public.blocked_profiles' },
};

function makeSupabase(
  results: Results,
  userId: string | null = 'me',
  rpcResult: QueryResult = MISSING_RPC,
) {
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
    rpc: jest.fn(async () => rpcResult),
    // The last builder handed out per table, so a test can assert on the exact
    // payload a write sent (upsert conflict target, delete scoping).
    builders,
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
        // Absent from the row fixture below, so this also pins the default: a
        // post read from a database without social_23 must normalize to 0, not
        // to undefined, or the card renders a blank count.
        repostCount: 0,
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

  /*
    THE PROFILE ACTIVITY MERGE (social_23).

    Activity is what a collector WROTE plus what they PASSED ON, and the two come
    from different tables with different timestamps. Everything that can go wrong
    here is an ordering or attribution bug, which is invisible until someone with
    both kinds of row looks at their own profile.
  */
  describe('the profile Activity list', () => {
    const otherPostRow = {
      id: 'post-2',
      author_id: 'author-2',
      body: "Someone else's post",
      card_id: null,
      like_count: 0,
      comment_count: 0,
      repost_count: 1,
      created_at: '2026-01-01T00:00:00.000Z',
      content_status: 'visible',
      deleted_at: null,
    };

    /*
      THE CASE THE WHOLE FUNCTION EXISTS FOR. `post-2` is the OLDER post by a
      year, but it was reposted this morning, so it belongs at the top. Sorting
      on the post's own `created_at` — the obvious thing, and what every other
      feed read does — would bury a fresh repost under a year of your own posts
      and make the feature look broken.
    */
    it('orders by when the act happened, not by when the post was written', async () => {
      const supabase = makeSupabase({
        posts: [
          { data: [{ ...postRow, post_media: [] }], error: null },
          { data: [{ ...otherPostRow, post_media: [] }], error: null },
        ],
        reposts: {
          data: [{ post_id: 'post-2', created_at: '2026-08-10T09:00:00.000Z' }],
          error: null,
        },
        authors: { data: [authorRow], error: null },
      });
      const { fetchAuthorActivity } = loadService(supabase);

      const items = await fetchAuthorActivity('me');

      expect(items.map((item) => item.post.id)).toEqual(['post-2', 'post-1']);
      // `repostedAt` is the ONLY thing marking a row as passed-on rather than
      // written — the card itself carries the original author either way.
      expect(items[0].repostedAt).toBe('2026-08-10T09:00:00.000Z');
      expect(items[1].repostedAt).toBeNull();
    });

    /*
      A repost points at a post by id and hydrates it through the same read every
      other surface uses, so `posts_select` re-answers "may this reader see it?"
      each time. A post since deleted, removed by moderation, or hidden by a
      block simply does not come back — and the repost drops out of the list with
      nothing here having to know which of the three it was.
    */
    it('drops a repost whose post is no longer visible, without dropping the rest', async () => {
      const supabase = makeSupabase({
        posts: [
          { data: [{ ...postRow, post_media: [] }], error: null },
          // The hydrating read returns nothing for the reposted id.
          { data: [], error: null },
        ],
        reposts: {
          data: [{ post_id: 'post-gone', created_at: '2026-08-10T09:00:00.000Z' }],
          error: null,
        },
        authors: { data: [authorRow], error: null },
      });
      const { fetchAuthorActivity } = loadService(supabase);

      const items = await fetchAuthorActivity('me');

      expect(items).toHaveLength(1);
      expect(items[0].post.id).toBe('post-1');
    });

    // Reposting your own post is allowed (the DB only skips the NOTIFICATION for
    // it), and it must not put the post in the list twice.
    it('lists a post you reposted yourself once, as the repost', async () => {
      const supabase = makeSupabase({
        posts: [
          { data: [{ ...postRow, post_media: [] }], error: null },
          { data: [{ ...postRow, post_media: [] }], error: null },
        ],
        reposts: {
          data: [{ post_id: 'post-1', created_at: '2026-08-10T09:00:00.000Z' }],
          error: null,
        },
        authors: { data: [authorRow], error: null },
      });
      const { fetchAuthorActivity } = loadService(supabase);

      const items = await fetchAuthorActivity('me');

      expect(items).toHaveLength(1);
      // The repost is the LATER act, so that is the one that survives.
      expect(items[0].repostedAt).toBe('2026-08-10T09:00:00.000Z');
    });

    // A failed repost read must not take the posts with it: the tab still shows
    // what they wrote rather than collapsing to an empty state that reads as
    // "this collector has posted nothing".
    it('still lists authored posts when the repost read fails', async () => {
      const supabase = makeSupabase({
        posts: { data: [{ ...postRow, post_media: [] }], error: null },
        reposts: { data: null, error: { message: 'relation does not exist' } },
        authors: { data: [authorRow], error: null },
      });
      const { fetchAuthorActivity } = loadService(supabase);

      const items = await fetchAuthorActivity('me');

      expect(items).toHaveLength(1);
      expect(items[0].post.id).toBe('post-1');
      expect(items[0].repostedAt).toBeNull();
    });

    // `knownAuthor` says "every row is by this person", which is true of the
    // authored half and FALSE of the reposted half. Applying it to both would
    // label someone else's post with the profile owner's name.
    it('never applies knownAuthor to a reposted post', async () => {
      const supabase = makeSupabase({
        posts: [
          { data: [{ ...postRow, post_media: [] }], error: null },
          { data: [{ ...otherPostRow, post_media: [] }], error: null },
        ],
        reposts: {
          data: [{ post_id: 'post-2', created_at: '2026-08-10T09:00:00.000Z' }],
          error: null,
        },
        authors: {
          data: [{ ...authorRow, user_id: 'author-2', display_name: 'Misty', handle: 'misty' }],
          error: null,
        },
      });
      const { fetchAuthorActivity } = loadService(supabase);

      const items = await fetchAuthorActivity('me', {
        knownAuthor: { displayName: 'Ash', handle: 'ash', avatarUrl: null, isVerified: true },
      });

      const reposted = items.find((item) => item.post.id === 'post-2');
      expect(reposted?.post.author?.displayName).toBe('Misty');
    });
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

// Blocking and reporting are the ONLY safety mechanism behind DMs (no AI pass on
// private messages), so the "never throws, never lies about failure" contract is
// load-bearing here in a way it is not for a feed read.
describe('social-service blocking and reporting', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('blocks a user with an ignore-duplicates upsert, so blocking twice is idempotent', async () => {
    const supabase = makeSupabase({ blocks: { data: null, error: null } });
    const { blockUser } = loadService(supabase);

    await expect(blockUser('them')).resolves.toBe(true);
    // Blocking again must not surface the primary-key collision as a failure —
    // the user is already protected, which is what they were asking for.
    await expect(blockUser('them')).resolves.toBe(true);

    expect(supabase.builders.blocks.upsert).toHaveBeenCalledWith(
      { blocker_id: 'me', blocked_id: 'them' },
      { onConflict: 'blocker_id,blocked_id', ignoreDuplicates: true },
    );
  });

  it('refuses to block yourself instead of tripping the DB check constraint', async () => {
    const supabase = makeSupabase({});
    const { blockUser } = loadService(supabase);

    await expect(blockUser('me')).resolves.toBe(false);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('reports a failed block rather than swallowing the error', async () => {
    const supabase = makeSupabase({ blocks: { data: null, error: { message: 'rls' } } });
    const { blockUser } = loadService(supabase);

    await expect(blockUser('them')).resolves.toBe(false);
  });

  it('unblocks scoped to both sides of the block row, and is idempotent', async () => {
    const supabase = makeSupabase({ blocks: { data: null, error: null } });
    const { unblockUser } = loadService(supabase);

    await expect(unblockUser('them')).resolves.toBe(true);
    // Unblocking someone who was never blocked deletes zero rows, not an error.
    await expect(unblockUser('them')).resolves.toBe(true);

    expect(supabase.builders.blocks.delete).toHaveBeenCalled();
    expect(supabase.builders.blocks.eq).toHaveBeenCalledWith('blocker_id', 'me');
    expect(supabase.builders.blocks.eq).toHaveBeenCalledWith('blocked_id', 'them');
  });

  it('reads only outgoing blocks, never who blocked you', async () => {
    const supabase = makeSupabase({
      blocks: { data: [{ blocked_id: 'them' }, { blocked_id: 'other' }], error: null },
    });
    const { fetchBlockedUserIds } = loadService(supabase);

    await expect(fetchBlockedUserIds()).resolves.toEqual(new Set(['them', 'other']));
    expect(supabase.builders.blocks.eq).toHaveBeenCalledWith('blocker_id', 'me');
  });

  it('returns an empty block set when the read errors', async () => {
    const supabase = makeSupabase({ blocks: { data: null, error: { message: 'boom' } } });
    const { fetchBlockedUserIds } = loadService(supabase);

    await expect(fetchBlockedUserIds()).resolves.toEqual(new Set());
  });

  // The unblock list. Ids alone are useless on a screen, and after social_19 the
  // blocker cannot read a blocked user through `public_profiles` at all — hence
  // two lanes, and hence the rule that an unresolved block is still LISTED.
  it('prefers the blocked_profiles() RPC, which needs no argument', async () => {
    const supabase = makeSupabase({}, 'me', {
      data: [
        { user_id: 'them', display_name: 'Ash', handle: 'ash', avatar_url: 'https://a/1.png' },
      ],
      error: null,
    });
    const { fetchBlockedProfiles } = loadService(supabase);

    await expect(fetchBlockedProfiles()).resolves.toEqual([
      { userID: 'them', displayName: 'Ash', handle: 'ash', avatarURL: 'https://a/1.png' },
    ]);
    // No argument: the RPC pins the caller to auth.uid() itself, so it can never
    // be aimed at someone else's block list.
    expect(supabase.rpc).toHaveBeenCalledWith('blocked_profiles');
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('falls back to blocks + public_profiles when the RPC is not deployed yet', async () => {
    const supabase = makeSupabase({
      blocks: {
        data: [
          { blocked_id: 'them', created_at: '2026-08-02T00:00:00.000Z' },
          { blocked_id: 'other', created_at: '2026-08-01T00:00:00.000Z' },
        ],
        error: null,
      },
      authors: {
        data: [
          { user_id: 'them', display_name: 'Ash', handle: 'ash', avatar_url: null },
          { user_id: 'other', display_name: 'Misty', handle: null, avatar_url: null },
        ],
        error: null,
      },
    });
    const { fetchBlockedProfiles } = loadService(supabase);

    // Block order wins over whatever order the hydration came back in.
    await expect(fetchBlockedProfiles()).resolves.toEqual([
      { userID: 'them', displayName: 'Ash', handle: 'ash', avatarURL: null },
      { userID: 'other', displayName: 'Misty', handle: null, avatarURL: null },
    ]);
    expect(supabase.builders.blocks.eq).toHaveBeenCalledWith('blocker_id', 'me');
  });

  it('still lists a block whose profile could not be resolved', async () => {
    // The social_19 shape: the RPC is missing AND `public_profiles` now hides the
    // blocked user from the blocker. Dropping the row would make the block
    // permanent, so it comes back nameless instead.
    const supabase = makeSupabase({
      blocks: { data: [{ blocked_id: 'them', created_at: '2026-08-02T00:00:00.000Z' }], error: null },
      authors: { data: [], error: null },
    });
    const { fetchBlockedProfiles } = loadService(supabase);

    await expect(fetchBlockedProfiles()).resolves.toEqual([
      { userID: 'them', displayName: null, handle: null, avatarURL: null },
    ]);
  });

  it('does not fall back when the RPC exists and fails for another reason', async () => {
    const supabase = makeSupabase({}, 'me', { data: null, error: { message: 'rls' } });
    const { fetchBlockedProfiles } = loadService(supabase);

    await expect(fetchBlockedProfiles()).resolves.toEqual([]);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('resolves to an empty list when signed out', async () => {
    const supabase = makeSupabase({}, null);
    const { fetchBlockedProfiles } = loadService(supabase);

    await expect(fetchBlockedProfiles()).resolves.toEqual([]);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('reports the most specific target: message beats comment beats post beats profile', async () => {
    const supabase = makeSupabase({ reports: { data: null, error: null } });
    const { reportContent } = loadService(supabase);

    await expect(
      reportContent({ reportedUserId: 'them', postId: 'p1', commentId: 'c1', messageId: 'm1', reason: 'abuse' }),
    ).resolves.toBe(true);
    // A PLAIN INSERT, and asserted as one. An upsert also requires UPDATE on the
    // table, and social_04 grants non-admins INSERT only — which is why every
    // report failed with "Couldn't send report" until this changed.
    expect(supabase.builders.reports.insert).toHaveBeenLastCalledWith(
      { reporter_id: 'me', target_type: 'message', target_id: 'm1', reason: 'abuse' },
    );
    expect(supabase.builders.reports.upsert).not.toHaveBeenCalled();

    await reportContent({ reportedUserId: 'them', postId: 'p1', commentId: 'c1', reason: 'abuse' });
    expect(supabase.builders.reports.insert).toHaveBeenLastCalledWith(
      expect.objectContaining({ target_type: 'comment', target_id: 'c1' }),
    );

    await reportContent({ reportedUserId: 'them', postId: 'p1', reason: 'abuse' });
    expect(supabase.builders.reports.insert).toHaveBeenLastCalledWith(
      expect.objectContaining({ target_type: 'post', target_id: 'p1' }),
    );

    await reportContent({ reportedUserId: 'them', reason: 'abuse' });
    expect(supabase.builders.reports.insert).toHaveBeenLastCalledWith(
      expect.objectContaining({ target_type: 'profile', target_id: 'them' }),
    );
  });

  it('treats a duplicate report as success, so re-reporting is idempotent', async () => {
    // 23505 = unique_violation on (reporter_id, target_type, target_id). That
    // constraint is what makes the 3-distinct-reporter threshold mean three
    // PEOPLE, so hitting it is the constraint working, not a failure.
    const supabase = makeSupabase({
      reports: { data: null, error: { code: '23505', message: 'duplicate key value' } },
    });
    const { reportContent } = loadService(supabase);

    await expect(reportContent({ reportedUserId: 'them', postId: 'p1', reason: '' })).resolves.toBe(true);
  });

  it('fails loudly on a permission error instead of reporting success', async () => {
    const supabase = makeSupabase({
      reports: { data: null, error: { code: '42501', message: 'new row violates row-level security policy' } },
    });
    const { reportContent } = loadService(supabase);

    await expect(reportContent({ reportedUserId: 'them', postId: 'p1', reason: '' })).resolves.toBe(false);
  });

  it('sends a blank reason as null rather than an empty string', async () => {
    const supabase = makeSupabase({ reports: { data: null, error: null } });
    const { reportContent } = loadService(supabase);

    await expect(reportContent({ reportedUserId: 'them', reason: '   ' })).resolves.toBe(true);
    expect(supabase.builders.reports.insert).toHaveBeenCalledWith(
      expect.objectContaining({ reason: null }),
    );
  });

  it('does not write a report with no target at all', async () => {
    const supabase = makeSupabase({});
    const { reportContent } = loadService(supabase);

    await expect(reportContent({ reportedUserId: '  ', reason: 'abuse' })).resolves.toBe(false);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('returns safe empty values when Supabase is unavailable, never throwing', async () => {
    const { blockUser, unblockUser, fetchBlockedUserIds, fetchBlockedProfiles, reportContent } =
      loadService(null);

    await expect(blockUser('them')).resolves.toBe(false);
    await expect(unblockUser('them')).resolves.toBe(false);
    await expect(fetchBlockedUserIds()).resolves.toEqual(new Set());
    await expect(fetchBlockedProfiles()).resolves.toEqual([]);
    await expect(reportContent({ reportedUserId: 'them', reason: 'abuse' })).resolves.toBe(false);
  });

  it('returns safe empty values when unauthenticated', async () => {
    const supabase = makeSupabase({}, null);
    const { blockUser, unblockUser, fetchBlockedUserIds, reportContent } = loadService(supabase);

    await expect(blockUser('them')).resolves.toBe(false);
    await expect(unblockUser('them')).resolves.toBe(false);
    await expect(fetchBlockedUserIds()).resolves.toEqual(new Set());
    await expect(reportContent({ reportedUserId: 'them', reason: 'abuse' })).resolves.toBe(false);
    expect(supabase.from).not.toHaveBeenCalled();
  });
});

// Deleting is the one write in this file where "no error" does NOT mean "it
// worked": RLS refuses by matching zero rows, not by raising, so a naive write
// reports success while changing nothing and the caller's optimistic row removal
// lies to the user. Every case below is really testing that distinction.
//
// The shape is SOFT delete — an UPDATE that stamps `deleted_at` and
// `content_status = 'deleted'` — so "did the write land" is exactly as invisible
// as it was for a hard delete, and the `.select('id')` is what makes it legible.
describe('social-service deleting your own content', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('soft-deletes a post with an UPDATE, never a DELETE, and asks for the affected rows back', async () => {
    const supabase = makeSupabase({ posts: { data: [{ id: 'post-1' }], error: null } });
    const { deletePost } = loadService(supabase);

    await expect(deletePost('post-1')).resolves.toBe(true);

    // The row survives — hard delete would destroy the evidence behind an open
    // report and cascade away notifications people have already read.
    expect(supabase.builders.posts.delete).not.toHaveBeenCalled();
    expect(supabase.builders.posts.update).toHaveBeenCalledWith(
      expect.objectContaining({
        // `'deleted'`, matching the sentinel this file's reads filter on — NOT
        // the `'removed'` the moderation worker writes.
        content_status: 'deleted',
        deleted_at: expect.any(String),
      }),
    );
    expect(supabase.builders.posts.eq).toHaveBeenCalledWith('id', 'post-1');
    // The `.select()` is what turns a silent 204 into a countable row set.
    expect(supabase.builders.posts.select).toHaveBeenCalledWith('id');
    // Authorization is RLS's job (`posts_delete` allows author OR admin), so the
    // client must NOT narrow by author_id — that would break a moderation delete.
    expect(supabase.builders.posts.eq).toHaveBeenCalledTimes(1);
  });

  it('returns false when RLS silently refuses the soft delete (zero rows, no error)', async () => {
    // The same empty RETURNING also appears if the SELECT policy forgets to let
    // an author read their own tombstone — reporting false is right either way.
    const supabase = makeSupabase({ posts: { data: [], error: null } });
    const { deletePost } = loadService(supabase);

    await expect(deletePost('someone-elses-post')).resolves.toBe(false);
  });

  it('returns false when the write resolves with no representation at all', async () => {
    // Belt-and-braces: a plain 204 (no `.select()` honored) is not proof of a delete.
    const supabase = makeSupabase({ posts: { data: null, error: null } });
    const { deletePost } = loadService(supabase);

    await expect(deletePost('post-1')).resolves.toBe(false);
  });

  it('returns false when the delete query errors', async () => {
    const supabase = makeSupabase({ posts: { data: null, error: { message: 'network down' } } });
    const { deletePost } = loadService(supabase);

    await expect(deletePost('post-1')).resolves.toBe(false);
  });

  it('soft-deletes a comment from the comments table', async () => {
    const supabase = makeSupabase({ comments: { data: [{ id: 'comment-1' }], error: null } });
    const { deleteComment } = loadService(supabase);

    await expect(deleteComment('comment-1')).resolves.toBe(true);

    expect(supabase.from).toHaveBeenCalledWith('comments');
    expect(supabase.builders.comments.delete).not.toHaveBeenCalled();
    expect(supabase.builders.comments.update).toHaveBeenCalledWith(
      expect.objectContaining({ content_status: 'deleted', deleted_at: expect.any(String) }),
    );
    expect(supabase.builders.comments.eq).toHaveBeenCalledWith('id', 'comment-1');
    expect(supabase.builders.comments.select).toHaveBeenCalledWith('id');
  });

  it('returns false when RLS refuses a comment delete', async () => {
    const supabase = makeSupabase({ comments: { data: [], error: null } });
    const { deleteComment } = loadService(supabase);

    await expect(deleteComment('someone-elses-comment')).resolves.toBe(false);
  });

  it('returns false when Supabase is unavailable, never throwing', async () => {
    const { deletePost, deleteComment } = loadService(null);

    await expect(deletePost('post-1')).resolves.toBe(false);
    await expect(deleteComment('comment-1')).resolves.toBe(false);
  });

  it('returns false when unauthenticated, without issuing a query', async () => {
    const supabase = makeSupabase({}, null);
    const { deletePost, deleteComment } = loadService(supabase);

    await expect(deletePost('post-1')).resolves.toBe(false);
    await expect(deleteComment('comment-1')).resolves.toBe(false);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('does not issue a delete for a blank id', async () => {
    const supabase = makeSupabase({});
    const { deletePost, deleteComment } = loadService(supabase);

    await expect(deletePost('   ')).resolves.toBe(false);
    await expect(deleteComment('')).resolves.toBe(false);
    expect(supabase.from).not.toHaveBeenCalled();
  });
});

// Soft delete splits comments into two outcomes, and the split is what these
// tests are for: a deleted comment WITH replies has to survive as a body-less
// tombstone (the sheet promotes a reply whose parent is missing to top level, so
// dropping the parent would orphan the thread), while a deleted comment with NO
// replies has to vanish. Posts have no such concept.
describe('social-service comment tombstones', () => {
  afterEach(() => {
    jest.resetModules();
  });

  const commentRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
    id: 'comment-1',
    post_id: 'post-1',
    author_id: 'author-1',
    parent_comment_id: null,
    body: 'A comment',
    like_count: 0,
    created_at: '2026-05-01T00:00:00.000Z',
    content_status: 'visible',
    deleted_at: null,
    ...overrides,
  });

  const deletedRow = (overrides: Partial<Record<string, unknown>> = {}) =>
    commentRow({
      content_status: 'deleted',
      deleted_at: '2026-05-02T00:00:00.000Z',
      ...overrides,
    });

  it('does not ask Postgres to hide deleted rows — a filtered-out tombstone could never come back', async () => {
    const supabase = makeSupabase({ comments: { data: [commentRow()], error: null } });
    const { fetchComments } = loadService(supabase);

    await fetchComments('post-1');

    expect(supabase.builders.comments.eq).toHaveBeenCalledWith('post_id', 'post-1');
    // The two filters the old hard-delete read carried. Either one hides EVERY
    // tombstone, which orphans the replies underneath it.
    expect(supabase.builders.comments.is).not.toHaveBeenCalledWith('deleted_at', null);
    expect(supabase.builders.comments.neq).not.toHaveBeenCalledWith('content_status', 'deleted');
  });

  it('keeps a deleted comment that still has replies, and never exposes its body', async () => {
    const supabase = makeSupabase({
      comments: {
        data: [
          deletedRow({ id: 'parent', body: 'the deleted text' }),
          commentRow({ id: 'reply', parent_comment_id: 'parent', body: 'still here' }),
        ],
        error: null,
      },
      authors: { data: [], error: null },
    });
    const { fetchComments } = loadService(supabase);

    const comments = await fetchComments('post-1');

    expect(comments.map((comment) => comment.id)).toEqual(['parent', 'reply']);
    const [parent, reply] = comments;
    expect(parent.isDeleted).toBe(true);
    // The row still carries the text over the wire (nothing masks the column
    // server-side); this mapping is the boundary that stops it reaching the UI.
    expect(parent.body).toBeNull();
    expect(reply.isDeleted).toBe(false);
    expect(reply.body).toBe('still here');
  });

  /*
    THE FETCH SIDE OF "EVERY DELETED COMMENT SAYS SO".

    This read used to prune childless tombstones (`pruneChildlessTombstones`), so
    a deleted comment survived the reload only while something still hung off it.
    That is what made the thread say "This comment was deleted" for one row and
    silently drop the next — the reported bug. Now every tombstone the policy
    hands over is mapped, and the row the sheet leaves behind on delete is still
    there on the next load rather than vanishing under the reader.
  */
  it('keeps a deleted comment with no replies, so a delete does not vanish on reload', async () => {
    const supabase = makeSupabase({
      comments: {
        data: [commentRow({ id: 'alive' }), deletedRow({ id: 'gone', body: 'the deleted text' })],
        error: null,
      },
      authors: { data: [], error: null },
    });
    const { fetchComments } = loadService(supabase);

    const comments = await fetchComments('post-1');

    expect(comments.map((comment) => comment.id)).toEqual(['alive', 'gone']);
    expect(comments[1].isDeleted).toBe(true);
    // Still a tombstone, so still bodiless: keeping the row must not start
    // leaking what it used to say.
    expect(comments[1].body).toBeNull();
    expect(JSON.stringify(comments)).not.toContain('the deleted text');
  });

  it('keeps a chain of tombstones with nothing under it, rather than unwinding it', async () => {
    // The old prune ran to a fixed point: dropping the childless reply left the
    // parent childless, and the whole chain unwound. Both rows stay now — one
    // rule, said the same way at every depth.
    const supabase = makeSupabase({
      comments: {
        data: [
          deletedRow({ id: 'parent' }),
          deletedRow({ id: 'reply', parent_comment_id: 'parent' }),
          commentRow({ id: 'alive' }),
        ],
        error: null,
      },
      authors: { data: [], error: null },
    });
    const { fetchComments } = loadService(supabase);

    const comments = await fetchComments('post-1');

    expect(comments.map((comment) => comment.id)).toEqual(['parent', 'reply', 'alive']);
    expect(comments.map((comment) => comment.isDeleted)).toEqual([true, true, false]);
  });

  it('still treats a row as deleted when the moderation worker clobbered the sentinel', async () => {
    // `content_status` is advisory — the async worker writes `'removed'` as
    // service_role and can land on a row the author just deleted. `deleted_at`
    // is the authoritative signal, so this row must still be a tombstone.
    const supabase = makeSupabase({
      comments: {
        data: [
          deletedRow({ id: 'parent', content_status: 'removed', body: 'the deleted text' }),
          commentRow({ id: 'reply', parent_comment_id: 'parent' }),
        ],
        error: null,
      },
      authors: { data: [], error: null },
    });
    const { fetchComments } = loadService(supabase);

    const [parent] = await fetchComments('post-1');

    expect(parent.isDeleted).toBe(true);
    expect(parent.body).toBeNull();
  });

  it('marks ordinary comments as not deleted', async () => {
    const supabase = makeSupabase({
      comments: { data: [commentRow()], error: null },
      authors: { data: [], error: null },
    });
    const { fetchComments } = loadService(supabase);

    const [comment] = await fetchComments('post-1');

    expect(comment.isDeleted).toBe(false);
    expect(comment.body).toBe('A comment');
  });
});
