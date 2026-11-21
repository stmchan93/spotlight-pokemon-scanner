import { useState } from 'react';
import { Image, Pressable, StyleSheet, View } from 'react-native';

import { ProgressBar, Text, radii, spacing, useSpotlightTheme } from '@spotlight/design-system';

import { completionCountLabel, formatSetReleaseDate, type SetCompletion } from '@/features/catalog/set-progress';
import { formatCurrency } from '@/features/portfolio/components/portfolio-formatting';

type SearchSetCardProps = {
  name: string;
  releaseDate: string | null;
  logoUrl: string | null;
  completion: SetCompletion | null;
  /** The whole set's value (USD); null hides TOTAL VALUE. */
  setValue?: number | null;
  onPress: () => void;
  testID: string;
};

// Figma 6607:8855 set logo slot: 83×40, left-aligned.
const LOGO_WIDTH = 83;
const LOGO_HEIGHT = 40;

/**
 * A set on Search (Figma 6607:8854): logo, name + release date, a 20pt purple
 * progress bar with the percent inside it, then "TOTAL VALUE: $…" and
 * "X of Y CARDS". No logo (or a failed one): the name takes the logo slot and
 * the title row keeps just the date, so the card never shows an empty box or
 * the name twice.
 */
export function SearchSetCard({
  name,
  releaseDate,
  logoUrl,
  completion,
  setValue = null,
  onPress,
  testID,
}: SearchSetCardProps) {
  const theme = useSpotlightTheme();
  const [hasLogoError, setHasLogoError] = useState(false);
  const date = formatSetReleaseDate(releaseDate);
  const showsLogo = Boolean(logoUrl) && !hasLogoError;

  return (
    <Pressable
      accessibilityLabel={name}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        { backgroundColor: theme.colors.gray0, borderColor: theme.colors.gray100, opacity: pressed ? 0.88 : 1 },
      ]}
      testID={testID}
    >
      {showsLogo && logoUrl ? (
        <Image
          accessibilityIgnoresInvertColors
          onError={() => setHasLogoError(true)}
          resizeMode="contain"
          source={{ uri: logoUrl }}
          style={styles.logo}
          testID={`${testID}-logo`}
        />
      ) : (
        <View style={styles.logoNameSlot} testID={`${testID}-logo-name`}>
          <Text numberOfLines={2} style={[theme.typography.titleSmall, { color: theme.colors.gray900 }]}>
            {name}
          </Text>
        </View>
      )}
      <View style={styles.titleBlock}>
        <View style={styles.titleRow}>
          {showsLogo ? (
            <Text
              numberOfLines={1}
              style={[styles.title, theme.typography.feedRowTitle, { color: theme.colors.gray900 }]}
            >
              {name}
            </Text>
          ) : (
            <View style={styles.title} />
          )}
          {date ? (
            <Text numberOfLines={1} style={[theme.typography.overlineMedium, { color: theme.colors.gray600 }]}>
              {date}
            </Text>
          ) : null}
        </View>
        {completion ? (
          <View>
            <ProgressBar
              accessibilityLabel={`${completion.percent}% complete`}
              size="lg"
              testID={`${testID}-progress`}
              track="accent"
              value={completion.fraction}
            />
            {/* Figma draws the percent centred IN the bar, light over both fill and track. */}
            <View pointerEvents="none" style={styles.percentOverlay}>
              <Text style={[theme.typography.overline, { color: theme.colors.gray0 }]} testID={`${testID}-percent`}>
                {`${completion.percent}%`}
              </Text>
            </View>
          </View>
        ) : null}
      </View>
      {completion || setValue != null ? (
        <View style={styles.footer}>
          {setValue != null ? (
            <Text
              numberOfLines={1}
              style={[styles.footerValue, theme.typography.overline, { color: theme.colors.gray900 }]}
              testID={`${testID}-total-value`}
            >
              {`TOTAL VALUE: ${formatCurrency(setValue, 'USD')}`}
            </Text>
          ) : (
            <View />
          )}
          {completion ? (
            <Text style={[theme.typography.overline, { color: theme.colors.gray600 }]}>
              {completionCountLabel(completion)}
            </Text>
          ) : null}
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    borderCurve: 'continuous',
    borderRadius: radii.md,
    borderWidth: 1,
    gap: spacing.sm,
    padding: spacing.md,
    width: '100%',
  },
  footer: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: spacing.xxs,
    justifyContent: 'space-between',
  },
  footerValue: {
    flexShrink: 1,
  },
  logo: {
    height: LOGO_HEIGHT,
    width: LOGO_WIDTH,
  },
  // Same height as the logo so cards with and without one line up.
  logoNameSlot: {
    justifyContent: 'center',
    minHeight: LOGO_HEIGHT,
  },
  percentOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    flexShrink: 1,
  },
  titleBlock: {
    gap: 6,
  },
  titleRow: {
    alignItems: 'flex-end',
    flexDirection: 'row',
    gap: spacing.xxs,
    justifyContent: 'space-between',
  },
});
