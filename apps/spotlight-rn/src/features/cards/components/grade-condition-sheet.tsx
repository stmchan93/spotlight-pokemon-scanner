import { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  Easing,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useSpotlightTheme } from '@spotlight/design-system';

export type GradeConditionOption = {
  id: string;
  label: string;
};

type GradeConditionSheetProps = {
  visible: boolean;
  /** Section title, e.g. "Grade". */
  title: string;
  options: GradeConditionOption[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
  testID?: string;
};

const SCREEN_HEIGHT = Dimensions.get('window').height;

/**
 * Bottom-sheet picker for the card-detail grade (graded lane) / condition (raw
 * lane) selection — Figma 1185:1808 / 1185:2471. It opens like the scanner
 * tray: the dark scrim cuts in instantly (no fade) while only the sheet panel
 * slides up from the bottom; closing reverses the slide and then unmounts.
 */
export function GradeConditionSheet({
  visible,
  title,
  options,
  selectedId,
  onSelect,
  onClose,
  testID = 'grade-condition-sheet',
}: GradeConditionSheetProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();

  // Keep the modal mounted through the closing slide-down, then unmount.
  const [isRendered, setIsRendered] = useState(visible);
  const translateY = useRef(new Animated.Value(SCREEN_HEIGHT)).current;

  useEffect(() => {
    if (visible) {
      setIsRendered(true);
      // Scrim is already at full opacity (rendered instantly); slide the panel
      // up with a near-critically-damped spring so it pops in without bounce.
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
  }, [translateY, visible]);

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
      <View style={styles.root}>
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
          <View style={[styles.handle, { backgroundColor: theme.colors.gray200 }]} />
          <Text style={[theme.typography.titleSmall, styles.title, { color: theme.colors.gray900 }]}>
            {title}
          </Text>
          <ScrollView
            contentContainerStyle={styles.listContent}
            showsVerticalScrollIndicator
            style={styles.list}
            testID={`${testID}-list`}
          >
            {options.map((option) => {
              const selected = option.id === selectedId;
              return (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  key={option.id}
                  onPress={() => {
                    onSelect(option.id);
                    onClose();
                  }}
                  // Selected = full-width pale-purple band (Figma 1664:2597); dark
                  // text either way, no checkmark — the fill alone marks selection.
                  style={({ pressed }) => [
                    styles.row,
                    selected && { backgroundColor: theme.colors.purple50 },
                    { opacity: pressed ? 0.7 : 1 },
                  ]}
                  testID={`${testID}-option-${option.id}`}
                >
                  <Text style={[theme.typography.body, { color: theme.colors.gray900 }]}>
                    {option.label}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    // Instant flat scrim — #000000 at 40% (no fade curve), matching the
    // scanner tray's pop-open feel.
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
  },
  sheet: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    maxHeight: '70%',
    paddingTop: 10,
  },
  handle: {
    alignSelf: 'center',
    borderRadius: 2,
    height: 4,
    width: 36,
  },
  title: {
    paddingBottom: 4,
    paddingHorizontal: 16,
    paddingTop: 18,
  },
  list: {
    flexGrow: 0,
  },
  listContent: {
    paddingVertical: 8,
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
});

export default GradeConditionSheet;
