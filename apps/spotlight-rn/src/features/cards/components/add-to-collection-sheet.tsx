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
import { Minus, NavArrowDown, Plus } from 'iconoir-react-native';

import { Button, useSpotlightTheme } from '@spotlight/design-system';
import type { MarketHistoryOption } from '@spotlight/api-client';

import { CardConfigurator } from '@/features/cards/components/card-configurator';

type AddToCollectionSheetProps = {
  visible: boolean;
  onClose: () => void;
  /** Sheet heading — "Add to Collection". */
  title?: string;
  /** Language chips (EN/JP) — pre-filled from the PDP selection. */
  languages: string[];
  selectedLanguage: string;
  onSelectLanguage: (language: string) => void;
  /** Variant chips — pre-filled from the PDP selection. */
  variants: MarketHistoryOption[];
  variantsLoading?: boolean;
  selectedVariant: string | null;
  onSelectVariant: (id: string) => void;
  /** Grader chips (Raw/PSA/BGS/CGC) — pre-filled from the PDP selection. */
  graders: string[];
  selectedGrader: string | null;
  onSelectGrader: (grader: string) => void;
  /** Dropdown section title — "Condition" (raw) or "Grade" (graded). */
  gradeTitle: string;
  /** Current condition/grade label, or null when nothing is chosen yet. */
  gradeLabel: string | null;
  /** Opens the condition/grade picker (the existing GradeConditionSheet). */
  onOpenGradePicker: () => void;
  quantity: number;
  onIncrement: () => void;
  onDecrement: () => void;
  /** Primary CTA label — "CONFIRM". */
  confirmLabel: string;
  onConfirm: () => void;
  confirmDisabled?: boolean;
  testID?: string;
};

const SCREEN_HEIGHT = Dimensions.get('window').height;

/**
 * Bottom sheet that finalizes an add to the collection (Figma 1664:2011 /
 * 1664:2201). Hosts the full configurator — Language, Variant, Grader, then a
 * Condition/Grade dropdown + Quantity — pre-filled from the PDP's live selection
 * (the screen owns that state, so the chips reflect what the page shows). CONFIRM
 * commits; the page's action bar then flashes "SAVED". Mirrors GradeConditionSheet's
 * pop-open slide so the two sheets feel like one system; the grade picker stacks
 * on top.
 */
export function AddToCollectionSheet({
  visible,
  onClose,
  title = 'Add to Collection',
  languages,
  selectedLanguage,
  onSelectLanguage,
  variants,
  variantsLoading = false,
  selectedVariant,
  onSelectVariant,
  graders,
  selectedGrader,
  onSelectGrader,
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
          <Text style={[theme.typography.bodyMedium, styles.title, { color: theme.colors.gray600 }]}>
            {title}
          </Text>

          <ScrollView
            contentContainerStyle={styles.body}
            showsVerticalScrollIndicator={false}
            style={styles.scroll}
          >
            <CardConfigurator
              graders={graders}
              languages={languages}
              onSelectGrader={onSelectGrader}
              onSelectLanguage={onSelectLanguage}
              onSelectVariant={onSelectVariant}
              selectedGrader={selectedGrader}
              selectedLanguage={selectedLanguage}
              selectedVariant={selectedVariant}
              testID={`${testID}-configurator`}
              variants={variants}
              variantsLoading={variantsLoading}
            />

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
          </ScrollView>

          <View style={styles.footer}>
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
    paddingBottom: 16,
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  footer: {
    paddingHorizontal: 16,
    paddingTop: 12,
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
  scroll: {
    flexGrow: 0,
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
    maxHeight: '88%',
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
    textAlign: 'center',
  },
});

export default AddToCollectionSheet;
