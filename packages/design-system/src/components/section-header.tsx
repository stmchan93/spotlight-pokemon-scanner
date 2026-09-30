import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Text } from './scaled-text';
import { useSpotlightTheme } from '../theme';
import { radii, spacing } from '../tokens';

type SectionHeaderProps = {
  actionLabel?: string;
  actionTestID?: string;
  countText?: string;
  expanded?: boolean;
  onActionPress?: () => void;
  onPress?: () => void;
  /**
   * `default` = 25px display title for top-level page sections.
   * `compact` = Figma Title-small (17/600) for a heading INSIDE a page, e.g. the
   * Watchlist's Deals band; its count drops to `captionMedium` and sits on the
   * title's baseline.
   */
  size?: 'default' | 'compact';
  subtitle?: string;
  testID?: string;
  title: string;
  /** Small status mark (e.g. an unread dot) between the title and the count, vertically centred. */
  titleAccessory?: ReactNode;
};

function ChevronGlyph({
  expanded = false,
  testID,
}: {
  expanded?: boolean;
  testID?: string;
}) {
  return (
    <View style={styles.chevronFrame} testID={testID}>
      <View style={[styles.chevronInner, expanded ? styles.chevronInnerExpanded : null]}>
        <View style={[styles.chevronStem, styles.chevronStemLeft]} />
        <View style={[styles.chevronStem, styles.chevronStemRight]} />
      </View>
    </View>
  );
}

export function SectionHeader({
  actionLabel,
  actionTestID,
  countText,
  expanded,
  onActionPress,
  onPress,
  size = 'default',
  subtitle,
  testID,
  title,
  titleAccessory,
}: SectionHeaderProps) {
  const theme = useSpotlightTheme();
  const hasChevron = typeof onPress === 'function';
  const headerCopyGap = subtitle ? theme.layout.titleBodyGap : 0;
  const compact = size === 'compact';

  const titleBlock = (
    <View style={[styles.copy, { gap: headerCopyGap }]}>
      <View
        style={[styles.titleRow, compact ? styles.titleRowCompact : null]}
        testID={testID ? `${testID}-title-row` : undefined}
      >
        <Text
          style={compact ? theme.typography.titleSmall : theme.typography.title}
          testID={testID ? `${testID}-title` : undefined}
        >
          {title}
        </Text>
        {titleAccessory ? <View style={styles.centeredSlot}>{titleAccessory}</View> : null}
        {countText ? (
          <Text
            style={
              compact
                ? [theme.typography.captionMedium, { color: theme.colors.gray600 }]
                : [theme.typography.bodyStrong, styles.countText, { color: theme.colors.textSecondary }]
            }
            testID={testID ? `${testID}-count` : undefined}
          >
            {countText}
          </Text>
        ) : null}
        {hasChevron ? (
          <View
            style={[styles.chevronSlot, styles.centeredSlot]}
            testID={testID ? `${testID}-chevron-slot` : undefined}
          >
            <ChevronGlyph
              expanded={expanded}
              testID={testID ? `${testID}-chevron-glyph` : undefined}
            />
          </View>
        ) : null}
      </View>
      {subtitle ? (
        <Text style={[theme.typography.body, { color: theme.colors.textSecondary }]}>
          {subtitle}
        </Text>
      ) : null}
    </View>
  );

  return (
    <View style={styles.headerRow}>
      {hasChevron ? (
        <Pressable accessibilityRole="button" onPress={onPress} style={styles.leftHeader} testID={testID}>
          {titleBlock}
        </Pressable>
      ) : (
        <View style={styles.leftHeader} testID={testID}>
          {titleBlock}
        </View>
      )}

      {actionLabel && onActionPress ? (
        <Pressable
          accessibilityRole="button"
          onPress={onActionPress}
          style={({ pressed }) => [
            styles.headerAction,
            {
              opacity: pressed ? 0.7 : 1,
            },
          ]}
          testID={actionTestID}
        >
          <Text style={[theme.typography.control, { color: theme.colors.textPrimary }]}>{actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // Non-text children have no baseline; keep them centred in a baseline row.
  centeredSlot: {
    alignSelf: 'center',
  },
  chevronFrame: {
    alignItems: 'center',
    height: 14,
    justifyContent: 'center',
    width: 14,
  },
  chevronInner: {
    height: 8,
    position: 'relative',
    width: 12,
  },
  chevronInnerExpanded: {
    transform: [{ rotate: '180deg' }],
  },
  chevronStem: {
    backgroundColor: 'rgba(15, 15, 18, 0.58)',
    borderCurve: 'continuous',
    borderRadius: radii.pill,
    height: 2.2,
    position: 'absolute',
    top: 2.5,
    width: 7,
  },
  chevronStemLeft: {
    left: 0,
    transform: [{ rotate: '45deg' }],
  },
  chevronStemRight: {
    right: 0,
    transform: [{ rotate: '-45deg' }],
  },
  chevronSlot: {
    alignItems: 'center',
    height: 16,
    justifyContent: 'center',
    width: 16,
  },
  copy: {
    flex: 1,
  },
  countText: {
    marginTop: 1,
  },
  headerAction: {
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 6,
    minHeight: 24,
  },
  headerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  leftHeader: {
    flex: 1,
    paddingRight: spacing.xs,
  },
  titleRow: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    flexDirection: 'row',
    gap: 6,
  },
  // Mixed type sizes: share a baseline rather than a vertical centre.
  titleRowCompact: {
    alignItems: 'baseline',
  },
});
