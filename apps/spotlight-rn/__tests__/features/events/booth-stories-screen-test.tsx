import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { Dimensions } from 'react-native';
import { State } from 'react-native-gesture-handler';
import { fireGestureHandler, getByGestureTestId } from 'react-native-gesture-handler/jest-utils';

import { mockSpotlightEventMap } from '@spotlight/api-client';
import type { BoothClaim, BoothPost } from '@/features/events/booth-service';
import { recordBoothEvent } from '@/features/events/booth-service';
import {
  publishBoothStoriesSource,
  resetBoothStoriesForTests,
  subscribeBoothVendorSelect,
} from '@/features/events/booth-stories-store';
import { BoothStoriesScreen, STORY_FRAME_MS } from '@/features/events/screens/booth-stories-screen';
import { findOrCreateDm } from '@/features/social/dm-service';
import { capturePostHogEvent } from '@/lib/observability/posthog';

import { createTestSpotlightRepository, renderWithProviders } from '../../test-utils';
import { makeEvent } from './event-fixtures';

const mockPush = jest.fn();
jest.mock('expo-router', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    ...jest.requireActual('expo-router'),
    useFocusEffect: (effect: () => void | (() => void)) => {
      React.useEffect(() => effect(), [effect]);
    },
    useRouter: () => ({ push: mockPush, back: jest.fn(), replace: jest.fn(), navigate: jest.fn() }),
  };
});

jest.mock('expo-image', () => {
  const actual = jest.requireActual('expo-image');
  actual.Image.prefetch = jest.fn(async () => true);
  return actual;
});

jest.mock('@/features/events/booth-service', () => ({
  recordBoothEvent: jest.fn(),
  fetchBoothClaims: jest.fn(async () => new Map()),
  fetchBoothPosts: jest.fn(async () => []),
}));

jest.mock('@/features/social/dm-service', () => ({
  ...jest.requireActual('@/features/social/dm-service'),
  findOrCreateDm: jest.fn(async () => 'conv-1'),
}));

jest.mock('@/features/social/components/post-card', () => {
  const { View } = require('react-native');
  return {
    PostImage: ({ testID }: { testID?: string }) => <View testID={testID} />,
    postMediaUrl: (base: string, id: string) => `${base}/api/v1/post-media/${id}`,
  };
});

jest.mock('@/lib/observability/posthog', () => ({
  ...jest.requireActual('@/lib/observability/posthog'),
  capturePostHogEvent: jest.fn(),
}));

jest.mock('@/providers/app-providers', () => ({
  ...jest.requireActual('@/providers/app-providers'),
  resolveRepositoryBaseUrl: () => 'https://api.example.com',
}));

jest.mock('@/providers/auth-provider', () => ({
  ...jest.requireActual('@/providers/auth-provider'),
  useAuth: () => ({
    accessToken: 'token',
    currentUser: { id: 'user-me' },
    ensureGuestSession: jest.fn(),
    isGuest: false,
  }),
}));

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
      removeItem: jest.fn((key: string) => {
        store.delete(key);
        return Promise.resolve();
      }),
      clear: jest.fn(() => {
        store.clear();
        return Promise.resolve();
      }),
      getAllKeys: jest.fn(() => Promise.resolve([...store.keys()])),
      multiGet: jest.fn((keys: string[]) => Promise.resolve(keys.map((key) => [key, store.get(key) ?? null]))),
      multiSet: jest.fn((pairs: [string, string][]) => {
        pairs.forEach(([key, value]) => store.set(key, value));
        return Promise.resolve();
      }),
      multiRemove: jest.fn((keys: string[]) => {
        keys.forEach((key) => store.delete(key));
        return Promise.resolve();
      }),
    },
  };
});

const EVENT = makeEvent({ floorMapUrl: 'https://example.com/api/v1/events/hawaii-2026-10/map' });
const [A, B, C] = mockSpotlightEventMap.vendors;
const SEEN_KEY = '@spotlight/events/story-seen/anonymous';

function post(id: string, vendorId: string, minutesAgo: number, mediaCount = 1, authorId = 'user-2'): BoothPost {
  return {
    id,
    authorId,
    author: { displayName: null, handle: `${id}-author`, avatarUrl: null, isVerified: false },
    body: `Caption ${id}`,
    cardId: null,
    likeCount: 0,
    commentCount: 0,
    repostCount: 0,
    createdAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    media: Array.from({ length: mediaCount }, (_, index) => ({
      id: `${id}-m${index}`,
      width: 900,
      height: 1200,
      blurhash: null,
    })),
    boothVendorId: vendorId,
  };
}

// A: one two-image post. B: unseen. C: already watched, so it plays last.
const POSTS = [post('b1', B!.id, 2), post('a1', A!.id, 5, 2), post('c1', C!.id, 1)];
const CLAIMS: Map<string, BoothClaim> = new Map([
  [A!.id, { vendorId: A!.id, userId: 'holder-a', handle: 'holdera', claimedAt: new Date().toISOString() }],
]);

const frameId = (postId: string, index = 0) => `booth-story-frame-${postId}:${postId}-m${index}`;
const width = Dimensions.get('window').width;

function tap(x: number) {
  fireGestureHandler(getByGestureTestId('booth-story-tap'), [
    { state: State.BEGAN, x },
    { state: State.ACTIVE, x },
    { state: State.END, x },
  ]);
}

