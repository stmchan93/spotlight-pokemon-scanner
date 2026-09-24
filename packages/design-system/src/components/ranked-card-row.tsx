import { Image, Pressable, StyleSheet, View } from 'react-native';

import { useSpotlightTheme } from '../theme';
import { layout } from '../tokens';
import { AppText } from './app-text';
import { DeltaPill } from './delta-pill';
import { LaneTag, type LaneTagLane } from './lane-tag';
import { RankBadge } from './rank-badge';

export type RankedCardRowProps = {
  rank: number;
  imageUrl: string | null;
  name: string;
  /** Second line, e.g. "Classic Collection · 4/102". */
  subtitle: string;
  /** Preformatted price, e.g. "$168.40". */
  priceLabel: string;
  /** Preformatted signed change; omitted/null = no pill. */
  changeLabel?: string | null;
  changePercent?: number | null;
  /** Optional tag after the name, e.g. `{ lane: 'graded', label: 'PSA 10' }`. */
  tag?: { lane: LaneTagLane; label?: string } | null;
  /** Draw the 0.5pt gray300 rule under the row (every row but the last). */
  divider?: boolean;
  onPress?: () => void;
  testID?: string;
};

/**
 * A numbered card row for top-N lists (Set spotlight block, Set page): rank,
 * 36×50 art, name over subtitle, and price over the change pill.
 */
export function RankedCardRow({
  rank,
  imageUrl,
  name,
  subtitle,
  priceLabel,
  changeLabel,
  changePercent = null,
  tag,
  divider = false,
  onPress,
  testID,
}: RankedCardRowProps) {
  const theme = useSpotlightTheme();
  return (
    <Pressable
      accessibilityLabel={`${rank}. ${name}, ${priceLabel}`}
      accessibilityRole={onPress ? 'button' : undefined}
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        divider
          ? { borderBottomColor: theme.colors.gray300, borderBottomWidth: theme.borderWidths.rule }
          : null,
        { opacity: pressed ? 0.7 : 1 },
      ]}
      testID={testID}
    >
      <RankBadge rank={rank} variant="plain" />
      <View
        style={[
          styles.art,
          {
            backgroundColor: theme.colors.gray200,
            borderCurve: 'continuous',
            borderRadius: layout.inventoryArtRadiusRaw,
          },
        ]}
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
      <View style={styles.identity}>
        <View style={styles.nameRow}>
          <AppText color="gray900" numberOfLines={1} style={styles.name} variant="bodyMedium">
            {name}
          </AppText>
          {tag ? <LaneTag label={tag.label} lane={tag.lane} /> : null}
        </View>
        <AppText color="gray700" numberOfLines={1} variant="cardMeta">
          {subtitle}
        </AppText>
      </View>
      <View style={styles.values}>
        <AppText color="gray900" variant="priceCaption">
          {priceLabel}
        </AppText>
        {changeLabel ? (
          <DeltaPill
            changePercent={changePercent}
            label={changeLabel}
            style={styles.pill}
            testID={testID ? `${testID}-change` : undefined}
          />
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
    paddingVertical: 8,
  },
  art: {
    height: 50,
    overflow: 'hidden',
    width: 36,
  },
  identity: {
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
  values: {
    alignItems: 'flex-end',
  },
  pill: {
    alignSelf: 'flex-end',
    marginTop: 2,
  },
});
