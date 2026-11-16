import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Image, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { NavArrowDown } from 'iconoir-react-native';

import type {
  CardPriceTrendMode,
  CardPriceTrendRow,
  CardRecentSalesRecord,
  SpotlightRepository,
} from '@spotlight/api-client';
import {
  RollingNumber,
  SkeletonBlock,
  Text,
  TrendTriangle,
  borderWidths,
  layout,
  radii,
  spacing,
  textStyles,
  useSpotlightTheme,
} from '@spotlight/design-system';

import {
  GradeConditionSheet,
  type GradeConditionOption,
} from '@/features/cards/components/grade-condition-sheet';
import { PriceScrubChart } from '@/features/cards/components/price-scrub-chart';
import {
  defaultPriceChartRange,
  priceChartRanges,
  priceChartReadout,
  resolveDefaultRowKey,
  type ChartTone,
  type PriceChartModel,
  type PriceChartRange,
} from '@/features/cards/card-price-chart-model';
import { useCardPriceChart } from '@/features/cards/hooks/use-card-price-chart';
import { formatCurrency } from '@/features/portfolio/components/portfolio-formatting';

export const PRICE_CHART_HEIGHT = 210;

// Off-scale Figma values for the price header (6322:8974); no token fits.
// Delta line (6322:8976): 6 between amount / percent / logo, 2 after the 7pt triangle.
const DELTA_GROUP_GAP = 6;
const DELTA_TRIANGLE_GAP = 2;
const DELTA_TRIANGLE_SIZE = 7;
// TCGplayer logo 16.09x12 (6322:8986); the asset is the same 120x89 mark.
const TCGPLAYER_LOGO = { width: 16.09, height: 12 };
// Kept off the chip below: the delta row ends 4pt above it.
const TCGPLAYER_HIT_SLOP = { top: 8, bottom: 4, left: 4, right: 8 };
// Condition chip (6322:8987): 3pt vertical pad, 8x4 chevron at a 1pt stroke.
// The viewBox crops iconoir's 24-unit box to the chevron (M6 9 L12 15 L18 9 +
// its round caps), scaled 2/3 so the glyph is 8x4 and the stroke 1pt.
const CHIP_PADDING_VERTICAL = 3;
const CHIP_CHEVRON = { width: 9, height: 5, viewBox: '5.25 8.25 13.5 7.5', strokeWidth: 1.5 };

type CardPriceChartSectionProps = {
  repository: SpotlightRepository;
  cardId: string;
  /** False until the page's detail (hence its printing) has loaded. */
  enabled: boolean;
  mode: CardPriceTrendMode;
  /** The lane's Price Trend rows (conditions or grades) — the chip's options. */
  rows: readonly CardPriceTrendRow[];
  /** The lane's rows are still loading. */
  rowsLoading: boolean;
  variantLabel: string | null;
  /** Seeds the chip: the owned/seeded condition (raw) or grade (graded). */
  preferredCondition: string | null;
  preferredGrade: string | null;
  salesEnabled: boolean;
  /** Comps the page already holds per row key (expanded graded rows). */
  salesByRowKey?: Readonly<Record<string, CardRecentSalesRecord | null>>;
  /** Horizontal padding of the host surface; the chart bleeds back out by it. */
  gutter?: number;
  /** Host surface style (e.g. the PDP's inset chart card); skipped when hidden. */
  style?: StyleProp<ViewStyle>;
  /**
   * Opens TCGplayer for the charted row. Only the logo beside the delta calls
   * it (Figma 6322:8986); absent → no logo (graded lane, no exact link).
   */
  onOpenMarketplace?: (row: CardPriceTrendRow) => void;
  /**
   * Price lanes the card offers (Raw / PSA / CGC…), shown as a chip beside the
   * row chip. Same state as the page's GRADER chips; hidden with < 2 lanes.
   */
  graders?: readonly string[];
  selectedGrader?: string | null;
  onSelectGrader?: (grader: string) => void;
  testID?: string;
};

/**
 * Robinhood-style price block for the PDP: big price, delta line, row chip,
 * scrubbable chart, range buttons, and an "as of" line.
 */
