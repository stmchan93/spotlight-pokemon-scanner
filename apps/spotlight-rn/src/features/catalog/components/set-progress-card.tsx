import { useState } from 'react';
import { Image, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { ProgressBar, Text, radii, shadows, spacing, useSpotlightTheme } from '@spotlight/design-system';

import {
  completionCountLabel,
  formatSetReleaseDate,
  type SetCompletion,
} from '@/features/catalog/set-progress';

type SetProgressCardProps = {
  name: string;
  releaseDate: string | null;
  completion: SetCompletion | null;
  /**
   * 'list' — a sets-list row (Figma 6552:1953): logo, name, date, progress.
   * 'header' — the set page's summary (6425:3325): no logo (the page shows it
   * large above), name in caps, plus the TOTAL VALUE line.
   */
  variant?: 'list' | 'header';
  logoUrl?: string | null;
  /** Already formatted ("$1,012.78"); null hides the line. */
  totalValueLabel?: string | null;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

// Figma set logo slot on the list card: 83×40, left-aligned.
const LIST_LOGO_WIDTH = 83;
const LIST_LOGO_HEIGHT = 40;

export function SetProgressCard({
  name,
  releaseDate,
  completion,
  variant = 'list',
  logoUrl = null,
  totalValueLabel = null,
  onPress,
  style,
  testID,
}: SetProgressCardProps) {
  const theme = useSpotlightTheme();
  const [hasLogoError, setHasLogoError] = useState(false);
  const isHeader = variant === 'header';
  const date = formatSetReleaseDate(releaseDate);

  const body = (
    <>
      {!isHeader && logoUrl && !hasLogoError ? (
        <Image
          accessibilityIgnoresInvertColors
          onError={() => setHasLogoError(true)}
          resizeMode="contain"
          source={{ uri: logoUrl }}
          style={styles.listLogo}
          testID={testID ? `${testID}-logo` : undefined}
        />
      ) : null}
      <View style={styles.titleRow}>
        <Text
          numberOfLines={1}
          style={[styles.title, theme.typography.feedRowTitle, { color: theme.colors.gray900 }]}
        >
          {isHeader ? name.toUpperCase() : name}
        </Text>
        {date ? (
          <Text
            numberOfLines={1}
            style={[
              isHeader ? theme.typography.captionStrong : theme.typography.overlineMedium,
              { color: theme.colors.gray600 },
            ]}
          >
            {date}
          </Text>
        ) : null}
      </View>
      {completion ? (
        <View style={styles.progressBlock}>
          <ProgressBar
            accessibilityLabel={`${completion.percent}% complete`}
            testID={testID ? `${testID}-progress` : undefined}
            value={completion.fraction}
          />
          <View style={styles.progressLabels}>
            <Text style={[theme.typography.overline, { color: theme.colors.gray600 }]}>
              {completionCountLabel(completion)}
            </Text>
            <Text style={[theme.typography.overline, { color: theme.colors.gray600 }]}>
              {`${completion.percent}%`}
            </Text>
          </View>
        </View>
      ) : null}
      {isHeader && totalValueLabel ? (
        <Text
          style={[theme.typography.overline, { color: theme.colors.gray900 }]}
          testID={testID ? `${testID}-total-value` : undefined}
        >
          {`TOTAL VALUE: ${totalValueLabel}`}
        </Text>
      ) : null}
    </>
  );

  const containerStyle = [
    styles.card,
    isHeader ? styles.headerCard : styles.listCard,
    { backgroundColor: theme.colors.gray0 },
    style,
  ];

  if (!onPress) {
    return (
      <View style={containerStyle} testID={testID}>
        {body}
      </View>
    );
  }

  return (
    <Pressable
      accessibilityLabel={name}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [...containerStyle, { opacity: pressed ? 0.88 : 1 }]}
      testID={testID}
    >
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    borderCurve: 'continuous',
    borderRadius: radii.lg,
    padding: spacing.md,
    width: '100%',
  },
  // Figma 6425:3325 lifts the header off the gradient with a soft shadow.
  headerCard: {
    ...shadows.card,
    gap: spacing.sm,
  },
  listCard: {
    gap: spacing.xs,
  },
  listLogo: {
    height: LIST_LOGO_HEIGHT,
    width: LIST_LOGO_WIDTH,
  },
  progressBlock: {
    gap: spacing.xxxs,
  },
  progressLabels: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  title: {
    flexShrink: 1,
  },
  titleRow: {
    alignItems: 'flex-end',
    flexDirection: 'row',
    gap: spacing.xxs,
    justifyContent: 'space-between',
  },
});
