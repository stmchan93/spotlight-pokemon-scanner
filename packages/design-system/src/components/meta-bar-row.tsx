import { Image, Pressable, StyleSheet, View } from 'react-native';

import { useSpotlightTheme } from '../theme';
import { AppText } from './app-text';
import { OwnedTag } from './owned-tag';
import { PriceSparkline } from './price-sparkline';

export type MetaBarRowProps = {
  /** Group name, e.g. "Vintage PSA 10 · low pop". */
  label: string;
  /** Lead card art (the group's biggest contributor). Null = gray200 slot. */
  imageUrl?: string | null;
  /** "You own 4"; null/omitted = no tag. */
  ownedLabel?: string | null;
  /**
   * Bar length, 0…1: |change| relative to the largest change the HOST shows,
   * so the longest bar in a list is always full width. Clamped here.
   */
  barFraction: number;
  /** Sign drives the bar, sparkline and % color (>= 0 green, < 0 red). */
  changePercent: number;
  /** Preformatted signed change, e.g. "+18.4%". */
  changeLabel: string;
  /** Preformatted signed $ change under the %, e.g. "+$412k". */
  valueLabel?: string | null;
  /** Group value index, oldest → newest. Empty = the slot stays blank. */
  sparkPoints?: number[];
  onPress?: () => void;
  testID?: string;
};

const THUMB = { height: 47, width: 34 } as const;
const SPARK = { height: 16, width: 48 } as const;
const BAR_HEIGHT = 8;
const VALUE_COLUMN_WIDTH = 74;

/**
 * One rising/cooling group as a bar row (Meta pulse v4 / Meta page v4
 * mockups): lead-card thumbnail, name + optional `OwnedTag` over a bar whose
 * length the host scales, a mini sparkline, then the bold colored % over the
 * signed $ change. Rows are unframed; the host stacks them.
 */
export function MetaBarRow({
  label,
  imageUrl = null,
  ownedLabel = null,
  barFraction,
  changePercent,
  changeLabel,
  valueLabel = null,
  sparkPoints = [],
  onPress,
  testID,
}: MetaBarRowProps) {
  const theme = useSpotlightTheme();
  const rising = changePercent >= 0;
  const fraction = Number.isFinite(barFraction) ? Math.min(1, Math.max(0, barFraction)) : 0;

  return (
    <Pressable
      accessibilityLabel={[label, ownedLabel, changeLabel, valueLabel].filter(Boolean).join(', ')}
      accessibilityRole={onPress ? 'button' : undefined}
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => [styles.row, { opacity: pressed ? 0.7 : 1 }]}
      testID={testID}
    >
      <View
        style={[
          styles.thumb,
          { backgroundColor: theme.colors.gray200, borderCurve: 'continuous' },
        ]}
        testID={testID ? `${testID}-art` : undefined}
      >
        {imageUrl ? (
          <Image
            accessibilityIgnoresInvertColors
            resizeMode="cover"
            source={{ uri: imageUrl }}
            style={StyleSheet.absoluteFill}
          />
        ) : null}
      </View>
      <View style={styles.middle}>
        <View style={styles.nameRow}>
          <AppText color="gray900" numberOfLines={1} style={styles.name} variant="feedRowTitle">
            {label}
          </AppText>
          {ownedLabel ? <OwnedTag label={ownedLabel} testID={testID ? `${testID}-owned` : undefined} /> : null}
        </View>
        <View
          style={[
            styles.track,
            { backgroundColor: theme.colors.gray100, borderCurve: 'continuous', borderRadius: theme.radii.pill },
          ]}
        >
          <View
            style={[
              styles.fill,
              {
                backgroundColor: rising ? theme.colors.green500 : theme.colors.red500,
                borderCurve: 'continuous',
                borderRadius: theme.radii.pill,
                width: `${Math.round(fraction * 1000) / 10}%`,
              },
            ]}
            testID={testID ? `${testID}-bar` : undefined}
          />
        </View>
      </View>
      <PriceSparkline
        height={SPARK.height}
        points={sparkPoints}
        testID={testID ? `${testID}-spark` : undefined}
        trendPct={changePercent}
        width={SPARK.width}
      />
      <View style={styles.values}>
        <AppText
          color={rising ? 'deltaUpText' : 'deltaDownText'}
          numberOfLines={1}
          style={styles.alignEnd}
          testID={testID ? `${testID}-change` : undefined}
          variant="feedDelta"
        >
          {changeLabel}
        </AppText>
        {valueLabel ? (
          <AppText color="gray600" numberOfLines={1} style={styles.alignEnd} variant="captionStrong">
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
    paddingVertical: 10,
  },
  // Card-shaped thumb; the radius lives on this clipping wrapper.
  thumb: {
    borderRadius: 3,
    height: THUMB.height,
    overflow: 'hidden',
    width: THUMB.width,
  },
  middle: {
    flex: 1,
    minWidth: 0,
  },
  nameRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
  },
  name: {
    flexShrink: 1,
  },
  track: {
    height: BAR_HEIGHT,
    marginTop: 7,
    overflow: 'hidden',
  },
  fill: {
    height: BAR_HEIGHT,
  },
  values: {
    flexShrink: 0,
    width: VALUE_COLUMN_WIDTH,
  },
  alignEnd: {
    textAlign: 'right',
  },
});
