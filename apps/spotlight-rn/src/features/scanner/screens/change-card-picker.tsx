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
import { NavArrowLeft, Search as SearchIcon } from 'iconoir-react-native';
import { BlurView } from 'expo-blur';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import type { CatalogSearchResult } from '@spotlight/api-client';
import { colors } from '@spotlight/design-system';

import {
  matchConfidenceColor,
  matchPercentFromScore,
  matchPillColors,
} from './change-card-picker-helpers';

type ChangeCardPickerProps = {
  visible: boolean;
  candidates: readonly CatalogSearchResult[];
  activeCandidateIndex: number;
  /** Local URI of the photo the user captured for this scan, shown beside the match. */
  capturedImageUri?: string | null;
  onClose: () => void;
  onSelectCandidate: (candidateIndex: number) => void;
  testID?: string;
};

const INITIAL_VISIBLE_COUNT = 10;
const LOAD_MORE_STEP = 10;
const DISMISS_DISTANCE = 70;
const DISMISS_VELOCITY = 0.25;
const SCREEN_HEIGHT = Dimensions.get('window').height;
const HERO_IMAGE_HEIGHT = 200;

export function ChangeCardPicker({
  visible,
  candidates,
  activeCandidateIndex,
  capturedImageUri,
  onClose,
  onSelectCandidate,
  testID = 'change-card-picker',
}: ChangeCardPickerProps) {
  const insets = useSafeAreaInsets();
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_COUNT);
  const [pendingSelection, setPendingSelection] = useState<number | null>(null);
  const translateY = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      setVisibleCount(INITIAL_VISIBLE_COUNT);
      setPendingSelection(activeCandidateIndex);
      translateY.setValue(0);
    }
  }, [activeCandidateIndex, translateY, visible]);

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
      // Claim the touch only once it becomes a real downward drag — leaving
      // taps to pass through to the handle Pressable (tap-to-collapse).
      onStartShouldSetPanResponder: () => false,
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

  const selectedIndex = pendingSelection ?? activeCandidateIndex;
  const heroCandidate = candidates[selectedIndex] ?? candidates[0] ?? null;
  const heroMatchPct = matchPercentFromScore(heroCandidate?.matchScore);

  const visibleCandidates = useMemo(() => {
    return candidates.slice(0, Math.min(visibleCount, candidates.length));
  }, [candidates, visibleCount]);

  const canLoadMore = visibleCount < candidates.length;

  const handleSelect = (index: number) => {
    setPendingSelection(index);
    onSelectCandidate(index);
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
            <View style={styles.iconCircle}>
              <SearchIcon color={colors.gray0} height={16} width={16} />
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
              <Pressable
                accessibilityLabel="Collapse"
                accessibilityRole="button"
                hitSlop={12}
                onPress={dismissWithAnimation}
                style={styles.handle}
              />
              <View style={styles.infoHeader}>
                <View style={styles.infoPill}>
                  <Text style={styles.infoPillText}>SWITCH</Text>
                </View>
                <View style={styles.infoPill}>
                  <Text style={styles.infoPillText}>{`${candidates.length} SIMILAR`}</Text>
                </View>
              </View>
            </View>

            <View style={styles.heroBox}>
              <View style={styles.heroRow}>
                {capturedImageUri ? (
                  <View style={styles.heroColumn}>
                    <Image
                      source={{ uri: capturedImageUri }}
                      style={styles.heroImage}
                      resizeMode="cover"
                      testID={`${testID}-capture`}
                    />
                    <Text style={styles.heroCaption}>Your Photo</Text>
                  </View>
                ) : null}

                <View style={styles.heroColumn}>
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
                  {heroMatchPct != null ? (
                    <Text
                      style={[styles.heroCaption, { color: matchConfidenceColor(heroMatchPct) }]}
                    >
                      {`${heroMatchPct}% Match`}
                    </Text>
                  ) : null}
                </View>
              </View>
            </View>

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
                const pillColors = matchPct != null ? matchPillColors(matchPct) : null;
                return (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ selected: isSelected }}
                    key={candidate.id ?? candidate.cardId ?? index}
                    onPress={() => handleSelect(index)}
                    style={({ pressed }) => [
                      styles.cardRow,
                      isSelected ? styles.cardRowSelected : styles.cardRowUnselected,
                      pressed ? styles.cardRowPressed : null,
                    ]}
                    testID={`${testID}-row-${index}`}
                  >
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
                      <Text numberOfLines={1} style={styles.rowTitle}>
                        {candidate.name}
                      </Text>
                      {meta ? (
                        <Text numberOfLines={1} style={styles.rowMeta}>
                          {meta}
                        </Text>
                      ) : null}
                      {pillColors ? (
                        <View
                          style={[styles.matchChip, { backgroundColor: pillColors.backgroundColor }]}
                        >
                          <Text
                            style={[styles.matchChipText, { color: pillColors.color }]}
                            testID={`${testID}-match-${index}`}
                          >
                            {`${matchPct}% Match`}
                          </Text>
                        </View>
                      ) : null}
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
                    styles.loadMoreButton,
                    pressed ? styles.loadMorePressed : null,
                  ]}
                  testID={`${testID}-load-more`}
                >
                  <Text style={styles.loadMoreLabel}>LOAD MORE</Text>
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
    justifyContent: 'space-between',
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
  sheetWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: '85%',
  },
  sheet: {
    backgroundColor: 'rgba(0, 0, 0, 0.65)',
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
  infoHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 12,
  },
  infoPill: {
    backgroundColor: colors.gray900,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  infoPillText: {
    color: colors.gray400,
    fontFamily: 'SpotlightBodySemiBold',
    fontSize: 13,
    lineHeight: 18.2,
  },
  heroBox: {
    backgroundColor: 'rgba(243, 235, 255, 0.15)',
    borderColor: colors.purple300,
    borderRadius: 8,
    borderWidth: 1.5,
    marginTop: 16,
    padding: 16,
  },
  heroRow: {
    flexDirection: 'row',
    gap: 16,
  },
  heroColumn: {
    flex: 1,
    gap: 8,
  },
  heroCaption: {
    color: colors.gray0,
    fontFamily: 'SpotlightBodySemiBold',
    fontSize: 13,
  },
  heroImage: {
    borderRadius: 8,
    height: HERO_IMAGE_HEIGHT,
    width: '100%',
  },
  heroPlaceholder: {
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
  },
  listContent: {
    flexGrow: 1,
    gap: 12,
    paddingTop: 24,
  },
  cardRow: {
    alignItems: 'center',
    borderRadius: 8,
    flexDirection: 'row',
    gap: 12,
    padding: 12,
  },
  cardRowSelected: {
    borderColor: colors.purple300,
    borderWidth: 1.5,
  },
  cardRowUnselected: {
    borderColor: 'rgba(255, 255, 255, 0.2)',
    borderWidth: 1,
  },
  cardRowPressed: {
    opacity: 0.88,
  },
  thumb: {
    borderRadius: 3,
    height: 80,
    width: 58,
  },
  thumbPlaceholder: {
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
  },
  rowText: {
    flex: 1,
    gap: 4,
  },
  rowTitle: {
    color: colors.gray0,
    fontFamily: 'SpotlightBodySemiBold',
    fontSize: 16,
    lineHeight: 21.6,
  },
  rowMeta: {
    color: colors.gray400,
    fontFamily: 'SpotlightBodyMedium',
    fontSize: 13,
    lineHeight: 18.2,
  },
  matchChip: {
    alignSelf: 'flex-start',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  matchChipText: {
    fontFamily: 'SpotlightBodyBold',
    fontSize: 11,
    lineHeight: 14.3,
  },
  loadMoreButton: {
    alignSelf: 'center',
    borderColor: colors.purple300,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 5,
  },
  loadMorePressed: {
    opacity: 0.7,
  },
  loadMoreLabel: {
    color: colors.purple300,
    fontFamily: 'SpotlightBodyMedium',
    fontSize: 13,
    lineHeight: 18.2,
  },
});
