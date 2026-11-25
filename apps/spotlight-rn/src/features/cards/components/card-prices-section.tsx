import { Fragment, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { IconChevronDown, IconChevronRight } from '@tabler/icons-react-native';

import {
  borderWidths,
  PriceSparkline,
  spacing,
  Text,
  useSpotlightTheme,
} from '@spotlight/design-system';
import type { CardPriceTrendRow } from '@spotlight/api-client';

import {
  formatLadderDelta,
  formatLadderMultiple,
  type GradeLadder,
  type GradeLadderRung,
  type RawPriceRow,
} from '@/features/cards/grade-ladder';
import { formatCurrency } from '@/features/portfolio/components/portfolio-formatting';

export type GraderQuote = {
  grader: string;
  /** Highest numeric grade with a USD price; null while unknown. */
  top: { grade: string; price: number } | null;
};

type CardPricesSectionProps = {
  rawRows: readonly RawPriceRow[];
  /** Raw rows still loading (skeleton note instead of an empty group). */
  rawLoading?: boolean;
  /** Graders with USD prices (plus the page's own grader in the graded lane). */
  graders: readonly GraderQuote[];
  /** Null hides the GRADED group (sealed / TCGplayer-only / nothing priced). */
  selectedGrader: string | null;
  onSelectGrader: (grader: string) => void;
  ladder: GradeLadder;
  ladderLoading?: boolean;
  /** Raw condition row tapped (the PDP opens TCGplayer for it). */
  onPressRawRow: (row: CardPriceTrendRow) => void;
  /** Graded row tapped: toggles its accordion. Absent → graded rows are static. */
  onToggleRung?: (rung: GradeLadderRung) => void;
  /** The graded row whose accordion is open, and what renders under it. */
  expandedRowKey?: string | null;
  expandedContent?: ReactNode;
  testID?: string;
};

const SPARKLINE_WIDTH = 62;
const SPARKLINE_HEIGHT = 22;
const CHEVRON_SIZE = 16;
const TAB_UNDERLINE = 2;

const shortConditionLabel = (label: string) => (label === 'Moderately Played' ? 'Mod. Played' : label);

/**
 * PRICES: the raw conditions (Δ vs Near Mint) and one grader's grades (Δ and ×
 * vs raw NM), with text tabs to switch graders. Raw rows link out; graded
 * rows open their comps inline.
 */
export function CardPricesSection({
  rawRows,
  rawLoading = false,
  graders,
  selectedGrader,
  onSelectGrader,
  ladder,
  ladderLoading = false,
  onPressRawRow,
  onToggleRung,
  expandedRowKey = null,
  expandedContent = null,
  testID = 'detail-prices',
}: CardPricesSectionProps) {
  const theme = useSpotlightTheme();
  const divider = <View style={[styles.divider, { backgroundColor: theme.colors.gray200 }]} />;
  const rowStyle = () => ({ pressed }: { pressed: boolean }) => [
    styles.row,
    { opacity: pressed ? 0.6 : 1 },
  ];
  const showTabs = graders.length > 1;
  // Near Mint alone by default; the lower conditions open on request.
  const [showAllConditions, setShowAllConditions] = useState(false);
  const visibleRawRows = showAllConditions ? rawRows : rawRows.filter((item) => item.isBase);
  const chevron = (open: boolean, chevronTestID: string) => (open ? (
    <IconChevronDown color={theme.colors.gray400} size={CHEVRON_SIZE} strokeWidth={2} testID={chevronTestID} />
  ) : (
    <IconChevronRight color={theme.colors.gray400} size={CHEVRON_SIZE} strokeWidth={2} testID={chevronTestID} />
  ));
  const hiddenConditionCount = rawRows.length - rawRows.filter((item) => item.isBase).length;

  // Grader tabs sit right-aligned above the grades; no group labels.
  const tabsRow = (accessory: ReactNode) => (
    <View style={styles.groupHeader}>{accessory}</View>
  );

  return (
    <View style={styles.root} testID={testID}>
      <Text style={[theme.typography.headlineMedium, { color: theme.colors.gray900 }]}>PRICES</Text>

      {rawRows.length > 0 || rawLoading ? (
        <View style={styles.group} testID={`${testID}-raw`}>
          {rawRows.length === 0 ? (
            <Text style={[theme.typography.caption, styles.note, { color: theme.colors.gray500 }]}>
              Loading raw prices…
            </Text>
          ) : visibleRawRows.map((item, index) => {
            const tone = item.deltaUsd == null || item.deltaUsd === 0
              ? theme.colors.gray600
              : item.deltaUsd > 0 ? theme.colors.green400 : theme.colors.red400;
            const rowTestID = `${testID}-raw-${item.conditionKey}`;
            return (
              <Fragment key={item.row.key}>
                {index > 0 ? divider : null}
                <Pressable
                  accessibilityLabel={`${item.row.label}, ${item.price == null ? 'no price' : formatCurrency(item.price, 'USD')}`}
                  accessibilityHint="Opens TCGplayer"
                  accessibilityRole="link"
                  onPress={() => onPressRawRow(item.row)}
                  style={rowStyle()}
                  testID={rowTestID}
                >
                  <Text numberOfLines={1} style={[theme.typography.label, styles.label, { color: theme.colors.gray700 }]}>
                    {shortConditionLabel(item.row.label)}
                  </Text>
                  <PriceSparkline
                    backgroundColor={theme.colors.gray0}
                    height={SPARKLINE_HEIGHT}
                    points={item.row.points}
                    trendPct={item.row.trendPct}
                    width={SPARKLINE_WIDTH}
                  />
                  <Text style={[theme.typography.bodyMedium, styles.price, { color: theme.colors.gray900 }]} testID={`${rowTestID}-price`}>
                    {item.price == null ? '—' : formatCurrency(item.price, 'USD')}
                  </Text>
                  <View style={styles.delta}>
                    {item.isBase ? (
                      <Text style={[theme.typography.caption, { color: theme.colors.gray500 }]} testID={`${rowTestID}-delta`}>
                        base
                      </Text>
                    ) : item.deltaUsd != null ? (
                      <Text style={[theme.typography.captionMedium, { color: tone }]} testID={`${rowTestID}-delta`}>
                        {formatLadderDelta(item.deltaUsd)}
                      </Text>
                    ) : null}
                  </View>
                  {chevron(false, `${rowTestID}-chevron`)}
                </Pressable>
              </Fragment>
            );
          })}
          {hiddenConditionCount > 0 ? (
            <Pressable
              accessibilityRole="button"
              hitSlop={8}
              onPress={() => setShowAllConditions((open) => !open)}
              style={({ pressed }) => [styles.moreConditions, { opacity: pressed ? 0.6 : 1 }]}
              testID={`${testID}-conditions-toggle`}
            >
              <Text style={[theme.typography.captionMedium, { color: theme.colors.gray600 }]}>
                {showAllConditions ? 'Show less' : 'Show all conditions'}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {selectedGrader != null ? (
        <View style={styles.group} testID={`${testID}-graded`}>
          {showTabs ? tabsRow(
            (
              <View style={styles.tabs}>
                {graders.map(({ grader }) => {
                  const selected = grader === selectedGrader;
                  return (
                    <Pressable
                      accessibilityRole="tab"
                      accessibilityState={{ selected }}
                      hitSlop={8}
                      key={grader}
                      onPress={() => onSelectGrader(grader)}
                      style={styles.tab}
                      testID={`${testID}-grader-${grader}`}
                    >
                      <Text
                        style={[
                          selected ? theme.typography.titleXsmall : theme.typography.body,
                          { color: selected ? theme.colors.gray900 : theme.colors.gray500 },
                        ]}
                      >
                        {grader.toUpperCase()}
                      </Text>
                      <View
                        style={[
                          styles.tabUnderline,
                          { backgroundColor: selected ? theme.colors.gray900 : 'transparent' },
                        ]}
                      />
                    </Pressable>
                  );
                })}
              </View>
            ),
          ) : null}

          {ladder.rungs.length === 0 ? (
            <Text
              style={[theme.typography.caption, styles.note, { color: theme.colors.gray500 }]}
              testID={ladderLoading ? `${testID}-graded-loading` : `${testID}-graded-empty`}
            >
              {ladderLoading ? 'Loading graded prices…' : `No ${selectedGrader} prices for this card yet.`}
            </Text>
          ) : ladder.rungs.map((rung, index) => {
            const tone = rung.deltaUsd == null || rung.deltaUsd === 0
              ? theme.colors.gray600
              : rung.deltaUsd > 0 ? theme.colors.green400 : theme.colors.red400;
            const rungTestID = `${testID}-rung-${rung.grade}`;
            const expanded = onToggleRung != null && rung.key === expandedRowKey;
            const rowContent = (
              <>
                <Text numberOfLines={1} style={[theme.typography.label, styles.label, { color: theme.colors.gray700 }]}>
                  {`${selectedGrader} ${rung.grade}`}
                </Text>
                <Text style={[theme.typography.bodyMedium, styles.price, { color: theme.colors.gray900 }]}>
                  {formatCurrency(rung.price, 'USD')}
                </Text>
                <View style={styles.delta}>
                  {rung.deltaUsd != null ? (
                    <Text style={[theme.typography.captionMedium, { color: tone }]} testID={`${rungTestID}-delta`}>
                      {formatLadderDelta(rung.deltaUsd)}
                    </Text>
                  ) : null}
                  {rung.multiple != null ? (
                    <Text style={[theme.typography.caption, { color: theme.colors.gray500 }]} testID={`${rungTestID}-multiple`}>
                      {formatLadderMultiple(rung.multiple)}
                    </Text>
                  ) : null}
                </View>
                {onToggleRung ? chevron(expanded, `${rungTestID}-chevron`) : null}
              </>
            );
            return (
              <Fragment key={rung.key}>
                {index > 0 ? divider : null}
                {onToggleRung ? (
                  <Pressable
                    accessibilityLabel={`${selectedGrader} ${rung.grade}, ${formatCurrency(rung.price, 'USD')}`}
                    accessibilityRole="button"
                    accessibilityState={{ expanded }}
                    onPress={() => onToggleRung(rung)}
                    style={rowStyle()}
                    testID={rungTestID}
                  >
                    {rowContent}
                  </Pressable>
                ) : (
                  <View style={styles.row} testID={rungTestID}>
                    {rowContent}
                  </View>
                )}
                {expanded && expandedContent != null ? (
                  <View style={styles.expanded} testID={`${rungTestID}-expanded`}>
                    {expandedContent}
                  </View>
                ) : null}
              </Fragment>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  delta: {
    alignItems: 'flex-end',
    minWidth: 64,
  },
  divider: {
    height: borderWidths.containerRule,
  },
  expanded: {
    paddingBottom: spacing.sm,
  },
  group: {
    paddingTop: spacing.sm,
  },
  groupHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingBottom: spacing.xxxs,
  },
  label: {
    flex: 1,
  },
  note: {
    paddingTop: spacing.xxs,
  },
  price: {
    minWidth: 72,
    textAlign: 'right',
  },
  root: {
    width: '100%',
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xs,
    paddingVertical: spacing.xs,
  },
  moreConditions: {
    alignSelf: 'flex-start',
    paddingTop: spacing.xxs,
  },
  tab: {
    alignItems: 'center',
    gap: spacing.xxxs,
  },
  tabUnderline: {
    alignSelf: 'stretch',
    height: TAB_UNDERLINE,
  },
  tabs: {
    alignItems: 'flex-end',
    flexDirection: 'row',
    gap: spacing.sm,
  },
});

export default CardPricesSection;
