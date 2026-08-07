import { sha256 } from 'js-sha256';

import { supabase } from '@/lib/supabase';

/**
 * Client-direct Supabase reads/writes for direct messages (`social_02` schema).
 *
 * Same contract as `social-service.ts`: every function is client-direct, NEVER
 * throws, and resolves to a safe empty value (`[]` / `null` / `false` / `0`) on
 * any failure — missing Supabase client, unauthenticated, RLS-filtered rows, a
 * rejected query. A DM read must never be able to block a render.
 *
 * RLS shape worth holding in your head, because every query here is written to
 * satisfy it: `conversations`, `conversation_participants`, and `messages` are
 * ALL gated on `is_conversation_participant(conversation_id, auth.uid())`. That
 * means the server already scopes reads to your own threads — the selects below
 * carry only presentational filters and ordering on top, never an ownership
 * filter that RLS is already enforcing.
 */

const CONVERSATIONS_TABLE = 'conversations';
const CONVERSATION_PARTICIPANTS_TABLE = 'conversation_participants';
const MESSAGES_TABLE = 'messages';
const PUBLIC_PROFILES_VIEW = 'public_profiles';

/** Inbox page size. The inbox is a navigation target, not a feed — one page is plenty. */
const DEFAULT_CONVERSATION_LIMIT = 50;
/** Thread page size: the newest N messages, which is what a freshly opened thread renders. */
const DEFAULT_MESSAGE_LIMIT = 50;

// `last_message_preview` is denormalized onto `conversations` by
// `tg_messages_touch_conversation` (social_13), the same trigger that already
// stamps `last_message_at`. Reading it here is what lets the inbox draw a
// preview row without a per-thread `fetchMessages` — the same N+1 the unread
// RPC exists to kill, which would otherwise reappear on a different column.
const conversationSelect =
  'id, is_group, dm_key, last_message_at, last_message_preview, created_at';
const participantSelect = 'conversation_id, user_id, last_read_at';
// `content_status` is read so a moderation-removed message can be dropped
// client-side as a belt-and-braces guard; it never reaches the normalized
// `DmMessage`. RLS already excludes `deleted_at is not null`.
const messageSelect = 'id, conversation_id, sender_id, body, created_at, content_status';
// The same identity columns the feed reads — a DM row renders exactly what a
// post header renders.
const dmUserSelect = 'user_id, display_name, avatar_url, handle, is_verified';

type ConversationRow = {
  id: string;
  is_group: boolean | null;
  dm_key: string | null;
  last_message_at: string | null;
  last_message_preview: string | null;
  created_at: string;
};

type ParticipantRow = {
  conversation_id: string;
  user_id: string;
  last_read_at: string | null;
};

type MessageRow = {
  id: string;
  conversation_id: string;
  sender_id: string;
  body: string | null;
  created_at: string;
  content_status: string | null;
};

type DmUserRow = {
  user_id: string;
  display_name: string | null;
  avatar_url: string | null;
  handle: string | null;
  is_verified: boolean | null;
};

/** Identity of the person on the other side of a thread. Mirrors `FeedPostAuthor`. */
export type DmUser = {
  displayName: string | null;
  handle: string | null;
  avatarUrl: string | null;
  isVerified: boolean;
};

export type DmConversation = {
  id: string;
  isGroup: boolean;
  /** Null for groups, and for a thread whose only visible participant is you. */
  otherUserId: string | null;
  /** Null when the other participant isn't publicly visible (blocked/suspended/hidden). */
  otherUser: DmUser | null;
  lastMessageAt: string | null;
  /**
   * The last message's text, truncated to 200 chars server-side and maintained by
   * the trigger that stamps `lastMessageAt` — never fetched per row.
   *
   * Null in three cases the inbox must all render the same blank way: a thread
   * created but never written to, a last message the moderation prefilter marked
   * `removed` (its body must not leak into a list that sits outside the thread
   * hiding it), and an older row the backfill could not resolve.
   */
  lastMessagePreview: string | null;
  /** Your own read cursor. Null until you have opened the thread once. */
  lastReadAt: string | null;
  unreadCount: number;
};

export type DmMessage = {
  id: string;
  conversationId: string;
  senderId: string;
  body: string;
  createdAt: string;
};

