import { StyleSheet, Text, View } from 'react-native';
import { EditPencil, MediaImage } from 'iconoir-react-native';

import type { CardTransactionKind, CardTransactionRecord } from '@spotlight/api-client';
import {
  IconButton,
  colors,
  textStyles,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { CachedImage, imageCachePolicy } from '@/components/cached-image';
import { formatCurrency } from '@/features/portfolio/components/portfolio-formatting';

// Display labels per Figma node 942-4174. Data kinds are unchanged; only the
// human-facing text differs (`bought` reads as "PURCHASED").
const kindLabel: Record<CardTransactionKind, string> = {
  bought: 'PURCHASED',
  sold: 'SOLD',
  traded: 'TRADED',
};

// Badge tone per design intent (Figma node 942-4174): PURCHASED green, SOLD
// red, TRADED blue — each a pale `*100` fill with a saturated `*400` label.
function kindBadgeTone(kind: CardTransactionKind, theme: ReturnType<typeof useSpotlightTheme>) {
  switch (kind) {
    case 'bought':
      return { background: theme.colors.green100, text: theme.colors.success };
    case 'traded':
      return { background: theme.colors.blue100, text: theme.colors.blue400 };
    case 'sold':
    default:
      return { background: theme.colors.red100, text: theme.colors.red400 };
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

type TransactionThumbProps = {
  photoUrl: string | null;
  testID?: string;
};

/**
 * Card-lot thumbnail. Renders the cached photo when present; otherwise shows a
 * centered image-placeholder glyph on the shared gray100 surface. Reused by the
 * row and the list-screen skeleton so the empty treatment stays uniform.
 */
export function TransactionThumb({ photoUrl, testID }: TransactionThumbProps) {
  const theme = useSpotlightTheme();

  if (photoUrl) {
    return (
      <CachedImage
        cachePolicy={imageCachePolicy.thumbnail}
        contentFit="cover"
        source={{ uri: photoUrl }}
        style={[styles.art, { backgroundColor: theme.colors.gray100 }]}
        testID={testID}
      />
    );
  }

  return (
    <View
      style={[styles.art, styles.artPlaceholder, { backgroundColor: theme.colors.gray100 }]}
      testID={testID}
    >
      <MediaImage color={theme.colors.gray400} height={24} width={24} />
    </View>
  );
}

type TransactionRowProps = {
  record: CardTransactionRecord;
  /**
   * When true, the row draws a top hairline as well — pass only for the first
   * row so adjacent rows share single 1px dividers instead of doubling them.
   */
  firstInList?: boolean;
  testID?: string;
};

export function TransactionRow({
  record,
  firstInList = false,
  testID,
}: TransactionRowProps) {
  const theme = useSpotlightTheme();
  const resolvedTestID = testID ?? `transaction-row-${record.id}`;
  const tone = kindBadgeTone(record.kind, theme);

  const priceText =
    record.amountCents != null
      ? formatCurrency(record.amountCents / 100, record.currencyCode)
      : record.kind === 'traded'
        ? 'Trade'
        : '—';

  return (
    <View style={styles.cardWrapper} testID={resolvedTestID}>
      <View style={[styles.card, firstInList ? styles.cardFirst : null]}>
        <View style={styles.leftGroup}>
          <TransactionThumb photoUrl={record.photoUrl} testID={`${resolvedTestID}-photo`} />
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
              style={[styles.itemsText, { color: theme.colors.gray800 }]}
              testID={`${resolvedTestID}-items`}
            >
              Items: {record.itemCount}
            </Text>
          </View>
        </View>
        <View style={styles.rightGroup}>
          <Text
            style={[theme.typography.titleSmall, styles.priceText, { color: theme.colors.gray900 }]}
            testID={`${resolvedTestID}-price`}
          >
            {priceText}
          </Text>
          <IconButton
            accessibilityLabel="Edit transaction"
            shape="rounded"
            size={28}
            style={styles.editButton}
            testID={`${resolvedTestID}-edit`}
            variant="ghost"
          >
            <EditPencil color={theme.colors.gray500} height={16} width={16} />
          </IconButton>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  cardWrapper: {
    backgroundColor: colors.gray0,
  },
  // Flat ruled row: white surface with gray100 hairlines. Each row draws a
  // single bottom hairline so adjacent rows share one 1px divider; only the
  // first row adds a top hairline (see `cardFirst`).
  card: {
    alignItems: 'center',
    backgroundColor: colors.gray0,
    borderBottomWidth: 1,
    borderColor: colors.gray100,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  cardFirst: {
    borderTopWidth: 1,
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
  artPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
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
  itemsText: {
    ...textStyles.overline,
  },
  rightGroup: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'flex-end',
    minWidth: 68,
  },
  priceText: {
    textAlign: 'right',
  },
  editButton: {
    borderWidth: 0,
  },
});