export function CardPriceChartSection({
  repository,
  cardId,
  enabled,
  mode,
  rows,
  rowsLoading,
  variantLabel,
  preferredCondition,
  preferredGrade,
  salesEnabled,
  salesByRowKey,
  gutter = layout.pageGutter,
  style,
  onOpenMarketplace,
  graders = [],
  selectedGrader = null,
  onSelectGrader,
  testID = 'card-price-chart',
}: CardPriceChartSectionProps) {
  const theme = useSpotlightTheme();
  const [pickedRowKey, setPickedRowKey] = useState<string | null>(null);
  const [range, setRange] = useState<PriceChartRange>(defaultPriceChartRange);
  const [scrubIndex, setScrubIndex] = useState<number | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [graderSheetOpen, setGraderSheetOpen] = useState(false);
  const showGraderChip = graders.length > 1 && onSelectGrader != null;
  const graderLabel = selectedGrader ?? 'Raw';

  // A new card or lane starts from its own default row.
  useEffect(() => {
    setPickedRowKey(null);
    setScrubIndex(null);
  }, [cardId, mode]);

  const rowKey = useMemo(() => {
    if (pickedRowKey && rows.some((row) => row.key === pickedRowKey)) {
      return pickedRowKey;
    }
    return resolveDefaultRowKey(rows, mode, { condition: preferredCondition, grade: preferredGrade });
  }, [mode, pickedRowKey, preferredCondition, preferredGrade, rows]);
  const selectedRow = rows.find((row) => row.key === rowKey) ?? null;

  const chart = useCardPriceChart({
    repository,
    cardId,
    enabled: enabled && !rowsLoading,
    mode,
    rowKey,
    variantLabel,
    range,
    salesEnabled,
    seededSales: rowKey ? salesByRowKey?.[rowKey] : null,
  });

  const toneColor = useCallback((tone: ChartTone) => (
    tone === 'up' ? theme.colors.green400 : tone === 'down' ? theme.colors.red400 : theme.colors.gray600
  ), [theme.colors]);

  const sheetOptions = useMemo<GradeConditionOption[]>(() => rows.map((row) => ({
    id: row.key,
    label: row.label,
    detail: row.currentPrice != null ? formatCurrency(row.currentPrice, row.currencyCode) : null,
  })), [rows]);

  const handleSelectRow = useCallback((key: string) => {
    setPickedRowKey(key);
    setScrubIndex(null);
  }, []);
  const handleSelectRange = useCallback((next: PriceChartRange) => {
    setRange(next);
    setScrubIndex(null);
  }, []);

  // While a newly picked row loads, keep drawing the last chart of this card +
  // lane instead of the skeleton: the swap used to unmount the open condition
  // sheet mid-tap and jump the page under the finger. A lane/card change
  // (rows reloading) still shows the skeleton.
  const lastReadyRef = useRef<{ scope: string; model: PriceChartModel } | null>(null);
  const scope = `${cardId}|${mode}`;
  if (chart.status === 'ready') {
    lastReadyRef.current = { scope, model: chart.model };
  }
  const model = chart.status === 'ready'
    ? chart.model
    : chart.status === 'loading' && !rowsLoading && lastReadyRef.current?.scope === scope
      ? lastReadyRef.current.model
      : null;

  // The sheet stays mounted whatever the chart state, so a pick can play its
  // close slide instead of the Modal being torn down under the touch.
  const graderOptions = useMemo<GradeConditionOption[]>(
    () => graders.map((grader) => ({ id: grader, label: grader })),
    [graders],
  );
  const sheet = (
    <>
      {showGraderChip ? (
        <GradeConditionSheet
          onClose={() => setGraderSheetOpen(false)}
          onSelect={(grader) => onSelectGrader?.(grader)}
          options={graderOptions}
          selectedId={graderLabel}
          testID={`${testID}-grader-sheet`}
          title="Grader"
          visible={graderSheetOpen}
        />
      ) : null}
      <GradeConditionSheet
      onClose={() => setSheetOpen(false)}
      onSelect={handleSelectRow}
      options={sheetOptions}
      selectedId={rowKey}
      testID={`${testID}-sheet`}
      title={mode === 'graded' ? 'Grade' : 'Condition'}
      visible={sheetOpen}
    />
    </>
  );

  if (chart.status === 'hidden') {
    return null;
  }
  if (!model || !selectedRow) {
    return (
      <>
        <CardPriceChartSkeleton style={style} testID={`${testID}-skeleton`} />
        {sheet}
      </>
    );
  }
  const readout = priceChartReadout(model, scrubIndex);
  const deltaColor = readout.delta
    ? toneColor(readout.delta.direction === 'flat' ? 'neutral' : readout.delta.direction)
    : theme.colors.gray600;
  const priceLabel = formatCurrency(readout.value, model.currencyCode);
  const tcgplayerLink = onOpenMarketplace ? (
    // The ONLY link in the price card (Figma 6322:8986).
    <Pressable
      accessibilityLabel="Open on TCGplayer"
      accessibilityRole="link"
      hitSlop={TCGPLAYER_HIT_SLOP}
      onPress={() => onOpenMarketplace(selectedRow)}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
      testID={`${testID}-tcgplayer`}
    >
      <Image
        resizeMode="contain"
        source={require('../../../../assets/images/tcgplayer-logo.png')}
        style={TCGPLAYER_LOGO}
      />
    </Pressable>
  ) : null;

  return (
    <View style={[styles.root, style]} testID={testID}>
      <View style={styles.header}>
        {/* With no price change to sit beside, the TCGplayer icon rides next to
            the price instead of alone on the line below it (user, 2026-11-16). */}
        <View style={styles.priceRow} testID={`${testID}-price-row`}>
          <RollingNumber
            accessibilityLabel={priceLabel}
            animate={scrubIndex == null}
            style={[theme.typography.detailTitleBold, { color: theme.colors.gray900 }]}
            testID={`${testID}-price`}
            value={priceLabel}
          />
          {readout.delta ? null : tcgplayerLink}
        </View>
        <View style={styles.deltaRow} testID={`${testID}-delta`}>
          {readout.delta ? (
            <View style={styles.deltaAmount}>
              {readout.delta.direction !== 'flat' ? (
                <TrendTriangle color={deltaColor} direction={readout.delta.direction} size={DELTA_TRIANGLE_SIZE} />
              ) : null}
              <Text style={[theme.typography.titleXsmall, { color: deltaColor }]} testID={`${testID}-delta-amount`}>
                {readout.delta.amount}
              </Text>
            </View>
          ) : null}
          {readout.delta?.percent ? (
            <Text style={[theme.typography.titleXsmall, { color: deltaColor }]} testID={`${testID}-delta-percent`}>
              {readout.delta.percent}
            </Text>
          ) : null}
          {readout.delta ? tcgplayerLink : null}
          {/* At rest the line is just price + delta (Figma 6322:8976); the date
              caption appears only while scrubbing a point. */}
          {scrubIndex != null ? (
            <Text
              style={[theme.typography.captionMedium, { color: theme.colors.gray600 }]}
              testID={`${testID}-delta-suffix`}
            >
              {readout.suffix}
            </Text>
          ) : null}
        </View>
        <View style={styles.chipRow}>
          {showGraderChip ? (
            <Pressable
              accessibilityHint="Choose raw or a grading company"
              accessibilityRole="button"
              onPress={() => setGraderSheetOpen(true)}
              style={({ pressed }) => [
                styles.chip,
                { borderColor: theme.colors.gray300, backgroundColor: theme.colors.gray0, opacity: pressed ? 0.7 : 1 },
              ]}
              testID={`${testID}-grader-chip`}
            >
              <Text style={[theme.typography.captionTiny, { color: theme.colors.gray900 }]}>{graderLabel}</Text>
              <NavArrowDown color={theme.colors.gray900} {...CHIP_CHEVRON} />
            </Pressable>
          ) : null}
          <Pressable
            accessibilityHint="Choose which price to chart"
            accessibilityRole="button"
            onPress={() => setSheetOpen(true)}
            style={({ pressed }) => [
              styles.chip,
              { borderColor: theme.colors.gray300, backgroundColor: theme.colors.gray0, opacity: pressed ? 0.7 : 1 },
            ]}
            testID={`${testID}-chip`}
          >
            {/* Compact chip (Figma 6322:8987): Regular 10, 8x4 chevron. */}
            <Text style={[theme.typography.captionTiny, { color: theme.colors.gray900 }]}>
              {showGraderChip ? chipRowLabel(selectedRow.label, selectedGrader) : selectedRow.label}
            </Text>
            <NavArrowDown color={theme.colors.gray900} {...CHIP_CHEVRON} />
          </Pressable>
        </View>
      </View>

      <View style={{ marginHorizontal: -gutter }}>
        {model.insufficient ? (
          <View style={styles.emptyChart} testID={`${testID}-empty`}>
            <Text style={[theme.typography.body, styles.emptyCopy, { color: theme.colors.gray600 }]}>
              {model.emptyMessage}
            </Text>
          </View>
        ) : (
          <PriceScrubChart
            // Figma 6322:8991: brand purple line over a soft purple gradient,
            // whatever the trend direction (the delta line carries green/red).
            areaFill
            color={theme.colors.purple500}
            fillGrid={false}
            height={PRICE_CHART_HEIGHT}
            onScrub={setScrubIndex}
            points={model.points}
            testID={`${testID}-chart`}
            variant={model.variant}
            windowEndMs={model.windowEndMs}
            windowStartMs={model.windowStartMs}
          />
        )}
      </View>

      <View style={styles.rangeRow} testID={`${testID}-ranges`}>
        {priceChartRanges.map((option) => {
          const selected = option === range;
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected }}
              key={option}
              onPress={() => handleSelectRange(option)}
              // Figma 6322:8994: neutral filter — gray/100 fill on the selected range.
              style={[styles.rangeButton, selected && { backgroundColor: theme.colors.gray100 }]}
              testID={`${testID}-range-${option}`}
            >
              <Text
                style={[
                  theme.typography.label,
                  { color: selected ? theme.colors.gray900 : theme.colors.gray700 },
                ]}
              >
                {option}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {sheet}
    </View>
  );
}

/** The grader chip already names the company: "PSA 10" → "10". */
export function chipRowLabel(label: string, grader: string | null): string {
  if (!grader || grader === 'Raw') {
    return label;
  }
  const prefix = `${grader} `;
  return label.toUpperCase().startsWith(prefix.toUpperCase()) ? label.slice(prefix.length) : label;
}

/** Same footprint as the loaded section so nothing below jumps when it lands. */
function CardPriceChartSkeleton({ style, testID }: { style?: StyleProp<ViewStyle>; testID: string }) {
  return (
    <View style={[styles.root, style]} testID={testID}>
      <View style={styles.header}>
        <SkeletonBlock height={textStyles.detailTitleBold.lineHeight} width={120} />
        <SkeletonBlock height={textStyles.titleXsmall.lineHeight} width={140} />
        <SkeletonBlock
          height={textStyles.captionTiny.lineHeight + CHIP_PADDING_VERTICAL * 2}
          radius={radii.pill}
          width={72}
        />
      </View>
      <SkeletonBlock height={PRICE_CHART_HEIGHT} />
      <SkeletonBlock height={36} />
      <SkeletonBlock height={16} width={220} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    gap: spacing.xxs,
    width: '100%',
  },
  header: {
    alignItems: 'flex-start',
    gap: spacing.xxxs,
  },
  priceRow: {
    alignItems: 'center',
    columnGap: spacing.xxs,
    flexDirection: 'row',
  },
  deltaRow: {
    alignItems: 'center',
    columnGap: DELTA_GROUP_GAP,
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  deltaAmount: {
    alignItems: 'center',
    columnGap: DELTA_TRIANGLE_GAP,
    flexDirection: 'row',
  },
  chipRow: {
    flexDirection: 'row',
    gap: spacing.xxxs,
  },
  chip: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: radii.pill,
    borderWidth: borderWidths.containerRule,
    flexDirection: 'row',
    gap: spacing.xxs,
    paddingHorizontal: spacing.xxs,
    paddingVertical: CHIP_PADDING_VERTICAL,
  },
  emptyChart: {
    alignItems: 'center',
    height: PRICE_CHART_HEIGHT,
    justifyContent: 'center',
    paddingHorizontal: spacing.xxxl,
  },
  emptyCopy: {
    textAlign: 'center',
  },
  rangeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xs,
  },
  rangeButton: {
    borderCurve: 'continuous',
    borderRadius: radii.sm,
    paddingHorizontal: spacing.xs,
    paddingVertical: spacing.xxxs,
  },
});
