type QueryResult = { count?: number | null; data?: unknown; error?: unknown };

type RecordedCall = { table: string; method: string; args: unknown[] };

/**
 * A chainable, thenable PostgREST-builder stand-in — same shape as
 * `social-service-test.ts`, plus the write and terminator methods the DM service
 * uses (`insert`, `upsert`, `update`, `single`, `maybeSingle`) and `gt` for the
 * unread window. Every method returns the same builder and records its arguments,
 * so a test can assert on the filters a query actually applied; awaiting the
 * builder at any point resolves the preset result.
 */
const BUILDER_METHODS = [
  'select',
  'insert',
  'upsert',
  'update',
  'delete',
  'is',
  'neq',
  'in',
  'eq',
  'lt',
  'gt',
  'order',
  'limit',
  'single',
  'maybeSingle',
];

function makeBuilder(table: string, result: QueryResult, calls: RecordedCall[]) {
  const builder: Record<string, unknown> = {};
  for (const method of BUILDER_METHODS) {
    builder[method] = jest.fn((...args: unknown[]) => {
      calls.push({ table, method, args });
      return builder;
    });
  }
  builder.then = (resolve: (value: QueryResult) => unknown) => Promise.resolve(result).then(resolve);
  return builder;
}

// A table is read and written more than once per call (conversations is looked up
// by dm_key then upserted; participants are inserted twice), so a result can be a
// queue: each access takes the next entry and the last one sticks.
type Results = {
  conversations?: QueryResult | QueryResult[];
  participants?: QueryResult | QueryResult[];
  messages?: QueryResult | QueryResult[];
  profiles?: QueryResult | QueryResult[];
  /** Response from the `unread_dm_counts` RPC (social_13). */
  unreadRpc?: { data: unknown; error: unknown };
};

const TABLE_TO_KEY: Record<string, keyof Results> = {
  conversations: 'conversations',
  conversation_participants: 'participants',
  messages: 'messages',
  public_profiles: 'profiles',
};

function makeSupabase(results: Results, userId: string | null = 'me') {
  const empty: QueryResult = { count: 0, data: [], error: null };
  const calls: RecordedCall[] = [];
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
    return makeBuilder(table, result, calls);
  });
  // `unread_dm_counts` is an RPC (social_13), not a table read, so it needs its
  // own stub rather than going through the table builder.
  const rpc = jest.fn(async (name: string) => {
    calls.push({ table: `rpc:${name}`, method: 'rpc', args: [] });
    const configured = results.unreadRpc;
    return configured ?? { data: [], error: null };
  });
  return {
    auth: {
      getSession: jest.fn(async () => ({
        data: { session: userId ? { user: { id: userId } } : null },
      })),
      getUser: jest.fn(async () => ({ data: { user: userId ? { id: userId } : null } })),
    },
    calls,
    from,
    rpc,
  };
}

function loadService(supabase: unknown) {
  jest.resetModules();
  jest.doMock('@/lib/supabase', () => ({ supabase }));
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('@/features/social/dm-service') as typeof import('@/features/social/dm-service');
}

function writesTo(calls: RecordedCall[], table: string, method: string) {
  return calls.filter((call) => call.table === table && call.method === method);
}

const conversationRow = {
  id: 'conv-1',
  is_group: false,
  dm_key: 'me:you',
  last_message_at: '2026-05-02T00:00:00.000Z',
  last_message_preview: 'see you at the show',
  created_at: '2026-05-01T00:00:00.000Z',
};

const profileRow = {
  user_id: 'you',
  display_name: 'Misty',
  avatar_url: 'https://example.com/m.png',
  handle: 'misty',
  is_verified: true,
};

const messageRow = {
  id: 'msg-1',
  conversation_id: 'conv-1',
  sender_id: 'you',
  body: 'hey',
  created_at: '2026-05-02T00:00:00.000Z',
  content_status: 'visible',
};

