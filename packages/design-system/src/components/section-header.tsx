import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useSpotlightTheme } from '../theme';

type SectionHeaderProps = {
  actionLabel?: string;
  actionTestID?: string;
  countText?: string;
  expanded?: boolean;
  onActionPress?: () => void;
  onPress?: () => void;
  subtitle?: string;
  testID?: string;
  title: string;
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
  subtitle,
  testID,
  title,
}: SectionHeaderProps) {
  const theme = useSpotlightTheme();
  const hasChevron = typeof onPress === 'function';
  const headerCopyGap = subtitle ? theme.layout.titleBodyGap : 0;

  const titleBlock = (
    <View style={[styles.copy, { gap: headerCopyGap }]}>
      <View style={styles.titleRow}>
        <Text style={theme.typography.title}>{title}</Text>
        {countText ? (
          <Text style={[theme.typography.bodyStrong, styles.countText, { color: theme.colors.textSecondary }]}>
            {countText}
          </Text>
        ) : null}
        {hasChevron ? (
          <View
            style={styles.chevronSlot}
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
    borderRadius: 999,
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
    paddingRight: 12,
  },
  titleRow: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    flexDirection: 'row',
    gap: 6,
  },
});
