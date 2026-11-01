import { supabase } from '@/lib/supabase';
import { fetchEventPosts, type FeedPost } from '@/features/social/social-service';

/**
 * Booth posts (social_27, docs/booth-posts-vendor-spec-2026-10-29.md).
 *
 * Client-direct Supabase, same contract as social-service: never throws, every
 * failure resolves to an empty/neutral value. Every write is an RPC so dedupe,
 * the one-claim-per-booth rule and the stats privacy check live in Postgres.
 */

export type BoothClaim = {
  vendorId: string;
  userId: string;
  handle: string | null;
  claimedAt: string;
};

export type ClaimBoothResult = 'claimed' | 'already_yours' | 'taken' | 'limit' | 'unauthenticated' | 'error';

export type BoothEventKind = 'card_open' | 'instagram_tap' | 'message_start' | 'post_view';

export type BoothStats = {
  /** Totals at this show. */
  views: number;
  instagramTaps: number;
  messages: number;
  postViews: number;
  /** Distinct people who opened the card. */
  viewers: number;
  /** Card opens in the last 24h. */
  viewsToday: number;
};

export type BoothPost = FeedPost & { boothVendorId: string };

const EMPTY_STATS: BoothStats = {
  views: 0,
  instagramTaps: 0,
  messages: 0,
  postViews: 0,
  viewers: 0,
  viewsToday: 0,
};

/**
 * Active claims for these vendors, keyed by vendor id, with the holder's handle.
 * Null when booths aren't available (no client, or social_27 not applied), so
 * the map can hide the claim button instead of offering one that fails.
 */
export async function fetchBoothClaims(vendorIds: string[]): Promise<Map<string, BoothClaim> | null> {
  const claims = new Map<string, BoothClaim>();
  if (!supabase) {
    return null;
  }
  if (vendorIds.length === 0) {
    return claims;
  }
  try {
    const { data, error } = await supabase
      .from('booth_claims')
      .select('vendor_id, user_id, claimed_at')
      .is('revoked_at', null)
      .in('vendor_id', vendorIds);
    if (error || !data) {
      return null;
    }
    const rows = data as { vendor_id: string; user_id: string; claimed_at: string }[];
    const handles = new Map<string, string | null>();
    const userIds = [...new Set(rows.map((row) => row.user_id))];
    if (userIds.length > 0) {
      const { data: profiles } = await supabase
        .from('public_profiles')
        .select('user_id, handle')
        .in('user_id', userIds);
      for (const profile of (profiles ?? []) as { user_id: string; handle: string | null }[]) {
        handles.set(profile.user_id, profile.handle);
      }
    }
    for (const row of rows) {
      claims.set(row.vendor_id, {
        vendorId: row.vendor_id,
        userId: row.user_id,
        handle: handles.get(row.user_id) ?? null,
        claimedAt: row.claimed_at,
      });
    }
    return claims;
  } catch {
    return null;
  }
}

export async function claimBooth(vendorId: string, eventId: string): Promise<ClaimBoothResult> {
  if (!supabase) {
    return 'error';
  }
  try {
    const { data, error } = await supabase.rpc('claim_booth', { p_vendor_id: vendorId, p_event_id: eventId });
    if (error || typeof data !== 'string') {
      return 'error';
    }
    return data as ClaimBoothResult;
  } catch {
    return 'error';
  }
}

export async function unclaimBooth(vendorId: string): Promise<boolean> {
  if (!supabase) {
    return false;
  }
  try {
    const { data, error } = await supabase.rpc('unclaim_booth', { p_vendor_id: vendorId });
    return !error && data === true;
  } catch {
    return false;
  }
}

export async function reportBoothClaim(vendorId: string): Promise<boolean> {
  if (!supabase) {
    return false;
  }
  try {
    const { data: session } = await supabase.auth.getSession();
    const me = session?.session?.user?.id;
    if (!me) {
      return false;
    }
    const { error } = await supabase.from('booth_reports').insert({ vendor_id: vendorId, reporter_id: me });
    // A repeat report hits the primary key; it was already recorded.
    return !error || error.code === '23505';
  } catch {
    return false;
  }
}

/** Fire-and-forget; the server dedupes per viewer/booth/kind every 10 minutes. */
export function recordBoothEvent(eventId: string, vendorId: string, kind: BoothEventKind): void {
  if (!supabase) {
    return;
  }
  void Promise.resolve(
    supabase.rpc('record_booth_event', { p_event_id: eventId, p_vendor_id: vendorId, p_kind: kind }),
  ).catch(() => undefined);
}

