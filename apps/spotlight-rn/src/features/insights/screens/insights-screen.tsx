import { useCallback, useEffect, useState } from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import {
  Cart,
  DataTransferBoth,
  DollarCircle,
  GraphUp,
  Heart,
  NavArrowLeft,
  ScanQrCode,
  ShareIos,
} from 'iconoir-react-native';

import type {
  CardTransactionRecord,
  InsightGrowthCard,
  TransactionInsights,
} from '@spotlight/api-client';
import { colors, textStyles, useSpotlightTheme } from '@spotlight/design-system';

import { CachedImage, imageCachePolicy } from '@/components/cached-image';
import { formatOptionalCurrency } from '@/features/portfolio/components/portfolio-formatting';
import { paymentMethodLabel } from '@/features/sales/payment-method';
import { useTabBarScrollHandler } from '@/contexts/tab-bar-chrome-context';
import { useAppServices } from '@/providers/app-providers';
import { AppBottomTabBar } from '@/components/app-bottom-tab-bar';

function slugify(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

const currentMonthName = new Date()
  .toLocaleDateString('en-US', { month: 'long' })
  .toUpperCase();

export function InsightsScreen() {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const handleTabBarScroll = useTabBarScrollHandler();
  const { spotlightRepository, dataVersion } = useAppServices();
  const { width: windowWidth } = useWindowDimensions();

  const [insights, setInsights] = useState<TransactionInsights | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await spotlightRepository.loadTransactionInsights();
      setInsights(result);
    } catch {
      // Keep the last value; the refresh control + next focus will retry.
    }
  }, [spotlightRepository]);

  useEffect(() => {
    void load();
  }, [load, dataVersion]);

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    await load();
    setIsRefreshing(false);
  }, [load]);

  const handleBack = useCallback(() => {
    router.back();
  }, [router]);

  const handleShare = useCallback(() => {
    void Share.share({ message: 'My Ekalight insights' });
  }, []);

  const bottomNavClearance =
    theme.layout.bottomNavHeight
    + theme.layout.bottomNavBottomInset
    + Math.max(insets.bottom - 8, 0);

  const currencyCode = insights?.currencyCode ?? 'USD';

  // Paging carousel that lets the next growth card peek (Figma node 863-3255).
  const growthCardGap = 16;
  const growthCardPeek = 56;
  const growthCardWidth = Math.max(
    240,
    windowWidth - theme.layout.pageGutter * 2 - growthCardPeek,
  );

  const topGrowth = insights?.topGrowth ?? [];

  return (
    <SafeAreaView
      edges={['top', 'left', 'right']}
      style={[styles.safeArea, { backgroundColor: colors.gray0 }]}
    >
      <View
        style={[
          styles.headerRow,
          {
            paddingHorizontal: theme.layout.pageGutter,
            paddingTop: theme.layout.pageTopInset,
          },
        ]}
      >
        <Pressable
          accessibilityLabel="Go back"
          accessibilityRole="button"
          hitSlop={12}
          onPress={handleBack}
          style={styles.headerButton}
          testID="insights-header-back"
        >
          <NavArrowLeft color={colors.gray900} height={24} width={24} />
        </Pressable>
        <Text style={styles.headerTitle} testID="insights-header-title">
          Insights
        </Text>
        <Pressable
          accessibilityLabel="Share insights"
          accessibilityRole="button"
          hitSlop={12}
          onPress={handleShare}
          style={styles.headerButton}
          testID="insights-header-share"
        >
          <ShareIos color={colors.gray900} height={20} width={20} />
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          { paddingBottom: bottomNavClearance + 24 },
        ]}
        onScroll={handleTabBarScroll}
        scrollEventThrottle={16}
        refreshControl={(
          <RefreshControl
            onRefresh={handleRefresh}
            refreshing={isRefreshing}
            testID="insights-refresh-control"
            tintColor={theme.colors.gray400}
          />
        )}
        testID="insights-scroll"
      >
        {/* Monthly highlights eyebrow + big month name. */}
        <View style={styles.monthBlock}>
          <Text style={styles.monthEyebrow} testID="insights-month-eyebrow">
            Monthly Highlights
          </Text>
          <Text style={styles.monthName} testID="insights-month-name">
            {currentMonthName}
          </Text>
        </View>

        {/* Top-growth carousel. */}
        {topGrowth.length > 0 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            decelerationRate="fast"
            snapToInterval={growthCardWidth + growthCardGap}
            snapToAlignment="start"
            contentContainerStyle={{
              gap: growthCardGap,
              paddingHorizontal: theme.layout.pageGutter,
            }}
            testID="insights-growth-carousel"
          >
            {topGrowth.map((card, index) => (
              <GrowthCard
                key={card.cardId}
                card={card}
                index={index}
                width={growthCardWidth}
              />
            ))}
          </ScrollView>
        ) : (
          <View style={styles.section}>
            <EmptyTile text="Your biggest monthly gainers will show up here." />
          </View>
        )}

        {/* "Here's how you did" stat list. */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Here&apos;s how you did</Text>
          <View>
            <StatRow
              icon={<GraphUp color={colors.gray900} height={18} width={18} />}
              label="Total Portfolio Value"
              value={formatOptionalCurrency(
                (insights?.totalPortfolioValueCents ?? 0) / 100,
                currencyCode,
              )}
              first
            />
            <StatRow
              icon={<ScanQrCode color={colors.gray900} height={18} width={18} />}
              label="Scanned"
              value={(insights?.scannedCount ?? 0).toLocaleString('en-US')}
            />
            <StatRow
              icon={<Heart color={colors.gray900} height={18} width={18} />}
              label="Wishlisted"
              value={(insights?.wishlistedCount ?? 0).toLocaleString('en-US')}
            />
            <StatRow
              icon={<Cart color={colors.gray900} height={18} width={18} />}
              label="Bought"
              value={String(insights?.allTime.bought.count ?? 0)}
            />
            <StatRow
              icon={<DollarCircle color={colors.gray900} height={18} width={18} />}
              label="Sold"
              value={String(insights?.allTime.sold.count ?? 0)}
            />
            <StatRow
              icon={<DataTransferBoth color={colors.gray900} height={18} width={18} />}
              label="Traded"
              value={String(insights?.allTime.traded.count ?? 0)}
            />
          </View>
        </View>

        {/* Biggest sale highlight. */}
        <View style={styles.section}>
          {insights?.biggestSale ? (
            <BiggestTransaction
              record={insights.biggestSale}
              title="Biggest Sale"
              currencyCode={currencyCode}
              testID="insights-biggest-sale"
            />
          ) : (
            <EmptyTile text="Your biggest sale will show up here." />
          )}
        </View>

        {/* Biggest purchase highlight. */}
        <View style={styles.section}>
          {insights?.biggestPurchase ? (
            <BiggestTransaction
              record={insights.biggestPurchase}
              title="Biggest Purchase"
              currencyCode={currencyCode}
              testID="insights-biggest-purchase"
            />
          ) : (
            <EmptyTile text="Your biggest purchase will show up here." />
          )}
        </View>
      </ScrollView>

      <AppBottomTabBar activeKey="portfolio" />
    </SafeAreaView>
  );
}

