import { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  Easing,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Minus, NavArrowDown, Plus } from 'iconoir-react-native';

import { Button, useSpotlightTheme } from '@spotlight/design-system';

type AddToCollectionSheetProps = {
  visible: boolean;
  onClose: () => void;
  /** Sheet heading — "Add to Collection" (add) or "Edit details" (owned line). */
  title?: string;
  /** Section title for the grade selector (e.g. "Grade"). */
  gradeTitle: string;
  /** Current grade/condition label, or null when nothing is chosen yet. */
  gradeLabel: string | null;
  /** Opens the grade/condition picker (the existing GradeConditionSheet). */
  onOpenGradePicker: () => void;
  quantity: number;
  onIncrement: () => void;
  onDecrement: () => void;
  /** Primary CTA label — "Add to Collection" (add) or "Save changes" (edit). */
  confirmLabel: string;
  onConfirm: () => void;
  confirmDisabled?: boolean;
  testID?: string;
};

const SCREEN_HEIGHT = Dimensions.get('window').height;

/**
 * Bottom sheet that hosts the Grade + Quantity controls pulled out of the
 * always-visible configurator (Figma 1664:255 — these move into "Add to
 * Collection", surfaced when the user taps ADD ITEM). Mirrors GradeConditionSheet's
 * pop-open slide so the two sheets feel like one system; the grade picker it opens
 * stacks on top. Mode-agnostic: the screen supplies the confirm label/action so the
 * same sheet drives both the add and the owned-line edit flows.
 */
export function AddToCollectionSheet({
  visible,
  onClose,
  title = 'Add to Collection',
  gradeTitle,
  gradeLabel,
  onOpenGradePicker,
  quantity,
  onIncrement,
  onDecrement,
  confirmLabel,
  onConfirm,
  confirmDisabled = false,
  testID = 'add-to-collection-sheet',
}: AddToCollectionSheetProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();

  // Keep mounted through the closing slide-down, then unmount (matches the grade
  // sheet so the transition reads identically).
  const [isRendered, setIsRendered] = useState(visible);
  const translateY = useRef(new Animated.Value(SCREEN_HEIGHT)).current;

  useEffect(() => {
    if (visible) {
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
          <Text style={[theme.typography.titleMedium, styles.title, { color: theme.colors.gray900 }]}>
            {title}
          </Text>

          <View style={styles.body}>
            <View style={styles.group}>
              <Text style={[theme.typography.titleSmall, { color: theme.colors.gray900 }]}>
                {gradeTitle}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${gradeTitle}: ${gradeLabel ?? 'Select'}`}
                onPress={onOpenGradePicker}
                style={({ pressed }) => [
                  styles.selector,
                  { backgroundColor: theme.colors.gray50, opacity: pressed ? 0.9 : 1 },
                ]}
                testID={`${testID}-grade-trigger`}
              >
                <Text style={[theme.typography.label, { color: theme.colors.gray700 }]}>
                  {gradeLabel ?? 'Select'}
                </Text>
                <NavArrowDown color={theme.colors.gray700} height={24} width={24} />
              </Pressable>
            </View>

            <View style={styles.group}>
              <Text style={[theme.typography.titleSmall, { color: theme.colors.gray900 }]}>
                Quantity
              </Text>
              <View style={styles.stepper}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Decrease quantity"
                  accessibilityState={{ disabled: quantity <= 1 }}
                  disabled={quantity <= 1}
                  onPress={onDecrement}
                  style={({ pressed }) => [
                    styles.stepperButton,
                    {
                      backgroundColor: theme.colors.gray50,
                      opacity: pressed || quantity <= 1 ? 0.5 : 1,
                    },
                  ]}
                  testID={`${testID}-quantity-decrement`}
                >
                  <Minus color={theme.colors.gray900} height={20} width={20} />
                </Pressable>
                <Text
                  style={[styles.quantityValue, theme.typography.titleMedium]}
                  testID={`${testID}-quantity-value`}
                >
                  {quantity}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Increase quantity"
                  onPress={onIncrement}
                  style={({ pressed }) => [
                    styles.stepperButton,
                    { backgroundColor: theme.colors.gray50, opacity: pressed ? 0.5 : 1 },
                  ]}
                  testID={`${testID}-quantity-increment`}
                >
                  <Plus color={theme.colors.gray900} height={20} width={20} />
                </Pressable>
              </View>
            </View>

            <Button
              disabled={confirmDisabled}
              label={confirmLabel}
              labelStyleVariant="label"
              onPress={onConfirm}
              shape="rounded"
              size="md"
              testID={`${testID}-confirm`}
              variant="accent"
            />
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
  },
  body: {
    gap: 24,
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  group: {
    gap: 10,
  },
  handle: {
    alignSelf: 'center',
    borderRadius: 2,
    height: 4,
    width: 36,
  },
  quantityValue: {
    minWidth: 24,
    textAlign: 'center',
  },
  root: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  selector: {
    alignItems: 'center',
    borderRadius: 8,
    flexDirection: 'row',
    height: 32,
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    width: 160,
  },
  sheet: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    maxHeight: '70%',
    paddingTop: 10,
  },
  stepper: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    flexDirection: 'row',
    gap: 24,
  },
  stepperButton: {
    alignItems: 'center',
    borderRadius: 999,
    justifyContent: 'center',
    padding: 6,
  },
  title: {
    paddingBottom: 4,
    paddingHorizontal: 16,
    paddingTop: 18,
  },
});

export default AddToCollectionSheet;