/** The claimer's private numbers for one booth at one show; zeros when not allowed. */
export async function fetchBoothStats(vendorId: string, eventId: string): Promise<BoothStats> {
  if (!supabase) {
    return EMPTY_STATS;
  }
  try {
    const { data, error } = await supabase.rpc('booth_stats', { p_vendor_id: vendorId, p_event_id: eventId });
    if (error || !Array.isArray(data)) {
      return EMPTY_STATS;
    }
    const stats = { ...EMPTY_STATS };
    for (const row of data as { kind: BoothEventKind; total: number; viewers: number; last_24h: number }[]) {
      const total = Number(row.total) || 0;
      if (row.kind === 'card_open') {
        stats.views = total;
        stats.viewers = Number(row.viewers) || 0;
        stats.viewsToday = Number(row.last_24h) || 0;
      } else if (row.kind === 'instagram_tap') {
        stats.instagramTaps = total;
      } else if (row.kind === 'message_start') {
        stats.messages = total;
      } else if (row.kind === 'post_view') {
        stats.postViews = total;
      }
    }
    return stats;
  } catch {
    return EMPTY_STATS;
  }
}

export function touchEventPresence(eventId: string): void {
  if (!supabase || !eventId) {
    return;
  }
  void Promise.resolve(supabase.rpc('touch_event_presence', { p_event_id: eventId })).catch(() => undefined);
}

/** People on this show's page or map in the last 15 minutes; null when unknown. */
export async function fetchBrowsingNow(eventId: string): Promise<number | null> {
  if (!supabase || !eventId) {
    return null;
  }
  try {
    const { data, error } = await supabase.rpc('event_browsing_now', { p_event_id: eventId });
    return error || typeof data !== 'number' ? null : data;
  } catch {
    return null;
  }
}

/**
 * Booth posts at one show, newest first, each with its vendor id. Attendee
 * posts tagged to the same show (social_28) are filtered out server side so
 * they can't crowd booth posts out of the page.
 */
export async function fetchBoothPosts(eventId: string): Promise<BoothPost[]> {
  if (!supabase || !eventId) {
    return [];
  }
  try {
    const posts = await fetchEventPosts(eventId, 60, { boothOnly: true });
    return posts.flatMap((post) => (post.boothVendorId ? [{ ...post, boothVendorId: post.boothVendorId }] : []));
  } catch {
    return [];
  }
}

/** The signed-in user's active claims (vendor ids). */
export async function fetchMyBoothClaims(): Promise<string[]> {
  if (!supabase) {
    return [];
  }
  try {
    const { data: session } = await supabase.auth.getSession();
    const me = session?.session?.user?.id;
    if (!me) {
      return [];
    }
    const { data, error } = await supabase
      .from('booth_claims')
      .select('vendor_id')
      .eq('user_id', me)
      .is('revoked_at', null);
    if (error || !data) {
      return [];
    }
    return (data as { vendor_id: string }[]).map((row) => row.vendor_id);
  } catch {
    return [];
  }
}

/** Whether the signed-in user tagged a post to this booth since `since` (pending moderation included). */
export async function hasPostedToBoothSince(eventId: string, vendorId: string, since: Date): Promise<boolean | null> {
  if (!supabase || !eventId || !vendorId) {
    return null;
  }
  try {
    const { data: session } = await supabase.auth.getSession();
    const me = session?.session?.user?.id;
    if (!me) {
      return null;
    }
    const { data, error } = await supabase
      .from('posts')
      .select('id')
      .eq('author_id', me)
      .eq('event_id', eventId)
      .eq('booth_vendor_id', vendorId)
      .is('deleted_at', null)
      .gte('created_at', since.toISOString())
      .limit(1);
    if (error || !data) {
      return null;
    }
    return data.length > 0;
  } catch {
    return null;
  }
}

/** A `setof text` RPC's rows: bare strings, or `{fn: value}` objects on older PostgREST. */
function vendorIdRows(data: unknown[], fn: string): string[] {
  return data.flatMap((row) => {
    const value = typeof row === 'object' && row != null ? (row as Record<string, unknown>)[fn] : row;
    return typeof value === 'string' && value ? [value] : [];
  });
}

/**
 * Vendors at this show whose Treasure application email is the signed-in
 * user's own (social_29 compares hashes server side; no email leaves Postgres).
 */
export async function suggestMyBooth(eventId: string): Promise<string[]> {
  if (!supabase || !eventId) {
    return [];
  }
  try {
    const { data, error } = await supabase.rpc('suggest_my_booth', { p_event_id: eventId });
    if (error || !Array.isArray(data)) {
      return [];
    }
    return vendorIdRows(data, 'suggest_my_booth');
  } catch {
    return [];
  }
}

/** Booths with card opens from several people in the last 30 minutes, hottest first; never counts. */
export async function fetchHotBooths(eventId: string): Promise<string[]> {
  if (!supabase || !eventId) {
    return [];
  }
  try {
    const { data, error } = await supabase.rpc('event_hot_booths', { p_event_id: eventId });
    if (error || !Array.isArray(data)) {
      return [];
    }
    return vendorIdRows(data, 'event_hot_booths');
  } catch {
    return [];
  }
}
