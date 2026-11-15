import AsyncStorage from '@react-native-async-storage/async-storage';

import type { BoothPost } from '@/features/events/booth-service';
import {
  boothStoryQueue,
  buildBoothStories,
  firstUnseenFrameIndex,
  orderBoothStories,
  storyRing,
} from '@/features/events/booth-stories';
import {
  loadSeenBoothPosts,
  markBoothPostSeen,
  resetBoothStoriesForTests,
} from '@/features/events/booth-stories-store';

jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem: jest.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
      setItem: jest.fn((key: string, value: string) => {
        store.set(key, value);
        return Promise.resolve();
      }),
      clear: jest.fn(() => {
        store.clear();
        return Promise.resolve();
      }),
    },
  };
});

const NOW = Date.parse('2026-10-31T20:00:00Z');
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

function post(id: string, vendorId: string, createdAt: string, mediaCount = 1): BoothPost {
  return {
    id,
    authorId: 'u',
    author: null,
    body: null,
    cardId: null,
    likeCount: 0,
    commentCount: 0,
    repostCount: 0,
    createdAt,
    media: Array.from({ length: mediaCount }, (_, index) => ({
      id: `${id}-m${index}`,
      width: null,
      height: null,
      blurhash: null,
    })),
    boothVendorId: vendorId,
  };
}

// Newest first, as fetched.
const POSTS = [
  post('b2', 'b', minutesAgo(5)),
  post('a2', 'a', minutesAgo(10), 2),
  post('a1', 'a', minutesAgo(60)),
  post('text', 'c', minutesAgo(1), 0),
  post('stale', 'd', minutesAgo(25 * 60)),
  post('off-map', 'x', minutesAgo(1)),
];

describe('booth stories', () => {
  const stories = buildBoothStories(POSTS, new Set(['a', 'b', 'c', 'd']), NOW);

  it('photo posts from the last day, per vendor, newest vendor first, frames oldest first', () => {
    expect(stories.map((story) => story.vendorId)).toEqual(['b', 'a']);
    const a = stories[1]!;
    // A two-image post is two frames.
    expect(a.frames.map((frame) => frame.key)).toEqual(['a1:a1-m0', 'a2:a2-m0', 'a2:a2-m1']);
    expect(a.postIds).toEqual(['a1', 'a2']);
  });

  it('rings: unseen until every post is seen, none without a story', () => {
    const a = stories[1]!;
    expect(storyRing(a, new Set())).toBe('unseen');
    expect(storyRing(a, new Set(['a1']))).toBe('unseen');
    expect(storyRing(a, new Set(['a1', 'a2']))).toBe('seen');
    expect(storyRing(undefined, new Set())).toBeNull();
  });

  it('orders unseen vendors first, and the queue starts at the tapped vendor', () => {
    const seen = new Set(['b2']);
    const ordered = orderBoothStories(stories, seen);
    expect(ordered.map((story) => story.vendorId)).toEqual(['a', 'b']);
    expect(boothStoryQueue(ordered, 'b')).toEqual(['b', 'a']);
    expect(boothStoryQueue(ordered, 'missing')).toEqual(['a', 'b']);
  });

  it('resumes at the first unseen post, or the top when all are seen', () => {
    const a = stories[1]!;
    expect(firstUnseenFrameIndex(a, new Set())).toBe(0);
    expect(firstUnseenFrameIndex(a, new Set(['a1']))).toBe(1);
    expect(firstUnseenFrameIndex(a, new Set(['a1', 'a2']))).toBe(0);
  });
});

describe('seen store', () => {
  beforeEach(async () => {
    resetBoothStoriesForTests();
    await AsyncStorage.clear();
  });

  it('persists seen post ids per session owner', async () => {
    await loadSeenBoothPosts('owner-a');
    markBoothPostSeen('owner-a', 'p1');
    expect(JSON.parse((await AsyncStorage.getItem('@spotlight/events/story-seen/owner-a')) ?? '[]')).toEqual(['p1']);
    // Another owner never sees them.
    expect(await AsyncStorage.getItem('@spotlight/events/story-seen/owner-b')).toBeNull();
  });

  it('keeps ids marked while storage loads, alongside the stored ones', async () => {
    await AsyncStorage.setItem('@spotlight/events/story-seen/owner-a', JSON.stringify(['old']));
    const load = loadSeenBoothPosts('owner-a');
    markBoothPostSeen('owner-a', 'new');
    await load;
    expect(JSON.parse((await AsyncStorage.getItem('@spotlight/events/story-seen/owner-a')) ?? '[]')).toEqual([
      'old',
      'new',
    ]);
  });
});
