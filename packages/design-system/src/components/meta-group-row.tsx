import { Image, Pressable, StyleSheet, View } from 'react-native';
import { GraphDown, GraphUp } from 'iconoir-react-native';

import { useSpotlightTheme } from '../theme';
import { AppText } from './app-text';
import { DeltaPill } from './delta-pill';
import { LaneTag, type LaneTagLane } from './lane-tag';

export type MetaGroupRowProps = {
  /** Group name, e.g. "Vintage PSA 10 · pop ≤ 50". */
  label: string;
  lane: LaneTagLane;
  /** Second line, e.g. "pre-2003 · 1,840 cards". */
  description: string;
  /** Preformatted signed median change, e.g. "+18.4%". */
  changeLabel: string;
  /** Drives the fallback icon (rising/cooling) and the pill tint. */
  changePercent: number;
  /**
   * Art of the card leading the group, so the row shows what it is about.
   * Groups span many sets, so a card reads better than a set logo. Null falls
   * back to the rising/cooling icon.
   */
  imageUrl?: string | null;
  /** Line under the pill, e.g. "+$412K value". Omitted = no line. */
  valueLabel?: string;
  /** Draw the 1pt gray200 rule above the row (every row but the first). */
  divider?: boolean;
  onPress?: () => void;
  testID?: string;
};

/**
 * One rising/cooling card group in the Meta pulse block and the Meta page
 * (meta feed mockups): a tinted trend icon, the group name with its RAW /
 * GRADED tag over a description, and the median change over the $ value
 * change. Hosts wrap rows in their own bordered container.
 */
export function MetaGroupRow({
  label,
  lane,
  description,
  changeLabel,
  changePercent,
  imageUrl = null,
  valueLabel,
  divider = false,
  onPress,
  testID,
}: MetaGroupRowProps) {
  const theme = useSpotlightTheme();
  const rising = changePercent >= 0;
  const Icon = rising ? GraphUp : GraphDown;
  return (
    <Pressable
      accessibilityLabel={`${label}, ${lane}, ${changeLabel}`}
      accessibilityRole={onPress ? 'button' : undefined}
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        divider
          ? { borderTopColor: theme.colors.gray200, borderTopWidth: theme.borderWidths.containerRule }
          : null,
        { opacity: pressed ? 0.7 : 1 },
      ]}
      testID={testID}
    >
      {imageUrl ? (
        <View
          style={[styles.art, { backgroundColor: theme.colors.gray200, borderCurve: 'continuous' }]}
          testID={testID ? `${testID}-art` : undefined}
        >
          <Image
            accessibilityIgnoresInvertColors
            resizeMode="cover"
            source={{ uri: imageUrl }}
            style={StyleSheet.absoluteFill}
          />
        </View>
      ) : (
      <View
        style={[
          styles.icon,
          {
            backgroundColor: rising ? theme.colors.deltaUpSurface : theme.colors.deltaDownSurface,
            borderCurve: 'continuous',
            borderRadius: theme.radii.sm,
          },
        ]}
        testID={testID ? `${testID}-icon-${rising ? 'up' : 'down'}` : undefined}
      >
        <Icon
          color={rising ? theme.colors.deltaUpText : theme.colors.deltaDownText}
          height={16}
          strokeWidth={2.2}
          width={16}
        />
      </View>
      )}
      <View style={styles.identity}>
        <View style={styles.labelRow}>
          <AppText color="gray900" numberOfLines={1} style={styles.label} variant="bodyMedium">
            {label}
          </AppText>
          <LaneTag lane={lane} testID={testID ? `${testID}-lane` : undefined} />
        </View>
        <AppText color="gray700" numberOfLines={1} variant="cardMeta">
          {description}
        </AppText>
      </View>
      <View style={styles.values}>
        <DeltaPill
          changePercent={changePercent}
          label={changeLabel}
          style={styles.pill}
          testID={testID ? `${testID}-change` : undefined}
        />
        {valueLabel ? (
          <AppText color="gray700" style={styles.valueLabel} variant="cardMeta">
            {valueLabel}
          </AppText>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    padding: 12,
  },
  // Card-shaped (5:7) thumbnail; raw-card art radius per inventory tiles.
  art: {
    borderRadius: 2,
    height: 45,
    overflow: 'hidden',
    width: 32,
  },
  icon: {
    alignItems: 'center',
    height: 32,
    justifyContent: 'center',
    width: 32,
  },
  identity: {
    flex: 1,
    minWidth: 0,
  },
  labelRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
  },
  label: {
    flexShrink: 1,
  },
  values: {
    alignItems: 'flex-end',
  },
  pill: {
    alignSelf: 'flex-end',
  },
  valueLabel: {
    marginTop: 3,
  },
});