function GrowthCard({
  card,
  index,
  width,
}: {
  card: InsightGrowthCard;
  index: number;
  width: number;
}) {
  const isUp = card.changeAmountCents >= 0;
  const changeColor = isUp ? colors.deltaUpText : colors.deltaDownText;
  const sign = isUp ? '+' : '-';
  const amount = formatOptionalCurrency(
    Math.abs(card.changeAmountCents) / 100,
    card.currencyCode,
  );
  const changeText = `${sign}${amount} (${sign}${Math.abs(card.changePct).toFixed(2)}%)`;

  return (
    <View style={{ width }} testID={`insights-growth-card-${index}`}>
      <View style={styles.growthImageWrap}>
        {card.imageUrl ? (
          <CachedImage
            cachePolicy={imageCachePolicy.thumbnail}
            contentFit="contain"
            style={styles.growthImage}
            uri={card.imageUrl}
          />
        ) : (
          <View style={styles.growthImage} />
        )}
      </View>
      <Text style={styles.growthRank}>{`#${index + 1} Highest Growth`}</Text>
      <Text numberOfLines={1} style={styles.growthName}>
        {card.name}
      </Text>
      <Text style={[styles.growthChange, { color: changeColor }]}>
        {changeText}
      </Text>
    </View>
  );
}

function StatRow({
  icon,
  label,
  value,
  first = false,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  first?: boolean;
}) {
  return (
    <View
      style={[styles.statRow, first ? styles.statRowFirst : null]}
      testID={`insights-stat-${slugify(label)}`}
    >
      <View style={styles.statRowLeft}>
        <View style={styles.statIcon}>{icon}</View>
        <Text style={styles.statLabel}>{label}</Text>
      </View>
      <Text style={styles.statValue} testID={`insights-stat-${slugify(label)}-value`}>
        {value}
      </Text>
    </View>
  );
}

