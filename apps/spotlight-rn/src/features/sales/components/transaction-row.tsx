import { StyleSheet, Text, View } from 'react-native';
import { DataTransferBoth, MediaImage, Minus, Plus } from 'iconoir-react-native';

import type { CardTransactionKind, CardTransactionRecord } from '@spotlight/api-client';
import { colors, useSpotlightTheme } from '@spotlight/design-system';

import { CachedImage, imageCachePolicy } from '@/components/cached-image';
import { formatCurrency } from '@/features/portfolio/components/portfolio-formatting';
import { paymentMethodLabel } from '@/features/sales/payment-method';
import { useAuth } from '@/providers/auth-provider';

// Row title per Figma node 1313-7318: the data kind maps to a short verb.
const kindTitle: Record<CardTransactionKind, string> = {
  bought: 'Buy',
  sold: 'Sell',
  traded: 'Trade',
};

type TransactionThumbProps = {
  photoUrl: string | null;
  /** Card image carried from the source card; used when no captured photo exists. */
  imageUrl?: string | null;
  testID?: string;
};

/**
 * Card-lot thumbnail. Renders the cached image when present (prefers the
 * captured photo, falls back to the source card image); otherwise shows a
 * centered image-placeholder glyph on the shared gray100 surface. Reused by the
 * row and the list-screen skeleton so the empty treatment stays uniform.
 */
export function TransactionThumb({ photoUrl, imageUrl, testID }: TransactionThumbProps) {
  const theme = useSpotlightTheme();
  const { accessToken } = useAuth();

  // Prefer the captured photo, fall back to the source card image. The captured
  // photo is served from our own authenticated backend endpoint
  // (`/api/v1/card-transactions/{id}/photo`), so expo-image must send the bearer
  // token or the request 401s and the tile renders as a blank gray box. The
  // fallback `imageUrl` is a public CDN URL and must NOT carry the token.
  const usingPhotoUrl = photoUrl != null;
  const displayUrl = photoUrl ?? imageUrl ?? null;

  if (displayUrl) {
    const needsAuthHeader =
      usingPhotoUrl && accessToken != null && /^https?:/i.test(displayUrl);
    const source = needsAuthHeader
      ? { uri: displayUrl, headers: { Authorization: `Bearer ${accessToken}` } }
      : { uri: displayUrl };

    return (
      <CachedImage
        cachePolicy={imageCachePolicy.thumbnail}
        contentFit="cover"
        source={source}
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
      <MediaImage color={theme.colors.gray400} height={20} width={20} />
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

  const itemLabel = `${record.itemCount} ${record.itemCount === 1 ? 'Item' : 'Items'}`;
  const subtitle = record.paymentMethod
    ? `${itemLabel} · ${paymentMethodLabel(record.paymentMethod)}`
    : itemLabel;

  // Buy reads as money out (red, minus), Sell as money in (green, plus); a trade
  // moves no money, so it shows the swap glyph and no amount (Figma 1313-7318).
  const amountText =
    record.amountCents != null
      ? formatCurrency(record.amountCents / 100, record.currencyCode)
      : '—';

  return (
    <View style={styles.cardWrapper} testID={resolvedTestID}>
      <View style={[styles.card, firstInList ? styles.cardFirst : null]}>
        <View style={styles.leftGroup}>
          <TransactionThumb
            imageUrl={record.imageUrl}
            photoUrl={record.photoUrl}
            testID={`${resolvedTestID}-photo`}
          />
          <View style={styles.textColumn}>
            <Text
              numberOfLines={1}
              style={[theme.typography.titleSmall, { color: theme.colors.gray900 }]}
              testID={`${resolvedTestID}-title`}
            >
              {kindTitle[record.kind]}
            </Text>
            <Text
              numberOfLines={1}
              style={[theme.typography.label, { color: theme.colors.gray500 }]}
              testID={`${resolvedTestID}-subtitle`}
            >
              {subtitle}
            </Text>
          </View>
        </View>
        <View style={styles.priceContainer} testID={`${resolvedTestID}-price`}>
          {record.kind === 'traded' ? (
            <DataTransferBoth color={theme.colors.gray900} height={20} width={20} />
          ) : record.kind === 'bought' ? (
            <>
              <Minus color={theme.colors.red500} height={20} width={20} />
              <Text
                style={[theme.typography.titleSmall, styles.amount, { color: theme.colors.red500 }]}
                testID={`${resolvedTestID}-amount`}
              >
                {amountText}
              </Text>
            </>
          ) : (
            <>
              <Plus color={theme.colors.green500} height={20} width={20} />
              <Text
                style={[theme.typography.titleSmall, styles.amount, { color: theme.colors.green500 }]}
                testID={`${resolvedTestID}-amount`}
              >
                {amountText}
              </Text>
            </>
          )}
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
    gap: 12,
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
    gap: 12,
    minWidth: 0,
  },
  art: {
    borderRadius: 6,
    height: 64,
    width: 64,
  },
  artPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  textColumn: {
    flex: 1,
    gap: 4,
    minWidth: 0,
  },
  priceContainer: {
    alignItems: 'center',
    flexDirection: 'row',
    flexShrink: 0,
    gap: 2,
  },
  amount: {
    textAlign: 'right',
  },
});
