import { Dimensions, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { BlurView } from 'expo-blur';
import { IconCheck } from '@tabler/icons-react-native';

import type { RawPricingMatrixVariant } from '@spotlight/api-client';
import { Text, useSpotlightTheme } from '@spotlight/design-system';

export type AnchoredMenuAnchor = { x: number; y: number; width: number; height: number };

export type AnchoredOption = { key: string; label: string };

export type AnchoredOptionMenuProps = {
  visible: boolean;
  /** Measured screen coords of the trigger pill (measureInWindow); null until measured. */
  anchor: AnchoredMenuAnchor | null;
  options: readonly AnchoredOption[];
  selectedKey: string | null;
  onSelect: (option: AnchoredOption) => void;
  onClose: () => void;
  /** Screen-reader label per row; defaults to the row's label. */
  accessibilityLabelFor?: (option: AnchoredOption) => string;
  testID?: string;
};

type PrintingMenuProps = {
  visible: boolean;
  anchor: AnchoredMenuAnchor | null;
  variants: readonly RawPricingMatrixVariant[];
  selectedVariantKey: string | null;
  onSelect: (variant: RawPricingMatrixVariant) => void;
  onClose: () => void;
  testID?: string;
};

const CARD_MIN_WIDTH = 200;
const CARD_MAX_WIDTH = 280;
const SCREEN_MARGIN = 8;
const ANCHOR_GAP = 6;
const ROW_HEIGHT = 40;
const MAX_VISIBLE_ROWS = 6;
const FALLBACK_TOP = 96;
const FALLBACK_LEFT = 16;
const CARD_RADIUS = 20;

/**
 * The scan tray's printing picker: the row's pill opens this list of the card's
 * printings, the current one checked. A thin mapping over `AnchoredOptionMenu`
 * so the tray's row dropdown and the binder page's batch dropdowns are ONE
 * component, not two that drift.
 */
export function PrintingMenu({
  visible,
  anchor,
  variants,
  selectedVariantKey,
  onSelect,
  onClose,
  testID = 'printing-menu',
}: PrintingMenuProps) {
  const byKey = new Map(variants.map((variant) => [variant.variantKey, variant]));
  return (
    <AnchoredOptionMenu
      accessibilityLabelFor={(option) => `Price this scan as ${option.label}`}
      anchor={anchor}
      onClose={onClose}
      onSelect={(option) => {
        const variant = byKey.get(option.key);
        if (variant) {
          onSelect(variant);
        }
      }}
      options={variants.map((variant) => ({ key: variant.variantKey, label: variant.variant }))}
      selectedKey={selectedVariantKey}
      testID={testID}
      visible={visible}
    />
  );
}

/**
 * An anchored dropdown list, the current row checked: the same glass card as
 * the tray's ADD ALL menu, so a dropdown over the scanner always looks like one
 * thing. Opens below its anchor, or above it when there is no room below (the
 * tray sits at the bottom, so its dropdowns nearly always open up). A list of
 * a dozen rows scrolls rather than running off the screen.
 */
export function AnchoredOptionMenu({
  visible,
  anchor,
  options,
  selectedKey,
  onSelect,
  onClose,
  accessibilityLabelFor,
  testID = 'option-menu',
}: AnchoredOptionMenuProps) {
  const theme = useSpotlightTheme();

  if (!visible || options.length === 0) {
    return null;
  }

  /*
    A LIST THAT OVERFLOWS SHOWS HALF A ROW. Cutting the last visible row in
    two is the only cue that says "keep going" while the menu is sitting
    still — a scroll indicator is transient on iOS, so a full-height list
    ending flush on a row boundary looks complete, and the option below the
    fold may as well not exist. That is exactly how the tray's "Custom…" went
    unnoticed: eighth of eight rows, six of them visible.
  */
  const overflows = options.length > MAX_VISIBLE_ROWS;
  const listHeight = overflows
    ? (MAX_VISIBLE_ROWS + 0.5) * ROW_HEIGHT
    : options.length * ROW_HEIGHT;
  const cardHeight = listHeight + 20;

  const screen = Dimensions.get('window');
  const anchorTop = anchor ? anchor.y : FALLBACK_TOP;
  const anchorBottom = anchor ? anchor.y + anchor.height : FALLBACK_TOP;
  // The tray sits at the bottom of the scanner, so this nearly always opens up.
  const openUp = anchor != null && anchorBottom + ANCHOR_GAP + cardHeight + SCREEN_MARGIN > screen.height;
  const verticalStyle = openUp
    ? { bottom: screen.height - anchorTop + ANCHOR_GAP }
    : { top: anchorBottom + ANCHOR_GAP };
  const maxLeft = screen.width - CARD_MIN_WIDTH - SCREEN_MARGIN;
  const rawLeft = anchor ? anchor.x : FALLBACK_LEFT;
  const left = Math.max(SCREEN_MARGIN, Math.min(rawLeft, maxLeft));

  return (
    <Modal animationType="none" onRequestClose={onClose} transparent visible>
      <Pressable
        accessibilityLabel="Close"
        accessibilityRole="button"
        onPress={onClose}
        style={styles.backdrop}
        testID={`${testID}-backdrop`}
      />
      <View style={[styles.card, { left, ...verticalStyle }]} testID={testID}>
        {/* iOS-only blur: inside a transparent Modal Android has nothing to sample. */}
        {Platform.OS === 'ios' ? (
          <BlurView intensity={40} style={StyleSheet.absoluteFill} tint="light" />
        ) : null}
        <View
          style={[
            StyleSheet.absoluteFill,
            Platform.OS === 'ios' ? styles.glassFill : styles.opaqueFill,
          ]}
        />
        <ScrollView
          bounces={false}
          scrollEnabled={overflows}
          // On during a scroll it confirms how much is left; the half row is
          // what carries the message at rest.
          showsVerticalScrollIndicator={overflows}
          style={{ maxHeight: listHeight }}
        >
          {options.map((option) => {
            const isSelected = option.key === selectedKey;
            return (
              <Pressable
                accessibilityLabel={accessibilityLabelFor?.(option) ?? option.label}
                accessibilityRole="button"
                accessibilityState={{ selected: isSelected }}
                key={option.key}
                onPress={() => onSelect(option)}
                style={({ pressed }) => [
                  styles.row,
                  { backgroundColor: pressed ? 'rgba(0, 0, 0, 0.06)' : 'transparent' },
                ]}
                testID={`${testID}-${option.key}`}
              >
                <Text
                  numberOfLines={1}
                  style={[theme.typography.body, styles.label, { color: theme.colors.gray900 }]}
                >
                  {option.label}
                </Text>
                {isSelected ? (
                  <IconCheck color={theme.colors.purple500} size={18} strokeWidth={2.2} />
                ) : null}
              </Pressable>
            );
          })}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  card: {
    borderCurve: 'continuous',
    borderRadius: CARD_RADIUS,
    elevation: 8,
    maxWidth: CARD_MAX_WIDTH,
    minWidth: CARD_MIN_WIDTH,
    overflow: 'hidden',
    paddingHorizontal: 8,
    paddingVertical: 10,
    position: 'absolute',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.12,
    shadowRadius: 40,
  },
  glassFill: {
    backgroundColor: 'rgba(245, 245, 245, 0.6)',
  },
  opaqueFill: {
    backgroundColor: '#F5F5F5',
  },
  row: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: 12,
    flexDirection: 'row',
    height: ROW_HEIGHT,
    justifyContent: 'space-between',
    paddingHorizontal: 12,
  },
  label: {
    flexShrink: 1,
    marginRight: 12,
  },
});

export default PrintingMenu;
