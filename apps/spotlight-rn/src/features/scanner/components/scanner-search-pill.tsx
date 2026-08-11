import { Pressable, StyleSheet, View } from 'react-native';

import { GlassSurface, Text, colors, textStyles } from '@spotlight/design-system';

import { EkalightMark } from '@/components/ekalight-mark';

/** 40pt — level with the toolbar's other controls (Figma 3686:56583). */
const PILL_HEIGHT = 40;
/** The mark sits 8 in from the leading edge, the label 8 after it. */
const CONTENT_INSET = 8;
const MARK_WIDTH = 22;
const MARK_HEIGHT = 20;

/**
 * The scanner's search ENTRY — a pill that looks like a search field but is a
 * button; pressing it opens the real catalog search (Figma 3686:56583).
 *
 * Replaces a bare magnifier bubble. A 32pt icon reads as "some action"; a
 * full-width field reads as "search, and here is where you will type", which is
 * what it actually does — the frame gives it the whole width between the back
 * button and the edge for exactly that reason.
 *
 * NOT `SearchEntryPill` from the design system, and that is a temporary
 * compromise rather than a preference: that primitive is styled for LIGHT
 * surfaces (gray50 fill, gray200 hairline, gray500 label) and has no dark or
 * glass variant, and it is being actively edited elsewhere. This composes
 * `GlassSurface` the same way `ScanTargetPill` next to it does, so the scanner's
 * chrome stays one material. Fold it back into the primitive as a `surface`
 * variant once that file is free.
 *
 * `glassColorScheme="dark"` for the reason every scanner surface pins it: `auto`
 * follows the SYSTEM appearance, and a light material over a near-black
 * viewfinder washes out to an opaque white puck.
 */
export function ScannerSearchPill({
  label = 'Search Cards',
  onPress,
  testID,
}: {
  label?: string;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      onPress={onPress}
      style={styles.pressable}
      testID={testID}
    >
      <GlassSurface
        fallbackColor={colors.scannerChromeFill}
        glassColorScheme="dark"
        glassEffectStyle="clear"
        style={styles.pill}
        testID={testID ? `${testID}-surface` : undefined}
      >
        <View style={styles.mark}>
          <EkalightMark color={colors.gray0} height={MARK_HEIGHT} width={MARK_WIDTH} />
        </View>
        <Text numberOfLines={1} style={styles.label}>
          {label}
        </Text>
      </GlassSurface>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // The pill takes the rest of the toolbar row.
  pressable: {
    borderRadius: 999,
    flex: 1,
  },
  pill: {
    alignItems: 'center',
    borderRadius: 999,
    flexDirection: 'row',
    gap: CONTENT_INSET,
    height: PILL_HEIGHT,
    overflow: 'hidden',
    paddingHorizontal: CONTENT_INSET,
  },
  mark: {
    height: MARK_HEIGHT,
    width: MARK_WIDTH,
  },
  label: {
    // 14/Regular white, per the frame — the placeholder voice of a search
    // field, not the 15/SemiBold of a button label.
    ...textStyles.body,
    color: colors.gray0,
  },
});
