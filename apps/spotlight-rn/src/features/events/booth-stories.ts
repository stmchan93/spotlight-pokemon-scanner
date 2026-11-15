import { BOOTH_POST_FRESH_MS } from '@/features/events/booth-format';
import type { BoothPost } from '@/features/events/booth-service';
import type { FeedPostMedia } from '@/features/social/social-service';

/** One full-screen image; a multi-image post is several frames. */
export type BoothStoryFrame = {
  key: string;
  post: BoothPost;
  media: FeedPostMedia;
};

export type BoothStory = {
  vendorId: string;
  /** Oldest first, the order they play in. */
  frames: BoothStoryFrame[];
  postIds: string[];
  /** The newest post's time, for ordering. */
  latestAt: number;
};

export type StoryRing = 'unseen' | 'seen' | null;

/**
 * Vendors with a photo booth post in the last 24h, newest activity first.
 * `vendorIds` limits it to vendors on the map (null = no limit).
 */
export function buildBoothStories(
  posts: readonly BoothPost[],
  vendorIds: ReadonlySet<string> | null,
  now: number = Date.now(),
): BoothStory[] {
  const byVendor = new Map<string, { post: BoothPost; at: number }[]>();
  for (const post of posts) {
    const at = Date.parse(post.createdAt);
    if (post.media.length === 0 || Number.isNaN(at) || now - at >= BOOTH_POST_FRESH_MS) {
      continue;
    }
    if (vendorIds && !vendorIds.has(post.boothVendorId)) {
      continue;
    }
    const list = byVendor.get(post.boothVendorId) ?? [];
    list.push({ post, at });
    byVendor.set(post.boothVendorId, list);
  }
  const stories: BoothStory[] = [];
  for (const [vendorId, entries] of byVendor) {
    entries.sort((a, b) => a.at - b.at);
    stories.push({
      vendorId,
      frames: entries.flatMap(({ post }) =>
        post.media.map((media) => ({ key: `${post.id}:${media.id}`, post, media })),
      ),
      postIds: entries.map(({ post }) => post.id),
      latestAt: entries[entries.length - 1]?.at ?? 0,
    });
  }
  return stories.sort((a, b) => b.latestAt - a.latestAt);
}

export function isStorySeen(story: BoothStory, seenPostIds: ReadonlySet<string>): boolean {
  return story.postIds.every((id) => seenPostIds.has(id));
}

export function storyRing(story: BoothStory | undefined, seenPostIds: ReadonlySet<string>): StoryRing {
  if (!story) {
    return null;
  }
  return isStorySeen(story, seenPostIds) ? 'seen' : 'unseen';
}

/** Unseen vendors first, then seen; newest activity first within each. */
export function orderBoothStories(stories: readonly BoothStory[], seenPostIds: ReadonlySet<string>): BoothStory[] {
  const unseen = stories.filter((story) => !isStorySeen(story, seenPostIds));
  const seen = stories.filter((story) => isStorySeen(story, seenPostIds));
  return [...unseen, ...seen];
}

/** What the viewer plays: the tapped vendor, then everyone else in strip order. */
export function boothStoryQueue(ordered: readonly BoothStory[], startVendorId: string): string[] {
  const ids = ordered.map((story) => story.vendorId);
  return ids.includes(startVendorId) ? [startVendorId, ...ids.filter((id) => id !== startVendorId)] : ids;
}

/** Resume at the first frame of the first unseen post; from the top when all are seen. */
export function firstUnseenFrameIndex(story: BoothStory, seenPostIds: ReadonlySet<string>): number {
  const index = story.frames.findIndex((frame) => !seenPostIds.has(frame.post.id));
  return index < 0 ? 0 : index;
}