/**
 * The signed-in user's id, or null when unauthenticated / Supabase absent.
 *
 * Identical to `social-service.ts`: read the persisted session (local, no I/O)
 * and only fall back to `auth.getUser()` — a full auth round trip — when no
 * session is cached. Sending a message would otherwise pay that round trip on
 * every keystroke-to-send. The id only shapes the query; RLS still validates the
 * JWT server-side, so trusting the cached session costs nothing.
 */
async function currentUserId(): Promise<string | null> {
  if (!supabase) {
    return null;
  }
  try {
    if (typeof supabase.auth.getSession === 'function') {
      const { data } = await supabase.auth.getSession();
      const sessionUserId = data?.session?.user?.id ?? null;
      if (sessionUserId) {
        return sessionUserId;
      }
    }
    const { data } = await supabase.auth.getUser();
    return data.user?.id ?? null;
  } catch {
    return null;
  }
}

function mapDmUser(row: DmUserRow): DmUser {
  return {
    displayName: row.display_name,
    handle: row.handle ?? null,
    avatarUrl: row.avatar_url ?? null,
    isVerified: row.is_verified === true,
  };
}

/**
 * Batched identity hydration: ONE `public_profiles` read for every user id in the
 * page, never one per row. Same reason as the feed — `conversation_participants.user_id`
 * FKs to `auth.users`, not to the view, so PostgREST can't embed it, and an inbox
 * of 50 threads would otherwise cost 50 round trips.
 *
 * A hydration failure yields `null` identities rather than an empty inbox: a
 * thread with a blank name is still a thread you can open.
 */
async function hydrateDmUsers(userIds: string[]): Promise<Map<string, DmUser>> {
  const ids = Array.from(new Set(userIds.filter(Boolean)));
  const byId = new Map<string, DmUser>();
  if (!supabase || ids.length === 0) {
    return byId;
  }
  try {
    const { data, error } = await supabase
      .from(PUBLIC_PROFILES_VIEW)
      .select(dmUserSelect)
      .in('user_id', ids);
    if (error || !data) {
      return byId;
    }
    for (const row of data as DmUserRow[]) {
      byId.set(row.user_id, mapDmUser(row));
    }
  } catch {
    // Fall through with whatever hydrated.
  }
  return byId;
}

// ---------------------------------------------------------------------------
// Conversation identity
// ---------------------------------------------------------------------------

/**
 * The `dm_key` for a 1:1 thread: both user ids SORTED, joined with ':'.
 *
 * The sort is the entire point of the column. Without it, "me:you" and "you:me"
 * are two different keys, so you and I each open the other's profile and each
 * create our own thread for the same relationship — two inboxes, messages split
 * across both, neither showing the full conversation. Sorting makes the key a
 * property of the PAIR rather than of whoever tapped first, and the unique index
 * on `dm_key` then makes "one thread per pair" a database guarantee instead of a
 * client convention.
 */
function buildDmKey(userA: string, userB: string): string {
  return [userA, userB].sort().join(':');
}

// Namespace prefix so the derivation below can never collide with an id derived
// from some other string that happens to look like a dm_key.
const DM_ID_NAMESPACE = 'spotlight:dm:v1:';

/**
 * A deterministic conversation id derived from the `dm_key` (a name-based,
 * UUIDv5-shaped uuid: sha256 of the namespaced key, with the RFC-4122 version and
 * variant nibbles stamped in).
 *
 * This is NOT premature cleverness — it is what makes creation possible at all
 * under this schema's RLS. `conversations_select` is
 * `is_conversation_participant(id, auth.uid())`, and Postgres applies SELECT
 * policies to an INSERT's RETURNING clause. supabase-js adds RETURNING whenever
 * you chain `.select()`, so `insert(...).select('id')` on a brand-new conversation
 * is evaluated at a moment when your participant row does not exist yet — the
 * row fails its own SELECT policy and the whole statement is rejected. There is
 * no second chance: with the insert rolled back and no id in hand, the thread can
 * never be created.
 *
 * Knowing the id up-front breaks that circle — we insert without RETURNING and
 * still hold the id we need for the participant rows. It also makes the
 * simultaneous-open race benign: both peers derive the SAME id from the same
 * pair, so the loser's insert is a no-op on an identical row rather than a second
 * thread. Guessability is not a concern — RLS gates access by participation, not
 * by knowing an id.
 */