describe('dm-service', () => {
  afterEach(() => {
    jest.resetModules();
  });

  describe('findOrCreateDm', () => {
    it('derives the same sorted dm_key and conversation id regardless of who opens the thread', async () => {
      // Alice opens Zed's profile.
      const alice = makeSupabase(
        { conversations: { data: null, error: null } },
        'aaaaaaaa-1111-4111-8111-111111111111',
      );
      const alicesId = await loadService(alice).findOrCreateDm('zzzzzzzz-9999-4999-8999-999999999999');

      // Zed opens Alice's profile — the arguments are swapped end to end.
      const zed = makeSupabase(
        { conversations: { data: null, error: null } },
        'zzzzzzzz-9999-4999-8999-999999999999',
      );
      const zedsId = await loadService(zed).findOrCreateDm('aaaaaaaa-1111-4111-8111-111111111111');

      const [aliceInsert] = writesTo(alice.calls, 'conversations', 'insert');
      const [zedInsert] = writesTo(zed.calls, 'conversations', 'insert');
      const alicePayload = aliceInsert.args[0] as { dm_key: string };
      const zedPayload = zedInsert.args[0] as { dm_key: string };

      // Sorted, so the key belongs to the pair rather than to whoever tapped first.
      expect(alicePayload.dm_key).toBe(
        'aaaaaaaa-1111-4111-8111-111111111111:zzzzzzzz-9999-4999-8999-999999999999',
      );
      expect(zedPayload.dm_key).toBe(alicePayload.dm_key);
      // ...and therefore both sides land on one thread, not two.
      expect(alicesId).toBe(zedsId);
      expect(alicesId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it('adds both participants, mine first and as a separate statement', async () => {
      const supabase = makeSupabase({ conversations: { data: null, error: null } });
      const { findOrCreateDm } = loadService(supabase);

      const id = await findOrCreateDm('you');

      const participantWrites = writesTo(supabase.calls, 'conversation_participants', 'insert');
      expect(participantWrites).toHaveLength(2);
      expect(participantWrites[0].args[0]).toEqual({ conversation_id: id, user_id: 'me' });
      expect(participantWrites[1].args[0]).toEqual({ conversation_id: id, user_id: 'you' });
    });

    it('never chains a select onto the conversation insert (its RETURNING would fail RLS)', async () => {
      const supabase = makeSupabase({ conversations: { data: null, error: null } });
      const { findOrCreateDm } = loadService(supabase);

      await findOrCreateDm('you');

      // The only conversations select is the dm_key lookup, which happens before
      // the insert. Nothing selects after it.
      const conversationCalls = supabase.calls.filter((call) => call.table === 'conversations');
      const insertIndex = conversationCalls.findIndex((call) => call.method === 'insert');
      expect(insertIndex).toBeGreaterThanOrEqual(0);
      expect(conversationCalls.slice(insertIndex).some((call) => call.method === 'select')).toBe(false);

      // And it must never become an UPSERT again. `.upsert()` compiles to
      // INSERT ... ON CONFLICT, which Postgres only permits when an UPDATE
      // policy exists — `conversations` and `conversation_participants` have
      // none, so every upsert was rejected 42501 and no DM could be created at
      // all. Verified against staging: plain insert 201, upsert 403 under both
      // `ignore-duplicates` and `merge-duplicates`.
      expect(conversationCalls.some((call) => call.method === 'upsert')).toBe(false);
      expect(
        supabase.calls.some(
          (call) => call.table === 'conversation_participants' && call.method === 'upsert',
        ),
      ).toBe(false);
    });

    it('reuses the existing thread instead of creating a second one', async () => {
      const supabase = makeSupabase({ conversations: { data: { id: 'conv-1' }, error: null } });
      const { findOrCreateDm } = loadService(supabase);

      await expect(findOrCreateDm('you')).resolves.toBe('conv-1');
      expect(writesTo(supabase.calls, 'conversations', 'insert')).toHaveLength(0);
    });

    it('refuses a thread with yourself', async () => {
      const supabase = makeSupabase({});
      const { findOrCreateDm } = loadService(supabase);

      await expect(findOrCreateDm('me')).resolves.toBeNull();
      expect(supabase.from).not.toHaveBeenCalled();
    });

    it('falls back to the dm_key lookup when our derived id lost the unique key', async () => {
      const supabase = makeSupabase({
        conversations: [
          { data: null, error: null }, // first lookup: nothing visible yet
          { data: null, error: null }, // insert (duplicate tolerated, someone else won)
          { data: { id: 'conv-winner' }, error: null }, // re-read by dm_key
        ],
        // Our participant insert fails the foreign key against the derived id.
        participants: { data: null, error: { message: 'violates foreign key constraint' } },
      });
      const { findOrCreateDm } = loadService(supabase);

      await expect(findOrCreateDm('you')).resolves.toBe('conv-winner');
    });
  });

  describe('fetchConversations', () => {
    it('reads unread counts from ONE rpc, not a request per thread', async () => {
      const supabase = makeSupabase({
        conversations: { data: [conversationRow], error: null },
        participants: {
          data: [
            { conversation_id: 'conv-1', user_id: 'me', last_read_at: '2026-05-01T12:00:00.000Z' },
            { conversation_id: 'conv-1', user_id: 'you', last_read_at: null },
          ],
          error: null,
        },
        profiles: { data: [profileRow], error: null },
        unreadRpc: { data: [{ conversation_id: 'conv-1', unread_count: 3 }], error: null },
      });
      const { fetchConversations } = loadService(supabase);

      const [conversation] = await fetchConversations();

      expect(conversation.unreadCount).toBe(3);
      // social_13 replaced a per-thread count fan-out (up to `limit` requests to
      // draw one screen) with a single grouped RPC. Own-message exclusion and the
      // read-cursor window now live in SQL, so the guarantee to pin here is that
      // the client makes exactly one call and never touches `messages` for counts.
      expect(supabase.rpc).toHaveBeenCalledTimes(1);
      expect(supabase.rpc).toHaveBeenCalledWith('unread_dm_counts');
      expect(supabase.calls.some((call) => call.table === 'messages')).toBe(false);
    });

    it('treats a conversation missing from the rpc payload as zero unread', async () => {
      const supabase = makeSupabase({
        conversations: { data: [conversationRow], error: null },
        participants: {
          data: [
            { conversation_id: 'conv-1', user_id: 'me', last_read_at: null },
            { conversation_id: 'conv-1', user_id: 'you', last_read_at: null },
          ],
          error: null,
        },
        profiles: { data: [profileRow], error: null },
        // The RPC omits threads with nothing unread rather than returning zeros,
        // so "absent" is the normal case and must not read as undefined.
        unreadRpc: { data: [], error: null },
      });
      const { fetchConversations } = loadService(supabase);

      const [conversation] = await fetchConversations();

      expect(conversation.unreadCount).toBe(0);
      expect(conversation.lastReadAt).toBeNull();
    });

    it('still renders the inbox when the unread rpc fails', async () => {
      const supabase = makeSupabase({
        conversations: { data: [conversationRow], error: null },
        participants: {
          data: [{ conversation_id: 'conv-1', user_id: 'me', last_read_at: null }],
          error: null,
        },
        profiles: { data: [profileRow], error: null },
        unreadRpc: { data: null, error: { message: 'boom' } },
      });
      const { fetchConversations } = loadService(supabase);

      const conversations = await fetchConversations();

      // A missing badge is a far better outcome than an inbox that refuses to
      // render, so an rpc failure degrades to zero rather than throwing.
      expect(conversations).toHaveLength(1);
      expect(conversations[0].unreadCount).toBe(0);
    });

    it('reads the last message preview off the conversation row, not a per-thread message read', async () => {
      const supabase = makeSupabase({
        conversations: { data: [conversationRow], error: null },
        participants: {
          data: [{ conversation_id: 'conv-1', user_id: 'me', last_read_at: null }],
          error: null,
        },
        profiles: { data: [profileRow], error: null },
      });
      const { fetchConversations } = loadService(supabase);

      const [conversation] = await fetchConversations();

      expect(conversation.lastMessagePreview).toBe('see you at the show');
      // The preview is denormalized by `tg_messages_touch_conversation` (social_13)
      // and selected alongside `last_message_at`. It used to cost one
      // `fetchMessages(id, 1)` per row; the guarantee to pin is that drawing the
      // inbox never touches `messages` at all.
      const conversationSelect = supabase.calls.find(
        (call) => call.table === 'conversations' && call.method === 'select',
      );
      expect(conversationSelect?.args[0]).toContain('last_message_preview');
      expect(supabase.calls.some((call) => call.table === 'messages')).toBe(false);
    });

    it('keeps a null preview null (empty thread, or a moderation-removed last message)', async () => {
      const supabase = makeSupabase({
        conversations: {
          // The trigger writes null rather than the body when the newest message
          // was marked `removed`, so null is a normal value, not a read failure.
          data: [{ ...conversationRow, last_message_at: null, last_message_preview: null }],
          error: null,
        },
        participants: {
          data: [{ conversation_id: 'conv-1', user_id: 'me', last_read_at: null }],
          error: null,
        },
        profiles: { data: [profileRow], error: null },
      });
      const { fetchConversations } = loadService(supabase);

      const [conversation] = await fetchConversations();

      expect(conversation.lastMessagePreview).toBeNull();
      // ...and it does NOT fall back to reading the thread to fill the gap.
      expect(supabase.calls.some((call) => call.table === 'messages')).toBe(false);
    });

    it('hydrates the other participant through one batched public_profiles read', async () => {
      const supabase = makeSupabase({
        conversations: {
          data: [conversationRow, { ...conversationRow, id: 'conv-2', dm_key: 'me:them' }],
          error: null,
        },
        participants: {
          data: [
            { conversation_id: 'conv-1', user_id: 'me', last_read_at: null },
            { conversation_id: 'conv-1', user_id: 'you', last_read_at: null },
            { conversation_id: 'conv-2', user_id: 'me', last_read_at: null },
            { conversation_id: 'conv-2', user_id: 'them', last_read_at: null },
          ],
          error: null,
        },
        profiles: { data: [profileRow], error: null },
        messages: { count: 0, data: null, error: null },
      });
      const { fetchConversations } = loadService(supabase);

      const conversations = await fetchConversations();

      const profileCalls = supabase.calls.filter((call) => call.table === 'public_profiles');
      expect(profileCalls.filter((call) => call.method === 'select')).toHaveLength(1);
      expect(profileCalls.find((call) => call.method === 'in')?.args).toEqual(['user_id', ['you', 'them']]);

      expect(conversations[0].otherUserId).toBe('you');
      expect(conversations[0].otherUser).toEqual({
        displayName: 'Misty',
        handle: 'misty',
        avatarUrl: 'https://example.com/m.png',
        isVerified: true,
      });
      // No profile row came back for `them` — the thread still renders.
      expect(conversations[1].otherUser).toBeNull();
    });

    it('sorts by last_message_at descending with empty threads last', async () => {
      const supabase = makeSupabase({
        conversations: { data: [conversationRow], error: null },
        messages: { count: 0, data: null, error: null },
      });
      const { fetchConversations } = loadService(supabase);

      await fetchConversations();

      expect(
        supabase.calls.find((call) => call.table === 'conversations' && call.method === 'order')?.args,
      ).toEqual(['last_message_at', { ascending: false, nullsFirst: false }]);
    });

    it('resolves to [] when the conversation read errors', async () => {
      const supabase = makeSupabase({ conversations: { data: null, error: { message: 'boom' } } });
      const { fetchConversations } = loadService(supabase);

      await expect(fetchConversations()).resolves.toEqual([]);
    });
  });

  describe('fetchMessages', () => {
    it('reads the newest page and returns it oldest-first for rendering', async () => {
      const supabase = makeSupabase({
        messages: {
          data: [
            { ...messageRow, id: 'msg-2', created_at: '2026-05-03T00:00:00.000Z' },
            messageRow,
          ],
          error: null,
        },
      });
      const { fetchMessages } = loadService(supabase);

      const messages = await fetchMessages('conv-1');

      // Read newest-first so `limit` takes the newest window...
      expect(
        supabase.calls.find((call) => call.table === 'messages' && call.method === 'order')?.args,
      ).toEqual(['created_at', { ascending: false }]);
      // ...and handed back oldest-first.
      expect(messages.map((message) => message.id)).toEqual(['msg-1', 'msg-2']);
      expect(messages[0]).toEqual({
        id: 'msg-1',
        conversationId: 'conv-1',
        senderId: 'you',
        body: 'hey',
        createdAt: '2026-05-02T00:00:00.000Z',
      });
    });

    it('drops moderation-removed messages', async () => {
      const supabase = makeSupabase({
        messages: {
          data: [messageRow, { ...messageRow, id: 'msg-bad', content_status: 'removed' }],
          error: null,
        },
      });
      const { fetchMessages } = loadService(supabase);

      const messages = await fetchMessages('conv-1');

      expect(messages.map((message) => message.id)).toEqual(['msg-1']);
    });

    it('does not query for a blank conversation id', async () => {
      const supabase = makeSupabase({});
      const { fetchMessages } = loadService(supabase);

      await expect(fetchMessages('  ')).resolves.toEqual([]);
      expect(supabase.from).not.toHaveBeenCalled();
    });
  });

  describe('sendMessage', () => {
    it('returns the stored row so an optimistic entry can be reconciled', async () => {
      const supabase = makeSupabase({
        messages: { data: { ...messageRow, sender_id: 'me' }, error: null },
      });
      const { sendMessage } = loadService(supabase);

      const message = await sendMessage('conv-1', '  hey  ');

      expect(writesTo(supabase.calls, 'messages', 'insert')[0].args[0]).toEqual({
        conversation_id: 'conv-1',
        sender_id: 'me',
        body: 'hey',
      });
      expect(message).toEqual({
        id: 'msg-1',
        conversationId: 'conv-1',
        senderId: 'me',
        body: 'hey',
        createdAt: '2026-05-02T00:00:00.000Z',
      });
    });

    it('returns null when the moderation prefilter removed the message', async () => {
      const supabase = makeSupabase({
        messages: { data: { ...messageRow, sender_id: 'me', content_status: 'removed' }, error: null },
      });
      const { sendMessage } = loadService(supabase);

      await expect(sendMessage('conv-1', 'hey')).resolves.toBeNull();
    });

    it('does not send an empty body', async () => {
      const supabase = makeSupabase({});
      const { sendMessage } = loadService(supabase);

      await expect(sendMessage('conv-1', '   ')).resolves.toBeNull();
      expect(supabase.from).not.toHaveBeenCalled();
    });

    it('returns null when the insert errors', async () => {
      const supabase = makeSupabase({ messages: { data: null, error: { message: 'rate_limited' } } });
      const { sendMessage } = loadService(supabase);

      await expect(sendMessage('conv-1', 'hey')).resolves.toBeNull();
    });
  });

  describe('markConversationRead', () => {
    it('moves only this user\'s read cursor', async () => {
      const supabase = makeSupabase({ participants: { data: null, error: null } });
      const { markConversationRead } = loadService(supabase);

      await expect(markConversationRead('conv-1')).resolves.toBe(true);

      const update = writesTo(supabase.calls, 'conversation_participants', 'update')[0];
      expect(Object.keys(update.args[0] as object)).toEqual(['last_read_at']);
      const filters = supabase.calls.filter(
        (call) => call.table === 'conversation_participants' && call.method === 'eq',
      );
      expect(filters.map((call) => call.args)).toEqual([
        ['conversation_id', 'conv-1'],
        ['user_id', 'me'],
      ]);
    });

    it('returns false when the update errors', async () => {
      const supabase = makeSupabase({ participants: { data: null, error: { message: 'boom' } } });
      const { markConversationRead } = loadService(supabase);

      await expect(markConversationRead('conv-1')).resolves.toBe(false);
    });
  });

  describe('safe empty values', () => {
    it('never throws when Supabase is unavailable', async () => {
      const service = loadService(null);

      await expect(service.findOrCreateDm('you')).resolves.toBeNull();
      await expect(service.fetchConversations()).resolves.toEqual([]);
      await expect(service.fetchMessages('conv-1')).resolves.toEqual([]);
      await expect(service.sendMessage('conv-1', 'hey')).resolves.toBeNull();
      await expect(service.markConversationRead('conv-1')).resolves.toBe(false);
    });

    it('never throws when the user is signed out', async () => {
      const service = loadService(makeSupabase({}, null));

      await expect(service.findOrCreateDm('you')).resolves.toBeNull();
      await expect(service.fetchConversations()).resolves.toEqual([]);
      await expect(service.sendMessage('conv-1', 'hey')).resolves.toBeNull();
      await expect(service.markConversationRead('conv-1')).resolves.toBe(false);
    });
  });
});
