import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  Easing,
  Modal,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, useSpotlightTheme } from '@spotlight/design-system';

// Sort keys for the Insights performance table (Figma 2179:16233 "Filter By").
export type InsightsSortKey =
  | 'default'
  | 'most-valuable'
  | 'least-valuable'
  | 'winners-today'
  | 'losers-today'
  | 'all-time-growth'
  | 'most-spent';

export const INSIGHTS_SORT_OPTIONS: { key: InsightsSortKey; label: string }[] = [
  { key: 'default', label: 'Default Order' },
  { key: 'most-valuable', label: 'Most Valuable' },
  { key: 'least-valuable', label: 'Least Valuable' },
  { key: 'winners-today', label: 'Biggest Winners Today' },
  { key: 'losers-today', label: 'Biggest Losers Today' },
  { key: 'all-time-growth', label: 'Best All-Time Growth' },
  { key: 'most-spent', label: 'Most Spent' },
];

type InsightsSortSheetProps = {
  visible: boolean;
  /** The committed sort — the draft resets to this each time the sheet opens. */
  sortKey: InsightsSortKey;
  onApply: (next: InsightsSortKey) => void;
  onClose: () => void;
  testID?: string;
};

const SCREEN_HEIGHT = Dimensions.get('window').height;

/**
 * "Filter By" sort sheet (Figma 2179:16233): handle + centered title, the sort
 * option list (selected row = purple/50 fill), then a dark Apply CTA over an
 * outline Cancel. Selection is a draft — only Apply commits it; Cancel and the
 * backdrop discard. Mirrors ConfirmDeleteSheet's slide/scrim so the app's
 * sheets feel like one system; the header is the drag-to-dismiss zone.
 */
export function InsightsSortSheet({
  visible,
  sortKey,
  onApply,
  onClose,
  testID = 'insights-sort-sheet',
}: InsightsSortSheetProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();

  const [draftKey, setDraftKey] = useState<InsightsSortKey>(sortKey);

  // Keep mounted through the closing slide-down, then unmount (matches the
  // delete/add sheets so the transition reads identically).
  const [isRendered, setIsRendered] = useState(visible);
  const translateY = useRef(new Animated.Value(SCREEN_HEIGHT)).current;

  useEffect(() => {
    if (visible) {
      setDraftKey(sortKey);
      setIsRendered(true);
      const animation = Animated.spring(translateY, {
        toValue: 0,
        damping: 34,
        mass: 1,
        stiffness: 320,
        useNativeDriver: false,
      });
      animation.start();
      return () => animation.stop();
    }

    const animation = Animated.timing(translateY, {
      toValue: SCREEN_HEIGHT,
      duration: 200,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: false,
    });
    animation.start(({ finished }) => {
      if (finished) {
        setIsRendered(false);
      }
    });
    return () => animation.stop();
  }, [sortKey, translateY, visible]);

  // Drag-to-dismiss on the header (handle + title): PanResponder runs on the JS
  // thread, so these writes are safe (no gesture-handler worklet hazard).
  const dragResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, gesture) =>
          gesture.dy > 4 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
        onPanResponderMove: (_event, gesture) => {
          translateY.setValue(Math.max(0, gesture.dy));
        },
        onPanResponderRelease: (_event, gesture) => {
          if (gesture.dy > 80 || gesture.vy > 0.5) {
            onClose();
            return;
          }
          Animated.spring(translateY, {
            toValue: 0,
            damping: 34,
            mass: 1,
            stiffness: 320,
            useNativeDriver: false,
          }).start();
        },
      }),
    [onClose, translateY],
  );

  if (!isRendered) {
    return null;
  }

  return (
    <Modal
      animationType="none"
      onRequestClose={onClose}
      presentationStyle="overFullScreen"
      statusBarTranslucent
      transparent
      visible
    >
      <View pointerEvents={visible ? 'auto' : 'none'} style={styles.root}>
        <Pressable
          accessibilityLabel="Close"
          accessibilityRole="button"
          onPress={onClose}
          style={styles.backdrop}
          testID={`${testID}-backdrop`}
        />
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
          <View style={styles.header} {...dragResponder.panHandlers}>
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
            <Text
              style={[theme.typography.bodyMedium, styles.title, { color: theme.colors.gray900 }]}
            >
              Filter By
            </Text>
          </View>

          <View style={styles.options}>
            {INSIGHTS_SORT_OPTIONS.map(({ key, label }) => {
              const selected = key === draftKey;
              return (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  key={key}
                  onPress={() => setDraftKey(key)}
                  style={[
                    styles.optionRow,
                    selected ? { backgroundColor: theme.colors.purple50 } : null,
                  ]}
                  testID={`${testID}-option-${key}`}
                >
                  <Text
                    style={[
                      theme.typography.body,
                      { color: selected ? theme.colors.gray900 : theme.colors.gray700 },
                    ]}
                  >
                    {label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <View style={styles.actions}>
            <Button
              label="Apply"
              labelStyleVariant="label"
              onPress={() => onApply(draftKey)}
              shape="rounded"
              size="md"
              testID={`${testID}-apply`}
              variant="dark"
            />
            <Button
              label="Cancel"
              labelStyleVariant="label"
              onPress={onClose}
              shape="rounded"
              size="md"
              testID={`${testID}-cancel`}
              variant="outline"
            />
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  actions: {
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 24,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
  },
  handleBar: {
    borderRadius: 2,
    height: 4,
    width: 36,
  },
  handleHit: {
    alignItems: 'center',
    paddingBottom: 6,
    paddingTop: 4,
  },
  header: {
    width: '100%',
  },
  optionRow: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    width: '100%',
  },
  options: {
    paddingTop: 16,
  },
  root: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: 0,
    borderTopRightRadius: 0,
    paddingTop: 10,
  },
  title: {
    paddingTop: 14,
    textAlign: 'center',
  },
});

export default InsightsSortSheet;
