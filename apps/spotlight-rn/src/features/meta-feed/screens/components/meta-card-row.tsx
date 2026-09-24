import { Pressable, StyleSheet, View } from 'react-native';

import { DeltaPill, Text, borderWidths, layout, spacing, useSpotlightTheme } from '@spotlight/design-system';

import { CachedImage, imageCachePolicy } from '@/components/cached-image';
import { formatSignedPercent } from '@/features/meta-feed/screens/components/meta-format';
import { formatCurrency } from '@/features/portfolio/components/portfolio-formatting';

// Mockup art slot (Meta.dc "Cards driving").
const ART = { height: 56, width: 40 } as const;

export type MetaCardRowProps = {
  changePercent: number | null;
  currencyCode: string;
  imageUrl: string | null;
  meta: string | null;
  name: string;
  onPress?: () => void;
  price: number | null;
  showDivider?: boolean;
  testID?: string;
};

/**
 * Compact card row from the Meta mockup: art, name + meta line, price over
 * a delta chip. Taps open the card page.
 */
export function MetaCardRow({
  changePercent,
  currencyCode,
  imageUrl,
  meta,
  name,
  onPress,
  price,
  showDivider = true,
  testID,
}: MetaCardRowProps) {
  const theme = useSpotlightTheme();
  const priceLabel = price == null ? '—' : formatCurrency(price, currencyCode);
  const changeLabel = changePercent == null ? null : formatSignedPercent(changePercent);

  return (
    <Pressable
      accessibilityLabel={[name, meta, priceLabel, changeLabel].filter(Boolean).join(', ')}
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
      <View
        style={[
          styles.art,
          { backgroundColor: theme.colors.gray200, height: ART.height, width: ART.width },
        ]}
      >
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
        <Text numberOfLines={1} style={theme.typography.bodyMedium}>
          {name}
        </Text>
        {meta ? (
          <Text numberOfLines={1} style={theme.typography.cardMeta}>
            {meta}
          </Text>
        ) : null}
      </View>
      <View style={styles.priceColumn}>
        <Text style={theme.typography.priceCaption}>{priceLabel}</Text>
        {changeLabel ? <DeltaPill changePercent={changePercent} label={changeLabel} /> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  art: {
    borderCurve: 'continuous',
    borderRadius: layout.inventoryArtRadiusRaw,
    overflow: 'hidden',
  },
  copy: {
    flex: 1,
    gap: 2,
    minWidth: 0,
  },
  fill: {
    height: '100%',
    width: '100%',
  },
  priceColumn: {
    alignItems: 'flex-end',
    gap: 2,
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xs,
    minHeight: 44,
    paddingVertical: spacing.xxs,
  },
});