function BiggestTransaction({
  record,
  title,
  currencyCode,
  testID,
}: {
  record: CardTransactionRecord;
  title: string;
  currencyCode: string;
  testID: string;
}) {
  const imageUri = record.photoUrl ?? record.imageUrl ?? null;
  const dateLabel =
    record.occurredAtLabel
    ?? new Date(record.occurredAt).toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
    });
  const amountText = `+${formatOptionalCurrency(
    (record.amountCents ?? 0) / 100,
    record.currencyCode || currencyCode,
  )}`;
  const itemLabel = `${record.itemCount} ${record.itemCount === 1 ? 'item' : 'items'}`;
  const caption = record.paymentMethod
    ? `${itemLabel} · ${paymentMethodLabel(record.paymentMethod)}`
    : itemLabel;

  return (
    <View testID={testID}>
      <View style={styles.bigImageWrap}>
        {imageUri ? (
          <CachedImage
            cachePolicy={imageCachePolicy.hero}
            contentFit="cover"
            style={styles.bigImage}
            uri={imageUri}
          />
        ) : (
          <View style={styles.bigImage} />
        )}
      </View>
      <View style={styles.bigFooter}>
        <View style={styles.bigFooterLeft}>
          <Text style={styles.bigTitle}>{title}</Text>
          <Text style={styles.bigCaption}>{dateLabel}</Text>
        </View>
        <View style={styles.bigFooterRight}>
          <Text
            style={[styles.bigAmount, { color: colors.deltaUpText }]}
            testID={`${testID}-amount`}
          >
            {amountText}
          </Text>
          <Text style={styles.bigCaption}>{caption}</Text>
        </View>
      </View>
    </View>
  );
}

function EmptyTile({ text }: { text: string }) {
  return (
    <View style={styles.emptyTile}>
      <Text style={styles.emptyTileText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  headerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  headerButton: {
    alignItems: 'center',
    backgroundColor: colors.gray50,
    borderRadius: 18,
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  headerTitle: {
    ...textStyles.titleMedium,
    color: colors.gray900,
    flex: 1,
    textAlign: 'center',
  },
  scrollContent: {
    gap: 28,
    paddingTop: 12,
  },
  monthBlock: {
    gap: 4,
    paddingHorizontal: 16,
  },
  monthEyebrow: {
    ...textStyles.overline,
    color: colors.gray500,
    textTransform: 'uppercase',
  },
  monthName: {
    ...textStyles.display,
    color: colors.gray900,
  },
  growthImageWrap: {
    alignItems: 'center',
    aspectRatio: 1,
    backgroundColor: colors.gray50,
    borderRadius: 16,
    justifyContent: 'center',
    overflow: 'hidden',
    padding: 12,
    width: '100%',
  },
  growthImage: {
    height: '100%',
    width: '100%',
  },
  growthRank: {
    ...textStyles.captionMedium,
    color: colors.gray500,
    marginTop: 12,
  },
  growthName: {
    ...textStyles.titleMedium,
    color: colors.gray900,
    marginTop: 2,
  },
  growthChange: {
    ...textStyles.captionMedium,
    marginTop: 2,
  },
  section: {
    gap: 12,
    paddingHorizontal: 16,
  },
  sectionTitle: {
    ...textStyles.titleMedium,
    color: colors.gray900,
  },
  statRow: {
    alignItems: 'center',
    borderBottomWidth: 1,
    borderColor: colors.gray100,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 14,
  },
  statRowFirst: {
    borderTopWidth: 1,
  },
  statRowLeft: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    minWidth: 0,
  },
  statIcon: {
    alignItems: 'center',
    height: 22,
    justifyContent: 'center',
    width: 22,
  },
  statLabel: {
    ...textStyles.bodyMedium,
    color: colors.gray900,
  },
  statValue: {
    ...textStyles.bodyMedium,
    color: colors.gray900,
    textAlign: 'right',
  },
  bigImageWrap: {
    aspectRatio: 1,
    backgroundColor: colors.gray50,
    borderRadius: 16,
    overflow: 'hidden',
    width: '100%',
  },
  bigImage: {
    height: '100%',
    width: '100%',
  },
  bigFooter: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 12,
  },
  bigFooterLeft: {
    flex: 1,
    gap: 2,
    minWidth: 0,
  },
  bigFooterRight: {
    alignItems: 'flex-end',
    flexShrink: 0,
    gap: 2,
  },
  bigTitle: {
    ...textStyles.titleMedium,
    color: colors.gray900,
  },
  bigAmount: {
    ...textStyles.titleMedium,
  },
  bigCaption: {
    ...textStyles.captionMedium,
    color: colors.gray500,
  },
  emptyTile: {
    backgroundColor: colors.gray50,
    borderRadius: 12,
    padding: 16,
  },
  emptyTileText: {
    ...textStyles.bodyMedium,
    color: colors.gray600,
  },
});
