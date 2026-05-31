import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  BackHandler,
  Dimensions,
  Image,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  FilterList,
  NavArrowLeft,
  Plus,
  Search as SearchIcon,
} from 'iconoir-react-native';
import { BlurView } from 'expo-blur';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import type { CatalogSearchResult } from '@spotlight/api-client';
import { colors, useSpotlightTheme } from '@spotlight/design-system';

import { matchConfidenceColor, matchPercentFromScore } from './change-card-picker-helpers';

type ChangeCardPickerProps = {
  visible: boolean;
  candidates: readonly CatalogSearchResult[];
  activeCandidateIndex: number;
  onClose: () => void;
  onSelectCandidate: (candidateIndex: number) => void;
  testID?: string;
};

const INITIAL_VISIBLE_COUNT = 3;
const LOAD_MORE_STEP = 3;
const DISMISS_DISTANCE = 70;
const DISMISS_VELOCITY = 0.25;
const SCREEN_HEIGHT = Dimensions.get('window').height;

export function ChangeCardPicker({
  visible,
  candidates,
  activeCandidateIndex,
  onClose,
  onSelectCandidate,
  testID = 'change-card-picker',
}: ChangeCardPickerProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_COUNT);
  const [pendingSelection, setPendingSelection] = useState<number | null>(null);
  const translateY = useRef(new Animated.Value(0)).current;
  const tiltX = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      setVisibleCount(INITIAL_VISIBLE_COUNT);
      setPendingSelection(activeCandidateIndex);
      translateY.setValue(0);
      tiltX.setValue(0);
    }
  }, [activeCandidateIndex, tiltX, translateY, visible]);

  const dismissWithAnimation = () => {
    Animated.timing(translateY, {
      toValue: SCREEN_HEIGHT,
      duration: 200,
      useNativeDriver: false,
    }).start(({ finished }) => {
      if (finished) {
        onClose();
      }
    });
  };

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_evt, gesture) => {
        return Math.abs(gesture.dy) > 4 && Math.abs(gesture.dy) > Math.abs(gesture.dx);
      },
      onPanResponderMove: (_evt, gesture) => {
        if (gesture.dy > 0) {
          translateY.setValue(gesture.dy);
        }
      },
      onPanResponderRelease: (_evt, gesture) => {
        if (gesture.dy > DISMISS_DISTANCE || gesture.vy > DISMISS_VELOCITY) {
          translateY.setValue(Math.max(gesture.dy, 0));
          dismissWithAnimation();
        } else {
          Animated.timing(translateY, {
            toValue: 0,
            duration: 160,
            useNativeDriver: false,
          }).start();
        }
      },
      onPanResponderTerminate: () => {
        Animated.timing(translateY, {
          toValue: 0,
          duration: 160,
          useNativeDriver: false,
        }).start();
      },
    }),
  ).current;

  const heroPan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_evt, gesture) => {
        return Math.abs(gesture.dx) > 4 && Math.abs(gesture.dx) > Math.abs(gesture.dy);
      },
      onPanResponderMove: (_evt, gesture) => {
        tiltX.setValue(Math.max(-140, Math.min(140, gesture.dx)));
      },
      onPanResponderRelease: () => {
        Animated.spring(tiltX, {
          toValue: 0,
          useNativeDriver: true,
          friction: 6,
          tension: 80,
        }).start();
      },
      onPanResponderTerminate: () => {
        Animated.spring(tiltX, {
          toValue: 0,
          useNativeDriver: true,
          friction: 6,
          tension: 80,
        }).start();
      },
    }),
  ).current;

  const selectedIndex = pendingSelection ?? activeCandidateIndex;
  const heroCandidate = candidates[selectedIndex] ?? candidates[0] ?? null;

  const visibleCandidates = useMemo(() => {
    return candidates.slice(0, Math.min(visibleCount, candidates.length));
  }, [candidates, visibleCount]);

  const canLoadMore = visibleCount < candidates.length;

  const handleSelect = (index: number) => {
    setPendingSelection(index);
    onSelectCandidate(index);
    onClose();
  };

  const handleLoadMore = () => {
    setVisibleCount((current) => Math.min(current + LOAD_MORE_STEP, candidates.length));
  };

  // Rendered as an in-tree overlay (not a Modal): an RN Modal presents in a
  // separate iOS window, so a BlurView inside it has nothing behind it to
  // blur and renders as a flat black panel. Sitting in the scanner's own view
  // tree lets the BlurView frost the live camera behind it (Figma 726:4379).
  useEffect(() => {
    if (!visible) {
      return undefined;
    }
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [visible, onClose]);

  if (!visible) {
    return null;
  }

  return (
    <View style={styles.root} testID={testID}>
      {/* Per Figma 726:4379 — the change-card layer is a transparent dark
          wash (rgba(0,0,0,0.3)) over an 8px blur of the live camera behind
          it, not an opaque scrim. expo-blur uses an intensity scale rather
          than px; 24 is the scanner's established ~8px-equivalent value and
          pairs with the same 0.3 overlay used by the tray backdrop. */}
      <BlurView
        intensity={24}
        pointerEvents="none"
        style={styles.backdropBlur}
        tint="dark"
      />
        <Pressable
          accessibilityLabel="Close change card picker"
          accessibilityRole="button"
          onPress={onClose}
          style={styles.backdrop}
          testID={`${testID}-backdrop`}
        />

        <SafeAreaView edges={['top']} style={styles.topBarSafe}>
          <View style={styles.topBar}>
            <Pressable
              accessibilityLabel="Close"
              accessibilityRole="button"
              hitSlop={8}
              onPress={onClose}
              style={styles.iconCircle}
              testID={`${testID}-back`}
            >
              <NavArrowLeft color={colors.gray0} height={18} width={18} strokeWidth={2} />
            </Pressable>
            <View style={styles.searchPill}>
              <SearchIcon color={colors.gray0} height={16} width={16} />
              <Text style={styles.searchPlaceholder} numberOfLines={1}>
                Search cards
              </Text>
            </View>
            <View style={styles.iconCircle}>
              <FilterList color={colors.gray0} height={16} width={16} />
            </View>
          </View>
        </SafeAreaView>

        <Animated.View
          pointerEvents="box-none"
          style={[styles.sheetWrap, { transform: [{ translateY }] }]}
        >
          <View style={styles.sheet}>
            <View
              {...panResponder.panHandlers}
              style={styles.dragRegion}
              testID={`${testID}-drag-region`}
            >
              <View style={styles.handle} />
              <Text style={[theme.typography.label, styles.title]}>Change card</Text>
            </View>

            <Animated.View
              {...heroPan.panHandlers}
              style={[
                styles.heroWrap,
                {
                  transform: [
                    { perspective: 800 },
                    {
                      rotateY: tiltX.interpolate({
                        inputRange: [-140, 140],
                        outputRange: ['-14deg', '14deg'],
                      }),
                    },
                    {
                      translateX: tiltX.interpolate({
                        inputRange: [-140, 140],
                        outputRange: [-10, 10],
                      }),
                    },
                  ],
                },
              ]}
            >
              {heroCandidate?.imageUrl ? (
                <Image
                  source={{ uri: heroCandidate.imageUrl }}
                  style={styles.heroImage}
                  resizeMode="contain"
                  testID={`${testID}-hero`}
                />
              ) : (
                <View style={[styles.heroImage, styles.heroPlaceholder]} />
              )}
            </Animated.View>

            <ScrollView
              contentContainerStyle={[
                styles.listContent,
                { paddingBottom: 16 + Math.max(insets.bottom, 0) },
              ]}
              showsVerticalScrollIndicator={false}
              testID={`${testID}-list`}
            >
              {visibleCandidates.map((candidate, index) => {
                const isSelected = index === selectedIndex;
                const meta = [candidate.cardNumber, candidate.setName].filter(Boolean).join(' · ');
                const matchPct = matchPercentFromScore(candidate.matchScore);
                return (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ selected: isSelected }}
                    key={candidate.id ?? candidate.cardId ?? index}
                    onPress={() => handleSelect(index)}
                    style={({ pressed }) => [
                      styles.cardRow,
                      isSelected ? styles.cardRowSelected : null,
                      pressed ? styles.cardRowPressed : null,
                    ]}
                    testID={`${testID}-row-${index}`}
                  >
                    <View style={styles.cardRowLeft}>
                      {candidate.imageUrl ? (
                        <Image
                          source={{ uri: candidate.imageUrl }}
                          style={styles.thumb}
                          resizeMode="cover"
                        />
                      ) : (
                        <View style={[styles.thumb, styles.thumbPlaceholder]} />
                      )}
                      <View style={styles.rowText}>
                        <Text
                          numberOfLines={1}
                          style={[styles.rowTitle, { color: colors.gray50 }]}
                        >
                          {candidate.name}
                        </Text>
                        {meta ? (
                          <Text
                            numberOfLines={1}
                            style={[styles.rowMeta, { color: colors.gray50 }]}
                          >
                            {meta}
                          </Text>
                        ) : null}
                        {matchPct != null ? (
                          <Text
                            numberOfLines={1}
                            style={[styles.rowMeta, { color: matchConfidenceColor(matchPct) }]}
                            testID={`${testID}-match-${index}`}
                          >
                            {`${matchPct}% Match`}
                          </Text>
                        ) : null}
                        {candidate.subtitle ? (
                          <Text
                            numberOfLines={1}
                            style={[styles.rowMeta, { color: colors.gray50 }]}
                          >
                            {candidate.subtitle}
                          </Text>
                        ) : null}
                      </View>
                    </View>
                    <View
                      style={[
                        styles.radio,
                        isSelected ? styles.radioSelected : null,
                      ]}
                    >
                      {isSelected ? <View style={styles.radioDot} /> : null}
                    </View>
                  </Pressable>
                );
              })}

              {canLoadMore ? (
                <Pressable
                  accessibilityRole="button"
                  hitSlop={6}
                  onPress={handleLoadMore}
                  style={({ pressed }) => [
                    styles.loadMoreRow,
                    pressed ? styles.loadMorePressed : null,
                  ]}
                  testID={`${testID}-load-more`}
                >
                  <Plus color={colors.brand} height={20} width={20} strokeWidth={2.4} />
                  <Text style={styles.loadMoreLabel}>Load more</Text>
                </Pressable>
              ) : null}
            </ScrollView>
          </View>
        </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
    elevation: 24,
    zIndex: 100,
  },
  backdropBlur: {
    ...StyleSheet.absoluteFillObject,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.3)',
  },
  topBarSafe: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
  },
  topBar: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 16,
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  iconCircle: {
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.35)',
    borderColor: 'rgba(255, 255, 255, 0.6)',
    borderRadius: 999,
    borderWidth: 1,
    height: 32,
    justifyContent: 'center',
    width: 32,
  },
  searchPill: {
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.35)',
    borderColor: colors.gray0,
    borderRadius: 999,
    borderWidth: 1,
    flex: 1,
    flexDirection: 'row',
    gap: 8,
    height: 32,
    paddingHorizontal: 12,
  },
  searchPlaceholder: {
    color: colors.gray0,
    fontFamily: 'SpotlightBodyMedium',
    fontSize: 13,
    lineHeight: 18.2,
  },
  sheetWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: '85%',
  },
  sheet: {
    backgroundColor: 'rgba(11, 11, 12, 0.96)',
    flex: 1,
    overflow: 'hidden',
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  dragRegion: {
    paddingBottom: 8,
    paddingTop: 4,
  },
  handle: {
    alignSelf: 'center',
    backgroundColor: colors.gray100,
    borderRadius: 2,
    height: 4,
    width: 40,
  },
  title: {
    color: colors.gray0,
    fontFamily: 'SpotlightBodySemiBold',
    marginTop: 12,
  },
  heroWrap: {
    alignSelf: 'center',
    marginTop: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.12,
    shadowRadius: 10,
    elevation: 8,
  },
  heroImage: {
    aspectRatio: 143 / 200,
    height: 200,
  },
  heroPlaceholder: {
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    borderRadius: 8,
  },
  listContent: {
    flexGrow: 1,
    gap: 12,
    justifyContent: 'flex-end',
    paddingTop: 24,
  },
  cardRow: {
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.25)',
    borderColor: 'transparent',
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  cardRowSelected: {
    borderColor: colors.brand,
  },
  cardRowPressed: {
    opacity: 0.88,
  },
  cardRowLeft: {
    alignItems: 'center',
    flex: 1,
    flexDirection: 'row',
    gap: 16,
  },
  thumb: {
    borderRadius: 4,
    height: 64,
    width: 46,
  },
  thumbPlaceholder: {
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
  },
  rowText: {
    flex: 1,
    gap: 2,
  },
  rowTitle: {
    fontFamily: 'SpotlightBodyBold',
    fontSize: 14,
    lineHeight: 21,
  },
  rowMeta: {
    fontFamily: 'SpotlightBodyMedium',
    fontSize: 12,
    lineHeight: 16.8,
  },
  radio: {
    alignItems: 'center',
    backgroundColor: colors.gray0,
    borderColor: colors.gray300,
    borderRadius: 999,
    borderWidth: 1,
    height: 16,
    justifyContent: 'center',
    width: 16,
  },
  radioSelected: {
    backgroundColor: colors.gray0,
    borderColor: colors.brand,
  },
  radioDot: {
    backgroundColor: colors.brand,
    borderRadius: 999,
    height: 10,
    width: 10,
  },
  loadMoreRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
    paddingVertical: 12,
  },
  loadMorePressed: {
    opacity: 0.7,
  },
  loadMoreLabel: {
    color: colors.brand,
    fontFamily: 'SpotlightBodySemiBold',
    fontSize: 13,
    lineHeight: 18.2,
  },
});

