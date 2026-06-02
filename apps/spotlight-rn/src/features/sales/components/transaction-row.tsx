import { StyleSheet, Text, View } from 'react-native';

import type { CardTransactionKind, CardTransactionRecord } from '@spotlight/api-client';
import {
  colors,
  textStyles,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { CachedImage, imageCachePolicy } from '@/components/cached-image';
import { formatCurrency } from '@/features/portfolio/components/portfolio-formatting';

const kindLabel: Record<CardTransactionKind, string> = {
  bought: 'Bought',
  sold: 'Sold',
  traded: 'Traded',
};

function kindBadgeTone(kind: CardTransactionKind) {
  switch (kind) {
    case 'bought':
      return { background: 'rgba(184, 154, 51, 0.16)', text: colors.info };
    case 'traded':
      return { background: 'rgba(254, 227, 51, 0.24)', text: colors.gray900 };
    case 'sold':
    default:
      return { background: 'rgba(45, 187, 109, 0.16)', text: colors.success };
  }
}

function formatOccurredAt(isoText: string) {
  const parsed = new Date(isoText);
  if (Number.isNaN(parsed.getTime())) {
    return isoText;
  }

  return parsed.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function formatTransactionActionLabel(record: CardTransactionRecord) {
  const verb = kindLabel[record.kind];
  if (record.occurredAtLabel) {
    // Normalize the verb so it always matches the kind, regardless of the
    // backend-provided label prefix.
    const dateOnly = record.occurredAtLabel.replace(/^(Bought|Sold|Traded) on\s+/i, '');
    return `${verb} on ${dateOnly}`;
  }

  return `${verb} on ${formatOccurredAt(record.occurredAt)}`;
}

type TransactionRowProps = {
  record: CardTransactionRecord;
  testID?: string;
};

export function TransactionRow({
  record,
  testID,
}: TransactionRowProps) {
  const theme = useSpotlightTheme();
  const resolvedTestID = testID ?? `transaction-row-${record.id}`;
  const tone = kindBadgeTone(record.kind);

  return (
    <View style={styles.cardWrapper} testID={resolvedTestID}>
      <View style={styles.card}>
        <View style={styles.leftGroup}>
          <CachedImage
            cachePolicy={imageCachePolicy.thumbnail}
            contentFit="cover"
            source={record.photoUrl ? { uri: record.photoUrl } : undefined}
            style={[styles.art, { backgroundColor: theme.colors.gray100 }]}
            testID={`${resolvedTestID}-photo`}
          />
          <View style={styles.textColumn}>
            <View
              style={[styles.kindBadge, { backgroundColor: tone.background }]}
              testID={`${resolvedTestID}-kind-badge`}
            >
              <Text style={[textStyles.overline, styles.kindBadgeLabel, { color: tone.text }]}>
                {kindLabel[record.kind]}
              </Text>
            </View>
            <Text
              numberOfLines={1}
              style={[styles.dateText, { color: theme.colors.gray800 }]}
            >
              {formatTransactionActionLabel(record)}
            </Text>
          </View>
        </View>
        <View style={styles.priceColumn}>
          <Text
            style={[theme.typography.titleSmall, styles.priceText, { color: theme.colors.gray900 }]}
            testID={`${resolvedTestID}-price`}
          >
            {formatCurrency(record.amountCents / 100, record.currencyCode)}
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  cardWrapper: {
    backgroundColor: colors.gray0,
  },
  // Flat ruled row matching the memory-bank list: white surface with top and
  // bottom gray100 hairlines so rows stack into one continuous ruled list.
  card: {
    alignItems: 'center',
    backgroundColor: colors.gray0,
    borderBottomWidth: 1,
    borderColor: colors.gray100,
    borderTopWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  leftGroup: {
    alignItems: 'center',
    flex: 1,
    flexDirection: 'row',
    gap: 16,
    minWidth: 0,
  },
  art: {
    borderRadius: 6,
    height: 78,
    width: 54,
  },
  textColumn: {
    flex: 1,
    gap: 8,
    minWidth: 0,
  },
  kindBadge: {
    alignSelf: 'flex-start',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  kindBadgeLabel: {
    letterSpacing: 0.6,
  },
  dateText: {
    ...textStyles.overline,
  },
  priceColumn: {
    alignItems: 'flex-end',
    justifyContent: 'center',
    minWidth: 68,
  },
  priceText: {
    textAlign: 'right',
  },
});
