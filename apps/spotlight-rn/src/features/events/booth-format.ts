import type { BoothPost, BoothStats } from '@/features/events/booth-service';

/** A booth post this recent puts a dot on its vendor's pin. */
export const BOOTH_POST_FRESH_MS = 24 * 60 * 60_000;

/** "now", "12m", "3h", "2d" — the age on a "From the floor" card. */
export function formatBoothPostAge(createdAt: string, now: number = Date.now()): string {
  const then = Date.parse(createdAt);
  if (Number.isNaN(then)) {
    return '';
  }
  const minutes = Math.floor(Math.max(0, now - then) / 60_000);
  if (minutes < 1) {
    return 'now';
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.floor(hours / 24)}d ago`;
}

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

/** "Your booth: 63 views · 14 Instagram taps · 3 messages". */
export function formatBoothStats(stats: BoothStats): string {
  return [
    plural(stats.views, 'view', 'views'),
    plural(stats.instagramTaps, 'Instagram tap', 'Instagram taps'),
    plural(stats.messages, 'message', 'messages'),
  ].join(' · ');
}

/** Posts grouped by vendor (newest first, as fetched) and the vendors who posted in the last 24h. */
export function groupBoothPosts(
  posts: readonly BoothPost[],
  now: number = Date.now(),
): { byVendor: Map<string, BoothPost[]>; freshVendorIds: Set<string> } {
  const byVendor = new Map<string, BoothPost[]>();
  const freshVendorIds = new Set<string>();
  for (const post of posts) {
    const list = byVendor.get(post.boothVendorId);
    if (list) {
      list.push(post);
    } else {
      byVendor.set(post.boothVendorId, [post]);
    }
    const created = Date.parse(post.createdAt);
    if (!Number.isNaN(created) && now - created < BOOTH_POST_FRESH_MS) {
      freshVendorIds.add(post.boothVendorId);
    }
  }
  return { byVendor, freshVendorIds };
}
