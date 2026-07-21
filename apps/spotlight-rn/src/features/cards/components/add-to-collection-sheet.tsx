import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  Easing,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Minus, NavArrowDown, Plus } from 'iconoir-react-native';

import { Button, Text, useSpotlightTheme } from '@spotlight/design-system';
import type { MarketHistoryOption } from '@spotlight/api-client';

import { CardConfigurator } from '@/features/cards/components/card-configurator';
import {
  GradeConditionSheet,
  type GradeConditionOption,
} from '@/features/cards/components/grade-condition-sheet';

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
  /** Condition/grade picker, hosted as an overlay INSIDE this sheet (a nested RN
   *  modal can't present over this one on iOS, so it must live within it). */
  gradeOptions: GradeConditionOption[];
  gradeSelectedId: string | null;
  onSelectGrade: (id: string) => void;
  /** testID for the embedded picker; defaults to `<testID>-grade-picker`. */
  gradePickerTestID?: string;
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
  gradeOptions,
  gradeSelectedId,
  onSelectGrade,
  gradePickerTestID,
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
  // The condition/grade picker is hosted INSIDE this sheet (see import note).
  const [pickerOpen, setPickerOpen] = useState(false);

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

    // The host sheet is closing — collapse the grade picker overlay too.
    setPickerOpen(false);
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

  // Interactive drag-to-dismiss anchored on the header (handle + title): a
  // downward drag follows the finger; releasing past a distance/velocity
  // threshold dismisses (the close effect finishes the slide), otherwise it
  // springs back. PanResponder runs on the JS thread, so these writes are safe
  // (no gesture-handler worklet/runOnJS hazard) and don't fight the ScrollView
  // below — only the header claims the gesture.
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
      {/* The instant the sheet starts closing (visible=false) the whole overlay
          stops intercepting touches, so the page behind is tappable again even
          if the slide-down's unmount callback never fires (prevents a stuck
          full-screen backdrop from freezing the grader/controls). */}
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
          {/* Header is the drag-to-dismiss zone (handle bar + title): a downward
              swipe anywhere here drags the sheet down and dismisses; a tap on the
              bar still closes via the Pressable. */}
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
            <Text style={[theme.typography.bodyMedium, styles.title, { color: theme.colors.gray600 }]}>
              {title}
            </Text>
          </View>

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
                onPress={() => setPickerOpen(true)}
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
              variant="dark"
            />
          </View>
        </Animated.View>

        {/* Condition/grade picker overlays this sheet from within its own modal
            (a nested RN <Modal> won't present over an open one on iOS). */}
        <GradeConditionSheet
          embedded
          onClose={() => setPickerOpen(false)}
          onSelect={onSelectGrade}
          options={gradeOptions}
          selectedId={gradeSelectedId}
          testID={gradePickerTestID ?? `${testID}-grade-picker`}
          title={gradeTitle}
          visible={pickerOpen}
        />
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
    borderTopLeftRadius: 0,
    borderTopRightRadius: 0,
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