function deriveConversationId(dmKey: string): string {
  const hex = sha256(`${DM_ID_NAMESPACE}${dmKey}`).slice(0, 32);
  // Version 5 = name-based. Variant nibble must be one of 8/9/a/b.
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

/** The conversation id already carrying this `dm_key`, or null. */
async function findConversationIdByDmKey(dmKey: string): Promise<string | null> {
  if (!supabase) {
    return null;
  }
  try {
    // No `.eq('user_id', me)` anywhere: RLS already restricts this table to
    // conversations you participate in, so a hit here also PROVES your
    // participant row exists.
    const { data, error } = await supabase
      .from(CONVERSATIONS_TABLE)
      .select('id')
      .eq('dm_key', dmKey)
      .maybeSingle();
    if (error || !data) {
      return null;
    }
    return (data as { id: string }).id ?? null;
  } catch {
    return null;
  }
}

/** Idempotent participant insert. `true` when the row exists afterward. */
/** Postgres unique-violation. A duplicate here means the row already exists. */
const PG_UNIQUE_VIOLATION = '23505';

/**
 * Add a participant row, treating "already there" as success.
 *
 * PLAIN INSERT, NOT UPSERT — this is load-bearing, and it was a real bug.
 * supabase-js `.upsert()` compiles to `INSERT ... ON CONFLICT`, and Postgres
 * requires an UPDATE policy to be present for that form. `social_02` gives these
 * tables only SELECT and INSERT policies, so EVERY upsert was rejected with
 * 42501 "new row violates row-level security policy" — regardless of
 * `ignoreDuplicates`. A plain insert with the identical body succeeds.
 *
 * Verified against staging: plain insert 201, upsert 403 with both
 * `ignore-duplicates` and `merge-duplicates`.
 *
 * So the duplicate is caught here instead: a 23505 means the row is already
 * present, which is exactly the state the caller wanted.
 */
async function addParticipant(conversationId: string, userId: string): Promise<boolean> {
  if (!supabase) {
    return false;
  }
  try {
    const { error } = await supabase
      .from(CONVERSATION_PARTICIPANTS_TABLE)
      .insert({ conversation_id: conversationId, user_id: userId });
    if (!error) {
      return true;
    }
    return (error as { code?: string }).code === PG_UNIQUE_VIOLATION;
  } catch {
    return false;
  }
}

/**
 * Find (or create) the 1:1 thread between the signed-in user and `otherUserId`,
 * returning its id. Null on any failure.
 */
export async function findOrCreateDm(otherUserId: string): Promise<string | null> {
  const me = await currentUserId();
  const other = (otherUserId ?? '').trim();
  // A thread with yourself has no "other participant", so every inbox row and
  // thread header would render blank. Nothing in the product asks for a
  // note-to-self thread, so refuse rather than create an unrenderable one.
  if (!supabase || !me || !other || other === me) {
    return null;
  }

  const dmKey = buildDmKey(me, other);

  try {
    const existing = await findConversationIdByDmKey(dmKey);
    if (existing) {
      // Self-heal: a create that died between the two participant inserts leaves
      // a thread only I can see, and the other person can never reach it (their
      // own `findOrCreateDm` would hit the unique `dm_key` and find nothing they
      // are allowed to select). One ON CONFLICT DO NOTHING write fixes that; my
      // own row provably exists, or the select above could not have returned.
      await addParticipant(existing, other);
      return existing;
    }

    const conversationId = deriveConversationId(dmKey);

    // Deliberately no `.select()` — see `deriveConversationId`.
    //
    // PLAIN INSERT, NOT UPSERT — same reason as `addParticipant`: `.upsert()`
    // compiles to `INSERT ... ON CONFLICT`, which Postgres will only allow when
    // an UPDATE policy exists, and `conversations` has none. Every upsert here
    // was rejected with 42501, the error was never checked, and the participant
    // insert then failed on a conversation that had never been created — which
    // surfaced as "Couldn't open that conversation" for every DM ever attempted.
    //
    // A unique violation on `dm_key` is the good case: someone else created the
    // thread between our lookup and our insert. Since the id is derived FROM the
    // key, their row and ours are the same row, so we simply continue.
    const { error: createError } = await supabase
      .from(CONVERSATIONS_TABLE)
      .insert({ id: conversationId, is_group: false, dm_key: dmKey, created_by: me });
    if (createError && (createError as { code?: string }).code !== PG_UNIQUE_VIOLATION) {
      // A real failure (RLS, connectivity). Re-read in case a concurrent writer
      // succeeded where we did not; null if there is genuinely nothing.
      return findConversationIdByDmKey(dmKey);
    }

    // Mine first, and as its own statement. `conv_participants_insert` allows
    // adding someone else only once `is_conversation_participant(conv, me)` is
    // true, and that helper is STABLE — inside a single multi-row INSERT it would
    // still be reading the pre-statement snapshot and would not see the row being
    // inserted alongside. Two statements, in this order, is what makes the second
    // insert legal.
    const mineAdded = await addParticipant(conversationId, me);
    if (!mineAdded) {
      // The only realistic cause is a foreign-key failure: the conversation row
      // does not carry our derived id, because an older thread already held this
      // dm_key. Re-read by key — if that pre-existing thread includes us, it is
      // the right answer.
      return findConversationIdByDmKey(dmKey);
    }

    await addParticipant(conversationId, other);
    return conversationId;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------

/**
 * Unread counts for EVERY thread, in one round trip.
 *
 * This used to be one count-only request per conversation, fired in parallel —
 * correct, but up to `limit` (50) HTTP requests to draw a single screen, because
 * PostgREST cannot express a grouped count without an RPC and this schema
 * shipped none. `social_13` adds `unread_dm_counts()`, so it is now one call.
 *
 * The RPC takes no arguments ON PURPOSE: it pins the caller to `auth.uid()`
 * internally, so it cannot be aimed at someone else's inbox. It also omits
 * threads with nothing unread rather than returning zeros — the payload stays
 * proportional to what actually needs a badge, and a conversation missing from
 * the map is simply zero.
 *
 * Returns an empty map on any failure: a missing badge is a far better outcome
 * than an inbox that refuses to render.
 */
async function fetchUnreadCounts(): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (!supabase) {
    return counts;
  }
  try {
    const { data, error } = await supabase.rpc('unread_dm_counts');
    if (error || !Array.isArray(data)) {
      return counts;
    }
    for (const row of data as { conversation_id: string; unread_count: number }[]) {
      // `bigint` crosses the wire as a string in some PostgREST versions, so
      // coerce rather than trusting the declared type.
      counts.set(row.conversation_id, Number(row.unread_count) || 0);
    }
    return counts;
  } catch {
    return counts;
  }
}

/**
 * The DM inbox, most recently active thread first.
 *
 * Read state lives on `conversation_participants.last_read_at` — one timestamp
 * per person per thread — rather than a per-message read flag. That is a
 * deliberate schema choice worth respecting here: a per-message model writes one
 * row per message per reader every time a thread is opened, which is the single
 * most write-heavy thing a chat feature can do. A cursor makes "mark read" one
 * UPDATE regardless of how many messages you just scrolled past, and makes
 * unread a range scan rather than a join.
 */
export async function fetchConversations(limit = DEFAULT_CONVERSATION_LIMIT): Promise<DmConversation[]> {
  const me = await currentUserId();
  if (!supabase || !me) {
    return [];
  }

  try {
    // RLS scopes this to threads I participate in, so ordering and limiting can
    // happen server-side on the real inbox rather than on a superset.
    // `last_message_at` is null for a thread created but never written to; those
    // sort last rather than jumping to the top of the inbox.
    const { data: conversationData, error: conversationError } = await supabase
      .from(CONVERSATIONS_TABLE)
      .select(conversationSelect)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(limit);
    if (conversationError || !conversationData) {
      return [];
    }

    const conversations = conversationData as ConversationRow[];
    if (conversations.length === 0) {
      return [];
    }
    const conversationIds = conversations.map((row) => row.id);

    // One read for every participant of every listed thread — mine (for the
    // read cursor) and theirs (for identity) in the same round trip.
    const { data: participantData } = await supabase
      .from(CONVERSATION_PARTICIPANTS_TABLE)
      .select(participantSelect)
      .in('conversation_id', conversationIds);
    const participants = (participantData ?? []) as ParticipantRow[];

    const myReadCursor = new Map<string, string | null>();
    const othersByConversation = new Map<string, string[]>();
    for (const row of participants) {
      if (row.user_id === me) {
        myReadCursor.set(row.conversation_id, row.last_read_at ?? null);
        continue;
      }
      const list = othersByConversation.get(row.conversation_id) ?? [];
      list.push(row.user_id);
      othersByConversation.set(row.conversation_id, list);
    }

    const usersById = await hydrateDmUsers(
      Array.from(othersByConversation.values()).flat(),
    );

    // One RPC for the whole inbox — see fetchUnreadCounts.
    const unreadCounts = await fetchUnreadCounts();

    return conversations.map((row) => {
      const others = othersByConversation.get(row.id) ?? [];
      // A 1:1 thread has exactly one other participant. Anything else (a group,
      // or a half-created thread) has no single "other side" to render.
      const otherUserId = row.is_group !== true && others.length === 1 ? others[0] : null;
      return {
        id: row.id,
        isGroup: row.is_group === true,
        otherUserId,
        otherUser: otherUserId ? usersById.get(otherUserId) ?? null : null,
        lastMessageAt: row.last_message_at ?? null,
        // Straight through, including null: the column is already truncated and
        // already moderation-aware, so there is nothing left for the client to
        // decide beyond how a null renders.
        lastMessagePreview: row.last_message_preview ?? null,
        lastReadAt: myReadCursor.get(row.id) ?? null,
        unreadCount: unreadCounts.get(row.id) ?? 0,
      };
    });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Thread
// ---------------------------------------------------------------------------

function toDmMessage(row: MessageRow): DmMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    body: row.body ?? '',
    createdAt: row.created_at,
  };
}

/** Moderation-removed messages never render. RLS already drops soft-deleted rows. */
function isRenderableMessage(row: MessageRow): boolean {
  return row.content_status !== 'removed' && row.content_status !== 'deleted';
}

/**
 * One thread's messages, oldest-first so a list can render them top-to-bottom.
 *
 * Read newest-first and reversed in memory on purpose: `limit` has to apply to
 * the NEWEST window, and PostgREST applies it after ordering — ordering ascending
 * would hand back the oldest 50 messages of a long thread, which is the one page
 * nobody wants to open on. Sorting the page back locally is free at this size.
 */
export async function fetchMessages(
  conversationId: string,
  limit = DEFAULT_MESSAGE_LIMIT,
): Promise<DmMessage[]> {
  const trimmed = (conversationId ?? '').trim();
  if (!supabase || !trimmed) {
    return [];
  }
  try {
    const { data, error } = await supabase
      .from(MESSAGES_TABLE)
      .select(messageSelect)
      .eq('conversation_id', trimmed)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error || !data) {
      return [];
    }
    return (data as MessageRow[])
      .filter(isRenderableMessage)
      .map(toDmMessage)
      .reverse();
  } catch {
    return [];
  }
}

/**
 * Send a message, returning the stored row so the caller can swap its optimistic
 * entry for the real one (server id and server timestamp — the local clock is not
 * authoritative and would sort wrongly against messages from the other side).
 *
 * Unlike the conversation insert, `.select()` is safe here: `messages_select`
 * only needs participation, which is already true for the sender, so the row
 * passes its own SELECT policy inside the RETURNING clause.
 *
 * Returns null when the moderation prefilter marks the message `removed` — it
 * will not survive the next read, so reporting success would leave a message on
 * screen that quietly vanishes on refresh.
 */
export async function sendMessage(conversationId: string, body: string): Promise<DmMessage | null> {
  const me = await currentUserId();
  const trimmedId = (conversationId ?? '').trim();
  const text = (body ?? '').trim();
  if (!supabase || !me || !trimmedId || text.length === 0) {
    return null;
  }
  try {
    const { data, error } = await supabase
      .from(MESSAGES_TABLE)
      .insert({ conversation_id: trimmedId, sender_id: me, body: text })
      .select(messageSelect)
      .single();
    if (error || !data) {
      return null;
    }
    const row = data as MessageRow;
    return isRenderableMessage(row) ? toDmMessage(row) : null;
  } catch {
    return null;
  }
}

/**
 * Move this user's read cursor on a thread to now. One UPDATE, no matter how
 * many messages were just read — the whole reason read state is a per-participant
 * timestamp instead of per-message flags.
 *
 * `user_id = me` matches `conv_participants_update`, which only ever lets you
 * write your own row; you cannot mark a thread read on someone else's behalf.
 */
export async function markConversationRead(conversationId: string): Promise<boolean> {
  const me = await currentUserId();
  const trimmed = (conversationId ?? '').trim();
  if (!supabase || !me || !trimmed) {
    return false;
  }
  try {
    const { error } = await supabase
      .from(CONVERSATION_PARTICIPANTS_TABLE)
      .update({ last_read_at: new Date().toISOString() })
      .eq('conversation_id', trimmed)
      .eq('user_id', me);
    return !error;
  } catch {
    return false;
  }
}
