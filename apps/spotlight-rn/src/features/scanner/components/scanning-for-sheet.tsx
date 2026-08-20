import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Dimensions, Easing, Modal, PanResponder, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  AppText,
  RadioDot,
  SheetSurface,
  colors,
} from '@spotlight/design-system';

import {
  SCANNER_LANES,
  isSameScannerLane,
  scanTargetFlag,
  scannerLaneKey,
  scannerLaneLabel,
  type ScannerLane,
} from '@/features/scanner/use-scanner-target-config';

import { RoundFlag } from './round-flag';

const SCREEN_HEIGHT = Dimensions.get('window').height;

// Trading-card games we have no catalog for at all. Rendered as disabled rows
// with a "Coming Soon" tag per the Figma "Scanning for" sheet (node 1056-1472).
// Non-interactive — no handler. Everything we DO have a catalog and a visual
// index for comes from `SCANNER_LANES`, never from a list in this file.
const COMING_SOON_TYPES = [
  'Magic: The Gathering',
  'Sports',
  'Yu-Gi-Oh',
] as const;

type ScanningForSheetProps = {
  visible: boolean;
  lane: ScannerLane;
  onSelectLane: (lane: ScannerLane) => void;
  onClose: () => void;
  testID?: string;
};

// NOTE: The CONDITION (Graded/Ungraded) section was intentionally removed.
// Scanning is now always raw/visual; grading is chosen later on the product
// detail page. The slab lane is kept but gated off pending the PDP-grading flow.
export function ScanningForSheet({
  visible,
  lane,
  onSelectLane,
  onClose,
  testID = 'scanning-for-sheet',
}: ScanningForSheetProps) {
  const insets = useSafeAreaInsets();

  // Slide the sheet UP from the bottom (spring in / timing out), mirroring the
  // app's other bottom sheets (add-to-collection-sheet / scan-bulk-confirm-sheet)
  // so it scrolls into view instead of fading in already docked. Kept mounted
  // through the closing slide, then unmounts.
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
      <View pointerEvents={visible ? 'box-none' : 'none'} style={styles.overlay}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close scan target picker"
          onPress={onClose}
          style={styles.backdrop}
          testID={`${testID}-backdrop`}
        />
        <Animated.View style={{ transform: [{ translateY }] }}>
          <SheetSurface
            padding={16}
            showHandle={false}
            testID={testID}
            tone="dark"
            style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}
          >
            <DismissHandle onDismiss={onClose} testID={`${testID}-handle`} />

          <View style={styles.header}>
            <View style={styles.headerPill}>
              <AppText color="gray400" variant="labelStrong">
                SCANNING FOR
              </AppText>
            </View>
          </View>

          <View style={styles.list}>
            {SCANNER_LANES.map((option) => (
              <LaneRow
                flag={scanTargetFlag(option)}
                key={scannerLaneKey(option)}
                label={scannerLaneLabel(option)}
                onPress={() => onSelectLane(option)}
                selected={isSameScannerLane(lane, option)}
                testID={`${testID}-type-${scannerLaneKey(option)}`}
              />
            ))}
            {COMING_SOON_TYPES.map((name) => (
              <ComingSoonRow key={name} label={name} />
            ))}
          </View>
          </SheetSurface>
        </Animated.View>
      </View>
    </Modal>
  );
}

// The grab handle dismisses the sheet on TAP or a downward SWIPE — not just a
// backdrop tap. The PanResponder lives on a WRAPPER View around the tap
// Pressable (the ConfirmDeleteSheet/InsightsSortSheet pattern): spreading
// panHandlers onto the Pressable itself merges two responder wirings on one
// node, and the Pressable's claim wins — the swipe never fired on device.
function DismissHandle({
  onDismiss,
  testID,
}: {
  onDismiss: () => void;
  testID?: string;
}) {
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, gesture) =>
          gesture.dy > 4 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
        onPanResponderRelease: (_event, gesture) => {
          if (gesture.dy > 24 || gesture.vy > 0.5) {
            onDismiss();
          }
        },
      }),
    [onDismiss],
  );

  return (
    <View {...panResponder.panHandlers}>
      <Pressable
        accessibilityLabel="Close scan target picker"
        accessibilityRole="button"
        hitSlop={16}
        onPress={onDismiss}
        style={styles.handleHitArea}
        testID={testID}
      >
        <View style={styles.handleBar} />
      </Pressable>
    </View>
  );
}

function LaneRow({
  label,
  flag,
  selected,
  onPress,
  testID,
}: {
  label: string;
  /**
   * Round language flag rendered after the label (mirrors the pill). Undefined
   * for games with a single-language catalog — a flag there would advertise a
   * choice that does not exist.
   */
  flag?: 'en' | 'jp';
  selected: boolean;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      testID={testID}
    >
      <View style={styles.rowLabelGroup}>
        <AppText color="gray0" variant="body">
          {label}
        </AppText>
        {flag ? <RoundFlag language={flag} size={13} /> : null}
      </View>
      <RadioDot selected={selected} selectedColor={colors.purple500} />
    </Pressable>
  );
}

function ComingSoonRow({ label }: { label: string }) {
  return (
    <View style={styles.row}>
      <AppText color="gray600" style={styles.rowLabel} variant="body">
        {label}
      </AppText>
      <View style={styles.comingSoonTag}>
        <AppText color="gray400" variant="overline">
          Coming Soon
        </AppText>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.65)',
  },
  comingSoonTag: {
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    borderRadius: 999,
    justifyContent: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  handleBar: {
    backgroundColor: colors.gray100,
    borderRadius: 999,
    height: 4,
    width: 48,
  },
  handleHitArea: {
    alignItems: 'center',
    paddingBottom: 16,
    paddingTop: 4,
  },
  header: {
    alignItems: 'center',
    marginBottom: 16,
  },
  headerPill: {
    alignItems: 'center',
    backgroundColor: colors.gray900,
    borderRadius: 999,
    justifyContent: 'center',
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  list: {
    gap: 16,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 24,
  },
  rowLabel: {
    flex: 1,
  },
  rowLabelGroup: {
    alignItems: 'center',
    flex: 1,
    flexDirection: 'row',
    gap: 6,
  },
  rowPressed: {
    opacity: 0.7,
  },
  sheet: {
    width: '100%',
  },
});
