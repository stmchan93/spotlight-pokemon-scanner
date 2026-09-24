import { Pressable, StyleSheet, View } from 'react-native';

import { OwnedTag, Text, borderWidths, layout, spacing, useSpotlightTheme } from '@spotlight/design-system';

import { CachedImage, imageCachePolicy } from '@/components/cached-image';
import { formatSignedPercent } from '@/features/meta-feed/screens/components/meta-format';
import { useSignedColor } from '@/features/meta-feed/screens/components/meta-page-chrome';
import { formatCurrency } from '@/features/portfolio/components/portfolio-formatting';

// Group page art slot (GroupV6.dc: 48×67).
const ART = { height: 67, width: 48 } as const;

export type MetaCardRowProps = {
  changePercent: number | null;
  currencyCode: string;
  imageUrl: string | null;
  meta: string | null;
  name: string;
  /** "In your collection" under the meta line; omitted = no tag. */
  ownedLabel?: string | null;
  onPress?: () => void;
  price: number | null;
  showDivider?: boolean;
  testID?: string;
};

/**
 * Card row from the group page mockup: art, name + meta line (+ owned tag),
 * then the price over the signed change in the delta color. Taps open the
 * card page.
 */
export function MetaCardRow({
  changePercent,
  currencyCode,
  imageUrl,
  meta,
  name,
  ownedLabel = null,
  onPress,
  price,
  showDivider = true,
  testID,
}: MetaCardRowProps) {
  const theme = useSpotlightTheme();
  const changeColor = useSignedColor(changePercent);
  const priceLabel = price == null ? '—' : formatCurrency(price, currencyCode);
  const changeLabel = changePercent == null ? null : formatSignedPercent(changePercent);

  return (
    <Pressable
      accessibilityLabel={[name, meta, ownedLabel, priceLabel, changeLabel].filter(Boolean).join(', ')}
      accessibilityRole="button"
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        showDivider
          ? { borderBottomColor: theme.colors.gray300, borderBottomWidth: borderWidths.rule }
          : null,
        { opacity: pressed ? 0.86 : 1 },
      ]}
      testID={testID}
    >
      <View style={[styles.art, { backgroundColor: theme.colors.gray200 }]}>
        {imageUrl ? (
          <CachedImage
            cachePolicy={imageCachePolicy.thumbnail}
            contentFit="cover"
            style={styles.fill}
            uri={imageUrl}
          />
        ) : null}
      </View>
      <View style={styles.copy}>
        <Text numberOfLines={1} style={[theme.typography.feedRowTitle, { color: theme.colors.gray900 }]}>
          {name}
        </Text>
        {meta ? (
          <Text numberOfLines={1} style={theme.typography.captionMedium}>
            {meta}
          </Text>
        ) : null}
        {ownedLabel ? (
          <OwnedTag label={ownedLabel} style={styles.tag} testID={testID ? `${testID}-owned` : undefined} />
        ) : null}
      </View>
      <View style={styles.priceColumn}>
        <Text style={[theme.typography.feedRowTitle, { color: theme.colors.gray900 }]}>{priceLabel}</Text>
        {changeLabel ? (
          <Text style={[theme.typography.titleXsmall, { color: changeColor }]} testID={testID ? `${testID}-change` : undefined}>
            {changeLabel}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  art: {
    borderCurve: 'continuous',
    borderRadius: layout.inventoryArtRadiusRaw,
    height: ART.height,
    overflow: 'hidden',
    width: ART.width,
  },
  copy: {
    flex: 1,
    minWidth: 0,
  },
  fill: {
    height: '100%',
    width: '100%',
  },
  priceColumn: {
    alignItems: 'flex-end',
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xs,
    minHeight: 44,
    paddingVertical: 10,
  },
  tag: {
    marginTop: spacing.xxxs,
  },
});
