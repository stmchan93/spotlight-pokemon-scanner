import { useMemo, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { GraphDown, GraphUp, NavArrowDown, NavArrowRight } from 'iconoir-react-native';

import {
  gameDisplayName,
  type CardGame,
  type MarketCardTile,
  type MarketAnalytics,
  type MarketWindow,
  type MarketBargain,
  type MarketBreakout,
  type MarketGradingPick,
  type MarketSetMove,
} from '@spotlight/api-client';
import {
  borderWidths,
  OwnedTag,
  PricePositionBar,
  PriceSparkline,
  radii,
  SkeletonBlock,
  spacing,
  Text,
  textStyles,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { PageSwipeGuard } from '@/components/page-tab-pager';
import { PriceScrubChart, type PriceChartPoint } from '@/features/cards/components/price-scrub-chart';
import { formatSignedPercent } from '@/features/meta-feed/screens/components/meta-format';
import { formatAbbreviatedCurrency, formatCurrency } from '@/features/portfolio/components/portfolio-formatting';

export const WINDOW_OPTIONS: readonly { label: string; value: MarketWindow }[] = [
  { label: '7D', value: '7d' },
  { label: '1M', value: '30d' },
  { label: '3M', value: '90d' },
];

const PULSE_CHART_HEIGHT = 132;
const CARD_TILE_WIDTH = 128;
const CARD_ART_HEIGHT = Math.round((CARD_TILE_WIDTH * 342) / 245);
const SET_TILE_WIDTH = 148;
const SET_LOGO_HEIGHT = 36;
const ROW_THUMB_WIDTH = 46;
const ROW_THUMB_HEIGHT = 64;
const SPARK_WIDTH = 56;
const SPARK_HEIGHT = 20;
const ICON_SIZE = 18;
const BREADTH_BAR_HEIGHT = 6;
// The Bargain board's own wording for "bottom of its range".
const NEAR_LOW_PERCENTILE = 20;

/** "+3.2%" / "−1.4%"; "—" when the backend had no comparable history. */
export function formatChange(changePct: number | null | undefined) {
  return changePct == null ? '—' : formatSignedPercent(changePct);
}

function changeWords(changePct: number | null | undefined) {
  if (changePct == null) {
    return 'no change data';
  }
  return Math.abs(changePct) < 0.05 ? 'flat' : `${changePct > 0 ? 'up' : 'down'} ${Math.abs(changePct).toFixed(1)} percent`;
}

export function changeColor(theme: ReturnType<typeof useSpotlightTheme>, changePct: number | null | undefined) {
  if (changePct == null || Math.abs(changePct) < 0.05) {
    return theme.colors.gray600;
  }
  return changePct > 0 ? theme.colors.green500 : theme.colors.red500;
}

/** "+$412" / "−$38" with whole dollars. */
function formatSignedWholeUsd(value: number) {
  const whole = formatCurrency(Math.abs(Math.round(value))).replace(/\.00$/, '');
  return `${value >= 0 ? '+' : '−'}${whole}`;
}

/** Window labels arrive lowercase ("past 30 days"); sentence-case them where they lead. */
export function capitalize(text: string) {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

// --- chrome ------------------------------------------------------------------

/** Game name + chevron; opens the game sheet (the Insights header pattern). */
export function GamePickerButton({ game, onPress, testID }: { game: CardGame; onPress: () => void; testID: string }) {
  const theme = useSpotlightTheme();
  return (
    <Pressable
      accessibilityHint="Choose which game's market to show"
      accessibilityLabel={`Game: ${gameDisplayName(game)}`}
      accessibilityRole="button"
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => [styles.gamePicker, { opacity: pressed ? 0.6 : 1 }]}
      testID={testID}
    >
      <Text style={[theme.typography.titleSmall, { color: theme.colors.gray900 }]}>
        {gameDisplayName(game).toUpperCase()}
      </Text>
      <NavArrowDown color={theme.colors.gray900} height={ICON_SIZE} strokeWidth={2} width={ICON_SIZE} />
    </Pressable>
  );
}

/** 7D / 1M / 3M — the Collection chart's range pills (Figma 5938:21789). */
export function WindowToggle({
  value,
  onChange,
  testID,
}: {
  value: MarketWindow;
  onChange: (value: MarketWindow) => void;
  testID: string;
}) {
  const theme = useSpotlightTheme();
  return (
    <View accessibilityRole="tablist" style={styles.windowRow} testID={testID}>
      {WINDOW_OPTIONS.map((item) => {
        const selected = item.value === value;
        return (
          <Pressable
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            key={item.value}
            onPress={() => onChange(item.value)}
            style={({ pressed }) => [
              styles.windowPill,
              selected ? { backgroundColor: theme.colors.gray100 } : null,
              pressed ? { opacity: 0.88 } : null,
            ]}
            testID={`${testID}-${item.value}`}
          >
            <Text style={[styles.windowLabel, { color: selected ? theme.colors.gray900 : theme.colors.gray700 }]}>
              {item.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function MarketSectionTitle({
  title,
  caption,
  icon,
  testID,
}: {
  title: string;
  caption?: string | null;
  icon?: ReactNode;
  testID?: string;
}) {
  const theme = useSpotlightTheme();
  return (
    <View style={styles.sectionTitle} testID={testID}>
      <View style={styles.sectionTitleRow}>
        <Text style={[theme.typography.titleSmall, { color: theme.colors.gray900 }]}>{title.toUpperCase()}</Text>
        {icon}
      </View>
      {caption ? (
        <Text style={[theme.typography.caption, { color: theme.colors.gray600 }]}>{caption}</Text>
      ) : null}
    </View>
  );
}

export function SectionEmpty({ message, testID }: { message: string; testID: string }) {
  const theme = useSpotlightTheme();
  return (
    <Text style={[theme.typography.label, styles.gutter, { color: theme.colors.gray500 }]} testID={testID}>
      {message}
    </Text>
  );
}

export function SectionBand({ testID }: { testID?: string }) {
  const theme = useSpotlightTheme();
  return <View style={{ backgroundColor: theme.colors.gray50, height: borderWidths.sectionBand }} testID={testID} />;
}

function Rail({ children, testID }: { children: ReactNode; testID: string }) {
  return (
    <PageSwipeGuard>
      <ScrollView
        contentContainerStyle={styles.rail}
        horizontal
        showsHorizontalScrollIndicator={false}
        testID={testID}
      >
        {children}
      </ScrollView>
    </PageSwipeGuard>
  );
}

function CardArt({ card, height = CARD_ART_HEIGHT, width = CARD_TILE_WIDTH }: { card: MarketCardTile; height?: number; width?: number }) {
  const theme = useSpotlightTheme();
  return (
    <View
      style={[
        styles.art,
        { backgroundColor: theme.colors.gray100, height, width },
      ]}
    >
      {card.imageUrl ? (
        <ExpoImage
          accessibilityIgnoresInvertColors
          cachePolicy="memory-disk"
          contentFit="cover"
          source={{ uri: card.imageUrl }}
          style={StyleSheet.absoluteFill}
        />
      ) : null}
    </View>
  );
}

// --- 1. pulse ----------------------------------------------------------------

export function MarketPulseSection({
  data,
  isGuest,
  testID,
}: {
  data: MarketAnalytics;
  isGuest: boolean;
  testID: string;
}) {
  const theme = useSpotlightTheme();
  const { pulse, you } = data;
  const [scrubIndex, setScrubIndex] = useState<number | null>(null);
  const points = useMemo<PriceChartPoint[]>(
    () => pulse.sparkline.map((point) => ({ t: Date.parse(`${point.date}T00:00:00Z`), v: point.value }))
      .filter((point) => Number.isFinite(point.t)),
    [pulse.sparkline],
  );
  const scrubbed = scrubIndex != null ? data.pulse.sparkline[scrubIndex] : null;
  const total = pulse.breadth.up + pulse.breadth.down + pulse.breadth.flat;
  const downPct = total > 0 ? Math.round((pulse.breadth.down / total) * 100) : 0;
  const upPct = Math.round(pulse.breadth.upPct ?? (total > 0 ? (pulse.breadth.up / total) * 100 : 0));
  const showYou = !isGuest && you != null;

  return (
    <View style={styles.pulse} testID={testID}>
      <View style={styles.gutter}>
        <Text style={[theme.typography.overline, { color: theme.colors.gray600 }]}>
          {`${gameDisplayName(data.game).toUpperCase()} MARKET`}
        </Text>
        <Text
          accessibilityLabel={`Market ${changeWords(pulse.changePct)}, ${data.windowLabel}`}
          style={[theme.typography.display, { color: changeColor(theme, pulse.changePct) }]}
          testID={`${testID}-change`}
        >
          {formatChange(pulse.changePct)}
        </Text>
        <Text style={[theme.typography.caption, { color: theme.colors.gray600 }]} testID={`${testID}-subline`}>
          {scrubbed
            ? `${scrubbed.date} · ${formatAbbreviatedCurrency(scrubbed.value)} tracked value`
            : [capitalize(data.windowLabel), pulse.indexValueUsd != null ? `${formatAbbreviatedCurrency(pulse.indexValueUsd)} tracked value` : null]
              .filter(Boolean).join(' · ')}
        </Text>
      </View>

      {points.length >= 2 ? (
        <PageSwipeGuard testID={`${testID}-chart-guard`}>
          <PriceScrubChart
            areaFill
            color={theme.colors.purple500}
            fillGrid={false}
            height={PULSE_CHART_HEIGHT}
            onScrub={setScrubIndex}
            points={points}
            testID={`${testID}-chart`}
            variant="line"
            windowEndMs={points[points.length - 1].t}
            windowStartMs={points[0].t}
            yScale="fit"
          />
        </PageSwipeGuard>
      ) : null}

      {total > 0 ? (
        <View style={[styles.gutter, styles.breadth]} testID={`${testID}-breadth`}>
          <View style={[styles.breadthBar, { backgroundColor: theme.colors.gray200 }]}>
            <View style={{ backgroundColor: theme.colors.green400, flex: pulse.breadth.up }} />
            <View style={{ backgroundColor: theme.colors.gray200, flex: pulse.breadth.flat }} />
            <View style={{ backgroundColor: theme.colors.red400, flex: pulse.breadth.down }} />
          </View>
          <Text style={[theme.typography.captionMedium, { color: theme.colors.gray700 }]} testID={`${testID}-breadth-text`}>
            {`${upPct}% of cards up · ${downPct}% down`}
          </Text>
        </View>
      ) : null}

      {showYou ? (
        <View
          accessibilityLabel={`Your collection ${changeWords(you.changePct)}, market ${changeWords(you.marketChangePct)}.${you.beatsMarket == null ? '' : ` ${you.beatsMarket ? 'Beating' : 'Trailing'} the market.`}`}
          accessible
          style={[styles.you, { backgroundColor: theme.colors.gray50 }]}
          testID={`${testID}-you`}
        >
          <View style={styles.youCopy}>
            <Text style={[theme.typography.caption, { color: theme.colors.gray600 }]}>You vs market</Text>
            <Text numberOfLines={2} style={[theme.typography.titleXsmall, { color: theme.colors.gray900 }]}>
              {'Your collection '}
              <Text style={{ color: changeColor(theme, you.changePct) }}>{formatChange(you.changePct)}</Text>
              {' · market '}
              <Text style={{ color: changeColor(theme, you.marketChangePct) }}>{formatChange(you.marketChangePct)}</Text>
            </Text>
          </View>
          {/* No verdict without both numbers (backend sends beatsMarket null). */}
          {you.beatsMarket == null ? null : (
          <View
            style={[
              styles.verdict,
              { backgroundColor: you.beatsMarket ? theme.colors.green100 : theme.colors.gray100 },
            ]}
            testID={`${testID}-you-verdict`}
          >
            {you.beatsMarket ? (
              <GraphUp color={theme.colors.green500} height={14} strokeWidth={2} width={14} />
            ) : (
              <GraphDown color={theme.colors.gray700} height={14} strokeWidth={2} width={14} />
            )}
            <Text style={[theme.typography.chipLabel, { color: you.beatsMarket ? theme.colors.green500 : theme.colors.gray700 }]}>
              {you.beatsMarket ? 'BEATING' : 'TRAILING'}
            </Text>
          </View>
          )}
        </View>
      ) : null}
    </View>
  );
}

// --- 3. bargains ---------------------------------------------------------------

export function BargainRail({
  items,
  onPressCard,
  testID,
}: {
  items: readonly MarketBargain[];
  onPressCard: (card: MarketCardTile) => void;
  testID: string;
}) {
  const theme = useSpotlightTheme();
  return (
    <Rail testID={testID}>
      {items.map((item) => {
        const near = item.position.percentile <= NEAR_LOW_PERCENTILE;
        return (
          <Pressable
            accessibilityLabel={`${item.name}, ${formatCurrency(item.priceUsd)}. ${near ? 'Near its recent low' : 'Below its recent range midpoint'}. Low ${formatCurrency(item.position.lowUsd)}, high ${formatCurrency(item.position.highUsd)}.`}
            accessibilityRole="button"
            key={`${item.cardId}|${item.variant ?? ''}`}
            onPress={() => onPressCard(item)}
            style={({ pressed }) => [styles.cardTile, { opacity: pressed ? 0.8 : 1 }]}
            testID={`${testID}-${item.cardId}`}
          >
            <CardArt card={item} />
            <View style={styles.cardCopy}>
              <Text numberOfLines={1} style={[theme.typography.titleXsmall, { color: theme.colors.gray900 }]}>{item.name}</Text>
              <Text numberOfLines={1} style={[theme.typography.overline, { color: theme.colors.gray600 }]}>
                {[item.setName, item.number].filter(Boolean).join(' · ')}
              </Text>
              <Text style={[theme.typography.feedRowTitle, { color: theme.colors.gray900 }]}>{formatCurrency(item.priceUsd)}</Text>
            </View>
            <PricePositionBar
              label={near ? 'Near its recent low' : pricePositionShort(item.position.percentile)}
              percentile={item.position.percentile}
              size="sm"
              testID={`${testID}-${item.cardId}-position`}
            />
          </Pressable>
        );
      })}
    </Rail>
  );
}

function pricePositionShort(percentile: number) {
  return percentile < 100 / 3 ? 'Low in its range' : 'Mid-range';
}

// --- 4. breaking out -----------------------------------------------------------

export function BreakoutRail({
  items,
  onPressCard,
  testID,
}: {
  items: readonly MarketBreakout[];
  onPressCard: (card: MarketCardTile) => void;
  testID: string;
}) {
  const theme = useSpotlightTheme();
  return (
    <Rail testID={testID}>
      {items.map((item) => (
        <Pressable
          accessibilityLabel={`${item.name}, ${formatCurrency(item.priceUsd)}, ${changeWords(item.changePct)}. New high${item.previousHighUsd != null ? `, previous high ${formatCurrency(item.previousHighUsd)}` : ''}.`}
          accessibilityRole="button"
          key={`${item.cardId}|${item.variant ?? ''}`}
          onPress={() => onPressCard(item)}
          style={({ pressed }) => [styles.cardTile, { opacity: pressed ? 0.8 : 1 }]}
          testID={`${testID}-${item.cardId}`}
        >
          <CardArt card={item} />
          <View style={styles.cardCopy}>
            <Text numberOfLines={1} style={[theme.typography.titleXsmall, { color: theme.colors.gray900 }]}>{item.name}</Text>
            <Text numberOfLines={1} style={[theme.typography.overline, { color: theme.colors.gray600 }]}>
              {[item.setName, item.number].filter(Boolean).join(' · ')}
            </Text>
            <Text style={[theme.typography.feedRowTitle, { color: theme.colors.gray900 }]}>{formatCurrency(item.priceUsd)}</Text>
          </View>
          <View style={styles.breakoutTrend}>
            <PriceSparkline
              height={SPARK_HEIGHT}
              points={item.sparkline.map((point) => point.value)}
              trendPct={item.changePct ?? 0}
              width={SPARK_WIDTH}
            />
            <Text
              style={[theme.typography.labelStrong, { color: changeColor(theme, item.changePct) }]}
              testID={`${testID}-${item.cardId}-change`}
            >
              {formatChange(item.changePct)}
            </Text>
          </View>
          <Text numberOfLines={1} style={[theme.typography.overline, { color: theme.colors.gray600 }]}>
            {item.previousHighUsd != null ? `Prior high ${formatCurrency(item.previousHighUsd)}` : 'New high'}
          </Text>
        </Pressable>
      ))}
    </Rail>
  );
}

// --- 5. sets rising / falling ------------------------------------------------

export function SetMoverRail({
  title,
  direction,
  items,
  onPressSet,
  emptyMessage,
  testID,
}: {
  title: string;
  direction: 'up' | 'down';
  items: readonly MarketSetMove[];
  onPressSet: (set: MarketSetMove) => void;
  emptyMessage: string;
  testID: string;
}) {
  const theme = useSpotlightTheme();
  const Icon = direction === 'up' ? GraphUp : GraphDown;
  return (
    <View style={styles.setGroup} testID={testID}>
      <View style={[styles.gutter, styles.sectionTitleRow]}>
        <Text style={[theme.typography.label, { color: theme.colors.gray900 }]}>{title}</Text>
        <Icon color={theme.colors.gray900} height={ICON_SIZE} width={ICON_SIZE} />
      </View>
      {items.length === 0 ? (
        <SectionEmpty message={emptyMessage} testID={`${testID}-empty`} />
      ) : (
        <Rail testID={`${testID}-rail`}>
          {items.map((set) => (
            <Pressable
              accessibilityLabel={`${set.name}, ${formatSignedPercent(set.changePct)}. Opens the set.`}
              accessibilityRole="button"
              key={set.setId}
              onPress={() => onPressSet(set)}
              style={({ pressed }) => [
                styles.setTile,
                { backgroundColor: theme.colors.gray50, opacity: pressed ? 0.8 : 1 },
              ]}
              testID={`${testID}-${set.setId}`}
            >
              <View style={styles.setLogoSlot}>
                {set.logoUrl ? (
                  <ExpoImage
                    accessibilityIgnoresInvertColors
                    cachePolicy="memory-disk"
                    contentFit="contain"
                    contentPosition="left"
                    source={{ uri: set.logoUrl }}
                    style={StyleSheet.absoluteFill}
                  />
                ) : null}
              </View>
              <Text numberOfLines={2} style={[theme.typography.captionMedium, styles.setName, { color: theme.colors.gray900 }]}>
                {set.name}
              </Text>
              <Text style={[theme.typography.feedRowTitle, { color: changeColor(theme, set.changePct) }]} testID={`${testID}-${set.setId}-change`}>
                {formatSignedPercent(set.changePct)}
              </Text>
            </Pressable>
          ))}
        </Rail>
      )}
    </View>
  );
}

// --- 6. grading --------------------------------------------------------------

export function GradingList({
  items,
  onPressCard,
  testID,
}: {
  items: readonly MarketGradingPick[];
  onPressCard: (card: MarketCardTile) => void;
  testID: string;
}) {
  const theme = useSpotlightTheme();
  return (
    <View style={[styles.gutter, styles.gradingList]} testID={testID}>
      {items.map((item, index) => (
        <View key={`${item.cardId}|${item.variant ?? ''}`}>
          {index > 0 ? <View style={[styles.divider, { backgroundColor: theme.colors.gray200 }]} /> : null}
          <Pressable
            accessibilityLabel={`${item.name}. Raw ${formatCurrency(item.rawUsd)}, PSA 10 ${formatCurrency(item.psa10Usd)}. About ${formatSignedWholeUsd(item.netGainUsd)} after about ${formatCurrency(item.feeUsd)} in fees.${item.owned ? ' You own this.' : ''}`}
            accessibilityRole="button"
            onPress={() => onPressCard(item)}
            style={({ pressed }) => [styles.gradingRow, { opacity: pressed ? 0.8 : 1 }]}
            testID={`${testID}-${item.cardId}`}
          >
            <CardArt card={item} height={ROW_THUMB_HEIGHT} width={ROW_THUMB_WIDTH} />
            <View style={styles.gradingCopy}>
              <View style={styles.gradingTitleRow}>
                <Text numberOfLines={1} style={[theme.typography.titleXsmall, styles.flexShrink, { color: theme.colors.gray900 }]}>
                  {item.name}
                </Text>
                {item.owned ? <OwnedTag label="You own this" testID={`${testID}-${item.cardId}-owned`} /> : null}
              </View>
              <Text numberOfLines={1} style={[theme.typography.caption, { color: theme.colors.gray700 }]}>
                {`Raw ${formatCurrency(item.rawUsd)} → PSA 10 ${formatCurrency(item.psa10Usd)}`}
              </Text>
              <Text
                numberOfLines={1}
                style={[theme.typography.captionMedium, { color: item.netGainUsd > 0 ? theme.colors.green500 : theme.colors.gray600 }]}
                testID={`${testID}-${item.cardId}-net`}
              >
                {`≈ ${formatSignedWholeUsd(item.netGainUsd)} after ~${formatCurrency(item.feeUsd).replace(/\.00$/, '')} fees`}
              </Text>
            </View>
            <NavArrowRight color={theme.colors.gray400} height={ICON_SIZE} width={ICON_SIZE} />
          </Pressable>
        </View>
      ))}
    </View>
  );
}

// --- loading -----------------------------------------------------------------

export function MarketAnalyticsSkeleton({ testID }: { testID: string }) {
  return (
    <View style={styles.skeleton} testID={testID}>
      <View style={[styles.gutter, styles.skeletonStack]}>
        <SkeletonBlock height={12} width={110} />
        <SkeletonBlock height={36} width={120} />
        <SkeletonBlock height={14} width={200} />
      </View>
      <SkeletonBlock height={PULSE_CHART_HEIGHT} radius={0} />
      <View style={styles.gutter}>
        <SkeletonBlock height={260} />
      </View>
      <View style={styles.rail}>
        {[0, 1, 2].map((key) => (
          <SkeletonBlock height={CARD_ART_HEIGHT} key={key} width={CARD_TILE_WIDTH} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  art: {
    borderCurve: 'continuous',
    borderRadius: radii.xs,
    overflow: 'hidden',
  },
  breadth: {
    gap: spacing.xxs,
  },
  breadthBar: {
    borderCurve: 'continuous',
    borderRadius: radii.pill,
    flexDirection: 'row',
    gap: 2,
    height: BREADTH_BAR_HEIGHT,
    overflow: 'hidden',
  },
  breakoutTrend: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xxs,
  },
  cardCopy: {
    gap: 2,
  },
  cardTile: {
    gap: spacing.xxs,
    width: CARD_TILE_WIDTH,
  },
  divider: {
    height: borderWidths.ruleSnapped,
  },
  flexShrink: {
    flexShrink: 1,
  },
  gamePicker: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xxxs,
  },
  gradingCopy: {
    flex: 1,
    gap: 2,
    minWidth: 0,
  },
  gradingList: {
    gap: 0,
  },
  gradingRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xs,
    paddingVertical: spacing.xs,
  },
  gradingTitleRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xxs,
  },
  gutter: {
    paddingHorizontal: spacing.sm,
  },
  pulse: {
    gap: spacing.sm,
  },
  rail: {
    flexDirection: 'row',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
  },
  sectionTitle: {
    gap: 2,
    paddingHorizontal: spacing.sm,
  },
  sectionTitleRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xxxs,
  },
  setGroup: {
    gap: spacing.xxs,
  },
  setLogoSlot: {
    height: SET_LOGO_HEIGHT,
    width: '100%',
  },
  setName: {
    minHeight: 34,
  },
  setTile: {
    borderCurve: 'continuous',
    borderRadius: radii.sm,
    gap: spacing.xxs,
    padding: spacing.xs,
    width: SET_TILE_WIDTH,
  },
  skeleton: {
    gap: spacing.lg,
    paddingTop: spacing.sm,
  },
  skeletonStack: {
    gap: spacing.xxs,
  },
  verdict: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: radii.pill,
    flexDirection: 'row',
    gap: spacing.xxxs,
    paddingHorizontal: spacing.xxs,
    paddingVertical: spacing.xxxs,
  },
  windowLabel: {
    ...textStyles.label,
    textAlign: 'center',
  },
  windowPill: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: radii.sm,
    justifyContent: 'center',
    paddingHorizontal: spacing.xs,
    paddingVertical: spacing.xxxs,
  },
  windowRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xxs,
  },
  you: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: radii.md,
    flexDirection: 'row',
    gap: spacing.xs,
    marginHorizontal: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  youCopy: {
    flex: 1,
    gap: 2,
    minWidth: 0,
  },
});
