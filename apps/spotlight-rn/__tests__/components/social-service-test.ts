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
};

const TABLE_TO_KEY: Record<string, keyof Results> = {
  posts: 'posts',
  public_profiles: 'authors',
  post_media: 'media',
  follows: 'follows',
  blocks: 'blocks',
  reports: 'reports',
  comments: 'comments',
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

  it('reports the most specific target: message beats comment beats post beats profile', async () => {
    const supabase = makeSupabase({ reports: { data: null, error: null } });
    const { reportContent } = loadService(supabase);

    await expect(
      reportContent({ reportedUserId: 'them', postId: 'p1', commentId: 'c1', messageId: 'm1', reason: 'abuse' }),
    ).resolves.toBe(true);
    expect(supabase.builders.reports.upsert).toHaveBeenLastCalledWith(
      { reporter_id: 'me', target_type: 'message', target_id: 'm1', reason: 'abuse' },
      { onConflict: 'reporter_id,target_type,target_id', ignoreDuplicates: true },
    );

    await reportContent({ reportedUserId: 'them', postId: 'p1', commentId: 'c1', reason: 'abuse' });
    expect(supabase.builders.reports.upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({ target_type: 'comment', target_id: 'c1' }),
      expect.anything(),
    );

    await reportContent({ reportedUserId: 'them', postId: 'p1', reason: 'abuse' });
    expect(supabase.builders.reports.upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({ target_type: 'post', target_id: 'p1' }),
      expect.anything(),
    );

    await reportContent({ reportedUserId: 'them', reason: 'abuse' });
    expect(supabase.builders.reports.upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({ target_type: 'profile', target_id: 'them' }),
      expect.anything(),
    );
  });

  it('sends a blank reason as null rather than an empty string', async () => {
    const supabase = makeSupabase({ reports: { data: null, error: null } });
    const { reportContent } = loadService(supabase);

    await expect(reportContent({ reportedUserId: 'them', reason: '   ' })).resolves.toBe(true);
    expect(supabase.builders.reports.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ reason: null }),
      expect.anything(),
    );
  });

  it('does not write a report with no target at all', async () => {
    const supabase = makeSupabase({});
    const { reportContent } = loadService(supabase);

    await expect(reportContent({ reportedUserId: '  ', reason: 'abuse' })).resolves.toBe(false);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('returns safe empty values when Supabase is unavailable, never throwing', async () => {
    const { blockUser, unblockUser, fetchBlockedUserIds, reportContent } = loadService(null);

    await expect(blockUser('them')).resolves.toBe(false);
    await expect(unblockUser('them')).resolves.toBe(false);
    await expect(fetchBlockedUserIds()).resolves.toEqual(new Set());
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

  it('hides a deleted comment with no replies entirely', async () => {
    const supabase = makeSupabase({
      comments: {
        data: [commentRow({ id: 'alive' }), deletedRow({ id: 'gone', body: 'the deleted text' })],
        error: null,
      },
      authors: { data: [], error: null },
    });
    const { fetchComments } = loadService(supabase);

    const comments = await fetchComments('post-1');

    expect(comments.map((comment) => comment.id)).toEqual(['alive']);
    // An author can always read their OWN tombstone (that RLS branch is what
    // makes the soft-delete write's RETURNING work), so the client prune — not
    // the policy — is what keeps a childless tombstone out of their own thread.
    expect(JSON.stringify(comments)).not.toContain('the deleted text');
  });

  it('drops a tombstone whose only reply was itself a childless tombstone', async () => {
    // One pass is not enough: removing the childless reply leaves the parent
    // childless too, so the prune has to run to a fixed point.
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

    expect(comments.map((comment) => comment.id)).toEqual(['alive']);
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
