import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image as ExpoImage } from 'expo-image';
import { useFocusEffect } from 'expo-router';
import { Xmark } from 'iconoir-react-native';

import { Button, layout, radii, spacing, Text, useSpotlightTheme } from '@spotlight/design-system';

import { useGuestGate } from '@/features/auth/use-guest-gate';
import { formatBoothPostAge } from '@/features/events/booth-format';
import { fetchBoothClaims, fetchBoothPosts, recordBoothEvent } from '@/features/events/booth-service';
import {
  boothStoryQueue,
  buildBoothStories,
  firstUnseenFrameIndex,
  orderBoothStories,
  type BoothStory,
} from '@/features/events/booth-stories';
import {
  readBoothStoriesSource,
  requestBoothVendorSelect,
  useSeenBoothPosts,
  type BoothStoriesSource,
} from '@/features/events/booth-stories-store';
import { useBoothMessage } from '@/features/events/components/booth-vendor-panel';
import { VendorLogo } from '@/features/events/components/vendor-logo';
import { vendorTableLabel } from '@/features/events/event-floor-map-model';
import { useSpotlightEventMap } from '@/features/events/hooks/use-spotlight-event-map';
import { useSpotlightEvent } from '@/features/events/hooks/use-spotlight-events';
import { PostImage, postMediaUrl } from '@/features/social/components/post-card';
import { AnalyticsEvent } from '@/lib/observability/analytics-events';
import { capturePostHogEvent } from '@/lib/observability/posthog';
import { resolveRepositoryBaseUrl } from '@/providers/app-providers';
import { useAuth } from '@/providers/auth-provider';

export const STORY_FRAME_MS = 5_000;
const LOGO_SIZE = 32;
const CLOSE_ICON_SIZE = 24;
const PROGRESS_HEIGHT = 3;
const LONG_PRESS_MS = 250;
/** A swipe down this far, or this fast, closes the viewer. */
const DISMISS_DISTANCE = 120;
const DISMISS_VELOCITY = 800;
/** Post images are 3:4. */
const FRAME_ASPECT = 4 / 3;
const CAPTION_LINES = 3;

type BoothStoriesScreenProps = {
  eventId: string;
  /** The vendor tapped; the rest follow, unseen first. */
  vendorId: string;
  onClose: () => void;
};

type Position = { vendor: number; frame: number; /** Bumped to restart the same frame. */ nonce: number };

/** What the show page already loaded; fetched once only when opened cold (a restored route). */
function useStoriesSource(eventId: string, vendorIds: readonly string[] | null): BoothStoriesSource | null {
  const [source, setSource] = useState(() => readBoothStoriesSource(eventId));
  const vendorKey = vendorIds?.join('|') ?? '';
  useEffect(() => {
    if (source || !vendorKey) {
      return undefined;
    }
    let active = true;
    void Promise.all([fetchBoothPosts(eventId), fetchBoothClaims(vendorKey.split('|'))]).then(([posts, claims]) => {
      if (active) {
        setSource({ posts, claims: claims ?? new Map() });
      }
    });
    return () => {
      active = false;
    };
  }, [eventId, source, vendorKey]);
  return source;
}

