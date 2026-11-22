import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Dimensions,
  Easing,
  FlatList,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { radii, Text, useSpotlightTheme } from '@spotlight/design-system';

import type { UserProfile } from '@/features/auth/auth-models';
import { ProfileListRow } from '@/features/profile/components/profile-list-row';
import { fetchPostLikers } from '@/features/profile/profile-service';

const SCREEN_HEIGHT = Dimensions.get('window').height;
// The list scrolls inside the sheet instead of the sheet growing past the screen.
const LIST_MAX_HEIGHT = Math.round(SCREEN_HEIGHT * 0.55);

/**
 * "Likes": who liked a post, in a slide-up sheet with a scrolling list (the
 * Share sheet's shell). Rendered in-tree inside the caller's Modal, like
 * SharePostSheet; `onExited` fires once the closing slide is done.
 */
export function LikesSheet({
  postId,
  visible,
  onClose,
  onExited,
  onOpenProfile,
  testID = 'likes-sheet',
}: {
  postId: string;
  visible: boolean;
  onClose: () => void;
  onExited?: () => void;
  onOpenProfile: (profile: UserProfile) => void;
  testID?: string;
}) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const [profiles, setProfiles] = useState<UserProfile[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRendered, setIsRendered] = useState(visible);
  const translateY = useRef(new Animated.Value(SCREEN_HEIGHT)).current;
  const backdropOpacity = translateY.interpolate({
    inputRange: [0, SCREEN_HEIGHT],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  });
  const onExitedRef = useRef(onExited);
  onExitedRef.current = onExited;

  useEffect(() => {
    if (visible) {
      setIsRendered(true);
      const animation = Animated.spring(translateY, {
        toValue: 0,
        damping: 34,
        mass: 1,
        stiffness: 320,
        useNativeDriver: true,
      });
      animation.start();
      return () => animation.stop();
    }
    const animation = Animated.timing(translateY, {
      toValue: SCREEN_HEIGHT,
      duration: 200,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (finished) {
        setIsRendered(false);
        onExitedRef.current?.();
      }
    });
    return () => animation.stop();
  }, [translateY, visible]);

  useEffect(() => {
    if (!visible) {
      return undefined;
    }
    let cancelled = false;
    setIsLoading(true);
    void fetchPostLikers(postId).then((rows) => {
      if (!cancelled) {
        setProfiles(rows);
        setIsLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [postId, visible]);

  if (!isRendered) {
    return null;
  }

  return (
    <View pointerEvents={visible ? 'auto' : 'none'} style={styles.root}>
      <Animated.View style={[styles.backdrop, { opacity: backdropOpacity }]}>
        <Pressable
          accessibilityLabel="Close"
          accessibilityRole="button"
          onPress={onClose}
          style={styles.backdropHit}
          testID={`${testID}-backdrop`}
        />
      </Animated.View>
      <Animated.View
        style={[
          styles.sheet,
          {
            backgroundColor: theme.colors.gray0,
            paddingBottom: Math.max(insets.bottom, 16) + 8,
            transform: [{ translateY }],
          },
        ]}
        testID={testID}
      >
        <Pressable
          accessibilityLabel="Close"
          accessibilityRole="button"
          hitSlop={16}
          onPress={onClose}
          style={styles.handleHit}
          testID={`${testID}-handle`}
        >
          <View style={[styles.handleBar, { backgroundColor: theme.colors.gray200 }]} />
        </Pressable>
        <Text style={[theme.typography.bodyMedium, styles.title, { color: theme.colors.gray900 }]}>Likes</Text>
        {isLoading ? (
          <ActivityIndicator style={styles.loading} testID={`${testID}-loading`} />
        ) : (
          <FlatList
            data={profiles}
            keyExtractor={(item) => item.userID}
            ListEmptyComponent={
              <Text
                style={[theme.typography.label, styles.empty, { color: theme.colors.gray600 }]}
                testID={`${testID}-empty`}
              >
                No likes yet.
              </Text>
            }
            renderItem={({ item }) => (
              <ProfileListRow onPress={onOpenProfile} profile={item} testID={`${testID}-row-${item.userID}`} />
            )}
            style={styles.list}
          />
        )}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
  },
  backdropHit: {
    flex: 1,
  },
  empty: {
    paddingVertical: 24,
    textAlign: 'center',
  },
  handleBar: {
    borderCurve: 'continuous',
    borderRadius: 2,
    height: 4,
    width: 36,
  },
  handleHit: {
    alignItems: 'center',
    paddingBottom: 6,
    paddingTop: 4,
  },
  list: {
    flexGrow: 0,
    maxHeight: LIST_MAX_HEIGHT,
  },
  loading: {
    paddingVertical: 24,
  },
  root: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
    zIndex: 1,
  },
  sheet: {
    borderCurve: 'continuous',
    borderTopLeftRadius: radii.sheet,
    borderTopRightRadius: radii.sheet,
    overflow: 'hidden',
    paddingTop: 10,
  },
  title: {
    paddingBottom: 8,
    paddingTop: 14,
    textAlign: 'center',
  },
});