async function renderViewer(vendorId = A!.id) {
  const onClose = jest.fn();
  renderWithProviders(<BoothStoriesScreen eventId={EVENT.id} onClose={onClose} vendorId={vendorId} />, {
    spotlightRepository: createTestSpotlightRepository({
      fetchSpotlightEvents: async () => ({ items: [EVENT] }),
      fetchSpotlightEventMap: async () => mockSpotlightEventMap,
    }),
  });
  await screen.findByTestId(frameId('a1'));
  return onClose;
}

describe('BoothStoriesScreen', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    resetBoothStoriesForTests();
    await AsyncStorage.clear();
    await AsyncStorage.setItem(SEEN_KEY, JSON.stringify(['c1']));
    publishBoothStoriesSource(EVENT.id, { posts: POSTS, claims: CLAIMS });
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('opens on the tapped vendor with header, caption and one post_view per post', async () => {
    await renderViewer();
    expect(screen.getByTestId('booth-story-vendor').props.children).toBe(A!.name);
    expect(screen.getByTestId('booth-story-caption').props.children).toBe('Caption a1');
    expect(recordBoothEvent).toHaveBeenCalledTimes(1);
    expect(recordBoothEvent).toHaveBeenCalledWith(EVENT.id, A!.id, 'post_view');
    await waitFor(async () => expect(JSON.parse((await AsyncStorage.getItem(SEEN_KEY)) ?? '[]')).toContain('a1'));

    // The second image of the same post: still one view.
    tap(width - 1);
    expect(await screen.findByTestId(frameId('a1', 1))).toBeTruthy();
    expect(recordBoothEvent).toHaveBeenCalledTimes(1);
  });

  it('auto-advances every 5s, then on to the next vendor, unseen first, and closes after the last', async () => {
    jest.useFakeTimers();
    const onClose = await renderViewer();
    act(() => jest.advanceTimersByTime(STORY_FRAME_MS));
    expect(screen.getByTestId(frameId('a1', 1))).toBeTruthy();
    act(() => jest.advanceTimersByTime(STORY_FRAME_MS));
    expect(screen.getByTestId(frameId('b1'))).toBeTruthy();
    expect(screen.getByTestId('booth-story-vendor').props.children).toBe(B!.name);
    expect(capturePostHogEvent).toHaveBeenCalledWith('booth_story_completed', { event_id: EVENT.id, vendor_id: A!.id });
    act(() => jest.advanceTimersByTime(STORY_FRAME_MS));
    expect(screen.getByTestId(frameId('c1'))).toBeTruthy();
    act(() => jest.advanceTimersByTime(STORY_FRAME_MS));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('tap right = next, tap left = previous (back into the previous vendor)', async () => {
    await renderViewer();
    tap(width - 1);
    tap(width - 1);
    expect(await screen.findByTestId(frameId('b1'))).toBeTruthy();
    tap(1);
    expect(await screen.findByTestId(frameId('a1'))).toBeTruthy();
    tap(width - 1);
    expect(await screen.findByTestId(frameId('a1', 1))).toBeTruthy();
    tap(1);
    expect(await screen.findByTestId(frameId('a1'))).toBeTruthy();
  });

  it('long press pauses the timer', async () => {
    jest.useFakeTimers();
    await renderViewer();
    // fireGestureHandler always finishes a gesture, so hold and release through its handlers.
    const hold = getByGestureTestId('booth-story-hold') as unknown as {
      handlers: { onStart: (event: object) => void; onFinalize: (event: object, success: boolean) => void };
    };
    act(() => hold.handlers.onStart({}));
    act(() => jest.advanceTimersByTime(STORY_FRAME_MS * 2));
    expect(screen.getByTestId(frameId('a1'))).toBeTruthy();
    act(() => hold.handlers.onFinalize({}, true));
    act(() => jest.advanceTimersByTime(STORY_FRAME_MS));
    expect(screen.getByTestId(frameId('a1', 1))).toBeTruthy();
  });

  it('closes on X and on a swipe down', async () => {
    const onClose = await renderViewer();
    fireEvent.press(screen.getByTestId('booth-story-close'));
    expect(onClose).toHaveBeenCalledTimes(1);

    screen.unmount();
    const onSwipeClose = await renderViewer();
    fireGestureHandler(getByGestureTestId('booth-story-drag'), [
      { state: State.BEGAN, translationY: 0 },
      { state: State.ACTIVE, translationY: 80 },
      { state: State.END, translationY: 200, velocityY: 0 },
    ]);
    expect(onSwipeClose).toHaveBeenCalledTimes(1);
  });

  it('"View booth" closes and asks the show page to select the vendor', async () => {
    const listener = jest.fn();
    subscribeBoothVendorSelect(listener);
    const onClose = await renderViewer();
    fireEvent.press(screen.getByTestId('booth-story-view-booth'));
    expect(listener).toHaveBeenCalledWith(EVENT.id, A!.id);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('"Message" opens a DM with the booth holder', async () => {
    await renderViewer();
    await act(async () => fireEvent.press(screen.getByTestId('booth-story-message')));
    expect(recordBoothEvent).toHaveBeenCalledWith(EVENT.id, A!.id, 'message_start');
    expect(findOrCreateDm).toHaveBeenCalledWith('holder-a');
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/messages/[conversationId]',
      params: { conversationId: 'conv-1', name: '@holdera' },
    });
  });

  it('no Message on your own booth post, and own views are not counted', async () => {
    publishBoothStoriesSource(EVENT.id, { posts: [post('a1', A!.id, 5, 2, 'user-me')], claims: new Map() });
    await renderViewer();
    expect(screen.queryByTestId('booth-story-message')).toBeNull();
    expect(recordBoothEvent).not.toHaveBeenCalled();
  });
});