export function BoothStoriesScreen({ eventId, vendorId, onClose }: BoothStoriesScreenProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { accessToken, currentUser } = useAuth();
  const myUserId = currentUser?.id ?? null;
  const apiBaseUrl = resolveRepositoryBaseUrl();
  const { gate } = useGuestGate();
  const { event } = useSpotlightEvent(eventId);
  const { map } = useSpotlightEventMap(event?.floorMapUrl ?? null);
  const vendorIds = useMemo(() => map?.vendors.map((vendor) => vendor.id) ?? null, [map]);
  const source = useStoriesSource(eventId, vendorIds);
  const { seenPostIds, ready: seenReady, markSeen } = useSeenBoothPosts();

  const vendorsById = useMemo(() => new Map((map?.vendors ?? []).map((vendor) => [vendor.id, vendor])), [map]);
  const stories = useMemo(
    () => (source && vendorIds ? buildBoothStories(source.posts, new Set(vendorIds)) : null),
    [source, vendorIds],
  );
  const storiesById = useMemo(() => new Map((stories ?? []).map((story) => [story.vendorId, story])), [stories]);

  // The play order is fixed when the viewer opens, so marking frames seen doesn't reshuffle it.
  const [queue, setQueue] = useState<string[] | null>(null);
  const [position, setPositionState] = useState<Position>({ vendor: 0, frame: 0, nonce: 0 });
  // Taps can land twice before a render; moves read the latest position, not the rendered one.
  const positionRef = useRef(position);
  const setPosition = useCallback((next: Position) => {
    positionRef.current = next;
    setPositionState(next);
  }, []);
  useEffect(() => {
    if (queue || !stories || !seenReady) {
      return;
    }
    const next = boothStoryQueue(orderBoothStories(stories, seenPostIds), vendorId);
    const first = next[0] ? storiesById.get(next[0]) : undefined;
    setQueue(next);
    setPosition({ vendor: 0, frame: first ? firstUnseenFrameIndex(first, seenPostIds) : 0, nonce: 0 });
  }, [queue, seenPostIds, seenReady, setPosition, stories, storiesById, vendorId]);

  const closed = useRef(false);
  const close = useCallback(() => {
    if (!closed.current) {
      closed.current = true;
      onClose();
    }
  }, [onClose]);

  const story: BoothStory | undefined = queue ? storiesById.get(queue[position.vendor] ?? '') : undefined;
  const frame = story?.frames[position.frame];
  const vendor = story ? vendorsById.get(story.vendorId) : undefined;

  // Nothing to show once everything has loaded: leave rather than sit on a black screen.
  useEffect(() => {
    if (queue && !frame) {
      close();
    }
  }, [close, frame, queue]);

  const goNext = useCallback(() => {
    const current = positionRef.current;
    const currentStory = queue ? storiesById.get(queue[current.vendor] ?? '') : undefined;
    if (!queue || !currentStory) {
      return;
    }
    if (current.frame + 1 < currentStory.frames.length) {
      setPosition({ ...current, frame: current.frame + 1 });
      return;
    }
    capturePostHogEvent(AnalyticsEvent.boothStoryCompleted, { event_id: eventId, vendor_id: currentStory.vendorId });
    const nextStory = storiesById.get(queue[current.vendor + 1] ?? '');
    if (!nextStory) {
      close();
      return;
    }
    setPosition({
      vendor: current.vendor + 1,
      frame: firstUnseenFrameIndex(nextStory, seenPostIds),
      nonce: current.nonce + 1,
    });
  }, [close, eventId, queue, seenPostIds, setPosition, storiesById]);

  const goPrevious = useCallback(() => {
    const current = positionRef.current;
    setPosition(
      current.frame > 0
        ? { ...current, frame: current.frame - 1 }
        : current.vendor > 0
          ? { vendor: current.vendor - 1, frame: 0, nonce: current.nonce + 1 }
          : { ...current, nonce: current.nonce + 1 },
    );
  }, [setPosition]);

  // Seen and one post_view per post, as each frame shows. The owner's own looks don't count.
  const viewedPosts = useRef(new Set<string>());
  useEffect(() => {
    if (!frame) {
      return;
    }
    markSeen(frame.post.id);
    if (!viewedPosts.current.has(frame.post.id)) {
      viewedPosts.current.add(frame.post.id);
      if (frame.post.authorId !== myUserId) {
        recordBoothEvent(eventId, frame.post.boothVendorId, 'post_view');
      }
    }
  }, [eventId, frame, markSeen, myUserId]);

  const imageUrl = useCallback(
    (mediaId: string) => (apiBaseUrl ? postMediaUrl(apiBaseUrl, mediaId, { displayWidth: width }) : ''),
    [apiBaseUrl, width],
  );

  // The next image starts downloading while this one plays.
  const upcoming =
    story?.frames[position.frame + 1] ??
    (queue ? storiesById.get(queue[position.vendor + 1] ?? '')?.frames[0] : undefined);
  const upcomingUrl = upcoming ? imageUrl(upcoming.media.id) : '';
  useEffect(() => {
    if (upcomingUrl && accessToken) {
      void ExpoImage.prefetch(upcomingUrl, {
        cachePolicy: 'memory-disk',
        headers: { Authorization: `Bearer ${accessToken}` },
      }).catch(() => false);
    }
  }, [accessToken, upcomingUrl]);

  // Auto-advance. Pausing (long press, drag, another screen on top) keeps the time already played.
  const [held, setHeld] = useState(false);
  const [blurred, setBlurred] = useState(false);
  useFocusEffect(
    useCallback(() => {
      setBlurred(false);
      return () => setBlurred(true);
    }, []),
  );
  const paused = held || blurred;
  const frameKey = frame ? `${position.vendor}:${position.frame}:${position.nonce}` : null;
  const progress = useSharedValue(0);
  const elapsed = useRef(0);
  const goNextRef = useRef(goNext);
  goNextRef.current = goNext;
  useEffect(() => {
    elapsed.current = 0;
    progress.value = 0;
  }, [frameKey, progress]);
  useEffect(() => {
    if (!frameKey || paused) {
      return undefined;
    }
    const remaining = Math.max(0, STORY_FRAME_MS - elapsed.current);
    const startedAt = Date.now();
    progress.value = withTiming(1, { duration: remaining, easing: Easing.linear });
    const timer = setTimeout(() => goNextRef.current(), remaining);
    return () => {
      clearTimeout(timer);
      elapsed.current += Date.now() - startedAt;
      cancelAnimation(progress);
    };
  }, [frameKey, paused, progress]);

  // Gestures: tap left third = back, elsewhere = next; hold = pause; drag down = close.
  const dragY = useSharedValue(0);
  const tapAt = useCallback((x: number) => (x < width / 3 ? goPrevious() : goNextRef.current()), [goPrevious, width]);
  const gesture = useMemo(() => {
    const tap = Gesture.Tap()
      .withTestId('booth-story-tap')
      .onEnd((tapEvent, success) => {
        if (success) {
          runOnJS(tapAt)(tapEvent.x);
        }
      });
    const hold = Gesture.LongPress()
      .withTestId('booth-story-hold')
      .minDuration(LONG_PRESS_MS)
      .onStart(() => {
        runOnJS(setHeld)(true);
      })
      .onFinalize(() => {
        runOnJS(setHeld)(false);
      });
    const drag = Gesture.Pan()
      .withTestId('booth-story-drag')
      .activeOffsetY(spacing.sm)
      .failOffsetX([-spacing.md, spacing.md])
      .onStart(() => {
        runOnJS(setHeld)(true);
      })
      .onUpdate((panEvent) => {
        dragY.value = Math.max(0, panEvent.translationY);
      })
      .onEnd((panEvent) => {
        if (panEvent.translationY > DISMISS_DISTANCE || panEvent.velocityY > DISMISS_VELOCITY) {
          runOnJS(close)();
        } else {
          dragY.value = withSpring(0);
          runOnJS(setHeld)(false);
        }
      });
    return Gesture.Race(drag, Gesture.Exclusive(hold, tap));
  }, [close, dragY, tapAt]);

  const dragStyle = useAnimatedStyle(() => ({
    opacity: 1 - Math.min(dragY.value / (DISMISS_DISTANCE * 3), 0.5),
    transform: [{ translateY: dragY.value }],
  }));
  const progressStyle = useAnimatedStyle(() => ({ width: `${progress.value * 100}%` }));

  // Message whoever holds the booth (else the post's author), never yourself.
  const claim = story ? source?.claims.get(story.vendorId) : undefined;
  const messageTarget = claim
    ? { userId: claim.userId, handle: claim.handle }
    : frame
      ? { userId: frame.post.authorId, handle: frame.post.author?.handle ?? null }
      : null;
  const startMessage = useBoothMessage(eventId, vendor ?? { id: story?.vendorId ?? '', name: '' });
  const canMessage = messageTarget != null && messageTarget.userId !== myUserId;

  const viewBooth = useCallback(() => {
    if (story) {
      requestBoothVendorSelect(eventId, story.vendorId);
    }
    close();
  }, [close, eventId, story]);

  const frameHeight = width * FRAME_ASPECT;
  const chromeColor = theme.colors.gray0;

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.gray900 }]} testID="booth-stories">
      <Animated.View style={[styles.root, dragStyle]}>
        <GestureDetector gesture={gesture}>
          <View
            accessibilityActions={[
              { name: 'increment', label: 'Next photo' },
              { name: 'decrement', label: 'Previous photo' },
            ]}
            accessibilityLabel={vendor && story ? `${vendor.name}, photo ${position.frame + 1} of ${story.frames.length}` : undefined}
            accessibilityRole="adjustable"
            accessible
            onAccessibilityAction={({ nativeEvent }) =>
              nativeEvent.actionName === 'increment' ? goNextRef.current() : goPrevious()
            }
            style={styles.stage}
            testID="booth-story-stage"
          >
            {frame && accessToken && apiBaseUrl ? (
              <PostImage
                accessToken={accessToken}
                key={frame.key}
                media={frame.media}
                style={{ height: frameHeight, width }}
                testID={`booth-story-frame-${frame.key}`}
                uri={imageUrl(frame.media.id)}
                viewerIsAuthor={frame.post.authorId === myUserId}
              />
            ) : null}
          </View>
        </GestureDetector>

        {story && frame && vendor ? (
          <>
            <View pointerEvents="box-none" style={[styles.header, { paddingTop: insets.top + spacing.xxs }]}>
              <View style={styles.progressRow}>
                {story.frames.map((item, index) => (
                  <View key={item.key} style={[styles.progressTrack, { backgroundColor: theme.colors.gray600 }]}>
                    {index < position.frame ? (
                      <View style={[styles.progressFull, { backgroundColor: chromeColor }]} />
                    ) : index === position.frame ? (
                      <Animated.View
                        style={[styles.progressFill, { backgroundColor: chromeColor }, progressStyle]}
                        testID="booth-story-progress-current"
                      />
                    ) : null}
                  </View>
                ))}
              </View>
              <View style={styles.headerRow}>
                <VendorLogo size={LOGO_SIZE} vendor={vendor} />
                <View style={styles.headerText}>
                  <Text
                    numberOfLines={1}
                    style={[theme.typography.label, { color: chromeColor }]}
                    testID="booth-story-vendor"
                  >
                    {vendor.name}
                  </Text>
                  <Text numberOfLines={1} style={[theme.typography.caption, { color: theme.colors.gray300 }]}>
                    {[vendorTableLabel(vendor.location), formatBoothPostAge(frame.post.createdAt)]
                      .filter(Boolean)
                      .join(' · ')}
                  </Text>
                </View>
                <Pressable
                  accessibilityLabel="Close stories"
                  accessibilityRole="button"
                  hitSlop={spacing.xs}
                  onPress={close}
                  testID="booth-story-close"
                >
                  <Xmark color={chromeColor} height={CLOSE_ICON_SIZE} width={CLOSE_ICON_SIZE} />
                </Pressable>
              </View>
            </View>

            <View
              pointerEvents="box-none"
              style={[styles.footer, { paddingBottom: Math.max(insets.bottom, spacing.sm) }]}
            >
              {frame.post.body ? (
                <Text
                  numberOfLines={CAPTION_LINES}
                  style={[theme.typography.body, { color: chromeColor }]}
                  testID="booth-story-caption"
                >
                  {frame.post.body}
                </Text>
              ) : null}
              <View style={styles.actions}>
                <Button
                  label="View booth"
                  labelStyleVariant="label"
                  onPress={viewBooth}
                  shape="rounded"
                  size="xs"
                  style={styles.action}
                  testID="booth-story-view-booth"
                  variant="secondary"
                />
                {canMessage && messageTarget ? (
                  <Button
                    label="Message"
                    labelStyleVariant="label"
                    onPress={gate(() => startMessage(messageTarget.userId, messageTarget.handle))}
                    shape="rounded"
                    size="xs"
                    style={styles.action}
                    testID="booth-story-message"
                    variant="primary"
                  />
                ) : null}
              </View>
            </View>
          </>
        ) : null}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  stage: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  header: {
    gap: spacing.xs,
    left: 0,
    paddingHorizontal: layout.pageGutter,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  progressRow: {
    flexDirection: 'row',
    gap: spacing.xxxs,
  },
  progressTrack: {
    borderCurve: 'continuous',
    borderRadius: radii.pill,
    flex: 1,
    height: PROGRESS_HEIGHT,
    overflow: 'hidden',
  },
  progressFull: {
    ...StyleSheet.absoluteFillObject,
  },
  progressFill: {
    height: PROGRESS_HEIGHT,
  },
  headerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xxs,
  },
  headerText: {
    flex: 1,
    gap: spacing.xxxs,
  },
  footer: {
    bottom: 0,
    gap: spacing.xs,
    left: 0,
    paddingHorizontal: layout.pageGutter,
    position: 'absolute',
    right: 0,
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.xxs,
  },
  action: {
    flex: 1,
  },
});
