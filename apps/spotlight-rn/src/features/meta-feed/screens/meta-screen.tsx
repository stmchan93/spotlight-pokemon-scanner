import { useCallback, useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowDown, ArrowUp } from 'iconoir-react-native';

import {
  DEFAULT_CARD_GAME,
  gameDisplayName,
  type CardGame,
  type MetaGroup,
  type MetaLadder,
  type MetaLaneFilter,
  type MetaPulse,
} from '@spotlight/api-client';
import {
  DeltaPill,
  LaneTag,
  PillButton,
  PriceSparkline,
  SegmentedControl,
  SkeletonBlock,
  StateCard,
  Text,
  borderWidths,
  radii,
  spacing,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { MetaCardRow } from '@/features/meta-feed/screens/components/meta-card-row';
import {
  formatCount,
  formatSignedCompactUsd,
  formatSignedPercent,
  gradeLabel,
} from '@/features/meta-feed/screens/components/meta-format';
import {
  MetaPageHeader,
  MetaSection,
  useSignedColor,
} from '@/features/meta-feed/screens/components/meta-page-chrome';
import { useMetaPageData, type MetaPageStatus } from '@/features/meta-feed/screens/components/meta-page-data';

export const META_LANE_ITEMS = [
  { label: 'All', value: 'all' },
  { label: 'Raw', value: 'raw' },
  { label: 'Graded', value: 'graded' },
] as const satisfies readonly { label: string; value: MetaLaneFilter }[];

export const META_WINDOW_ITEMS = [
  { label: '7D', value: '7' },
  { label: '30D', value: '30' },
  { label: '90D', value: '90' },
] as const;

type WindowValue = (typeof META_WINDOW_ITEMS)[number]['value'];

const GROUPS_FOOTNOTE =
  "Price = the middle (median) change among cards in the group whose price actually moved in the window, so one odd sale can't swing it. Value = change in the group's combined market price. Raw prices from TCGplayer, graded from Scrydex.";
const HEADLINE_FOOTNOTE =
  'Written from our daily raw (TCGplayer) and graded (Scrydex) prices. Updated nightly.';

// Group table columns (mockup: 62 / 58 / 44 beside a flexible label column). Not `value`: the
// Reanimated babel plugin rewrites `.value` inside style objects.
const COLUMN_WIDTHS = { cards: 44, money: 58, price: 62 } as const;
const GROUP_SPARK = { height: 16, width: 80 } as const;
const LADDER_BAR_HEIGHT = 8;

function readLabel(windowDays: number): string {
  if (windowDays <= 7) return "This week's read";
  if (windowDays <= 30) return "This month's read";
  return "This quarter's read";
}

export function windowCaption(windowDays: number): string {
  return `past ${windowDays} days`;
}

export type MetaScreenProps = {
  initialGame?: CardGame;
  initialLane?: MetaLaneFilter;
  initialWindowDays?: number;
  onBack: () => void;
  onOpenCard: (cardId: string) => void;
};

/**
 * Meta page (docs/meta-feed-mockup/Meta.dc.html): which groups of cards are
 * rising or cooling by price, per game, lane and window. Every filter change
 * refetches — the payload is computed server-side per (game, window, lane).
 */
export function MetaScreen({
  initialGame = DEFAULT_CARD_GAME,
  initialLane = 'all',
  initialWindowDays = 7,
  onBack,
  onOpenCard,
}: MetaScreenProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const [game, setGame] = useState<CardGame>(initialGame);
  const [lane, setLane] = useState<MetaLaneFilter>(initialLane);
  const [windowDays, setWindowDays] = useState<number>(initialWindowDays);
  const [selectedGroupKey, setSelectedGroupKey] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const { data: pulse, loading, refresh, status } = useMetaPageData({ game, lane, windowDays });

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  }, [refresh]);

  const games = useMemo<CardGame[]>(() => {
    const available = pulse?.availableGames ?? [];
    return available.includes(game) ? available : [game, ...available];
  }, [game, pulse?.availableGames]);

  const disabledWindows = useMemo<WindowValue[]>(() => {
    const available = pulse?.availableWindows;
    if (!available || available.length === 0) {
      return [];
    }
    return META_WINDOW_ITEMS.map((item) => item.value).filter(
      (value) => !available.includes(Number(value)) && Number(value) !== windowDays,
    );
  }, [pulse?.availableWindows, windowDays]);

  const selectGame = useCallback((next: CardGame) => {
    setGame(next);
    setSelectedGroupKey(null);
  }, []);

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={[styles.safeArea, { backgroundColor: theme.colors.gray0 }]}>
      <MetaPageHeader
        onBack={onBack}
        subtitle="What's rising and cooling, by price"
        testID="meta-header"
        title="Meta"
      />
      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + spacing.lg }}
        refreshControl={<RefreshControl onRefresh={handleRefresh} refreshing={refreshing} />}
        testID="meta-scroll"
      >
        <ScrollView
          horizontal
          contentContainerStyle={styles.gameChips}
          showsHorizontalScrollIndicator={false}
          testID="meta-game-chips"
        >
          {games.map((candidate) => (
            <PillButton
              key={candidate}
              label={gameDisplayName(candidate)}
              onPress={() => selectGame(candidate)}
              selected={candidate === game}
              style={styles.chip}
              testID={`meta-game-${candidate}`}
              tone="filter"
            />
          ))}
        </ScrollView>
        <View style={styles.segments}>
          <View style={styles.laneSegment}>
            <SegmentedControl
              items={META_LANE_ITEMS}
              onChange={(next) => {
                setLane(next);
                setSelectedGroupKey(null);
              }}
              testID="meta-lane"
              tone="inverted"
              value={lane}
            />
          </View>
          <View style={styles.windowSegment}>
            <SegmentedControl
              disabledValues={disabledWindows}
              items={META_WINDOW_ITEMS}
              onChange={(next) => setWindowDays(Number(next))}
              testID="meta-window"
              tone="inverted"
              value={String(windowDays) as WindowValue}
            />
          </View>
        </View>

        <MetaPageBody
          loading={loading}
          onOpenCard={onOpenCard}
          onRetry={() => void refresh()}
          onSelectGroup={setSelectedGroupKey}
          pulse={pulse}
          selectedGroupKey={selectedGroupKey}
          status={status}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

type MetaPageBodyProps = {
  loading: boolean;
  onOpenCard: (cardId: string) => void;
  onRetry: () => void;
  onSelectGroup: (groupKey: string) => void;
  pulse: MetaPulse | null;
  selectedGroupKey: string | null;
  status: MetaPageStatus;
};

function MetaPageBody({ loading, onOpenCard, onRetry, onSelectGroup, pulse, selectedGroupKey, status }: MetaPageBodyProps) {
  const theme = useSpotlightTheme();
  const [risingFirst, setRisingFirst] = useState(true);
  const sortedGroups = useMemo(() => {
    const groups = [...(pulse?.groups ?? [])];
    return groups.sort((a, b) =>
      risingFirst ? b.medianChangePercent - a.medianChangePercent : a.medianChangePercent - b.medianChangePercent,
    );
  }, [pulse, risingFirst]);
  if (!pulse) {
    if (status === 'loading') {
      return <MetaSkeleton />;
    }
    return (
      <View style={styles.stateWrap}>
        {status === 'disabled' ? (
          <StateCard
            message="The market read isn't switched on yet. Check back soon."
            testID="meta-disabled"
            title="Meta is coming soon"
            variant="muted"
          />
        ) : (
          <StateCard
            actionLabel="Try again"
            actionTestID="meta-retry"
            message="We couldn't load the market read. Check your connection and try again."
            onActionPress={onRetry}
            testID="meta-error"
            title="Meta isn't available right now"
          />
        )}
      </View>
    );
  }

  if (pulse.groups.length === 0) {
    return (
      <View style={styles.stateWrap}>
        <StateCard
          message="No group moved enough in this window. Try another window or game."
          testID="meta-empty"
          title="Nothing is moving yet"
          variant="muted"
        />
      </View>
    );
  }

  const selectedGroup = pulse.groups.find((group) => group.groupKey === selectedGroupKey) ?? pulse.groups[0];

  return (
    <View style={loading ? styles.stale : null} testID="meta-content">
      <HeadlineCard pulse={pulse} />
      <MetaSection
        accessory={<GroupSortToggle onToggle={() => setRisingFirst((value) => !value)} risingFirst={risingFirst} />}
        testID="meta-groups"
        title="Groups"
      >
        <GroupsTable groups={sortedGroups} onSelectGroup={onSelectGroup} selectedGroupKey={selectedGroup.groupKey} />
        <Text style={[theme.typography.cardMeta, styles.footnote]}>{GROUPS_FOOTNOTE}</Text>
      </MetaSection>
      {pulse.ladders.map((ladder, index) => (
        <LadderSection key={`${ladder.title}:${index}`} ladder={ladder} testID={`meta-ladder-${index}`} windowDays={pulse.windowDays} />
      ))}
      {selectedGroup.topCards.length > 0 ? (
        <MetaSection showBand={false} testID="meta-driving" title={`Cards driving ${selectedGroup.label}`}>
          <View style={styles.list}>
            {selectedGroup.topCards.map((card, index) => {
              const grade = gradeLabel(card.grader, card.grade);
              const meta = [
                [card.setName, card.number].filter(Boolean).join(' '),
                card.population != null ? `pop ${formatCount(card.population)}` : null,
              ].filter(Boolean).join(' · ');
              return (
                <MetaCardRow
                  key={`${card.cardId}:${card.grader ?? ''}:${card.grade ?? ''}`}
                  changePercent={card.changePercent}
                  currencyCode={card.currencyCode}
                  imageUrl={card.imageUrl}
                  meta={meta || null}
                  name={grade ? `${card.name} · ${grade}` : card.name}
                  onPress={() => onOpenCard(card.cardId)}
                  price={card.priceNow}
                  showDivider={index < selectedGroup.topCards.length - 1}
                  testID={`meta-driving-card-${card.cardId}`}
                />
              );
            })}
          </View>
        </MetaSection>
      ) : null}
    </View>
  );
}

function HeadlineCard({ pulse }: { pulse: MetaPulse }) {
  const theme = useSpotlightTheme();
  const { summary } = pulse;
  const gradedColor = useSignedColor(summary.gradedValueChangeUsd);
  const rawColor = useSignedColor(summary.rawValueChangeUsd);

  return (
    <View style={[styles.headlineWrap, { borderBottomColor: theme.colors.gray100 }]}>
      <View style={[styles.headlineCard, { backgroundColor: theme.colors.purple50 }]} testID="meta-headline">
        <Text style={[theme.typography.micro, styles.overline, { color: theme.colors.brandStrong }]}>
          {readLabel(pulse.windowDays)}
        </Text>
        <Text style={[theme.typography.titleLarge, styles.headlineTitle]}>{pulse.headline.title}</Text>
        <Text style={[theme.typography.bodySmall, styles.headlineBody, { color: theme.colors.gray700 }]}>
          {pulse.headline.body}
        </Text>
        <View style={styles.statRow}>
          <StatTile
            caption={summary.gradedValueChangeUsd == null ? 'no graded history' : formatSignedCompactUsd(summary.gradedValueChangeUsd)}
            captionColor={gradedColor}
            label="Graded value"
            testID="meta-stat-graded"
            value={summary.gradedValueChangePercent == null ? '—' : formatSignedPercent(summary.gradedValueChangePercent)}
          />
          <StatTile
            caption={summary.rawValueChangeUsd == null ? 'no raw history' : formatSignedCompactUsd(summary.rawValueChangeUsd)}
            captionColor={rawColor}
            label="Raw value"
            testID="meta-stat-raw"
            value={summary.rawValueChangePercent == null ? '—' : formatSignedPercent(summary.rawValueChangePercent)}
          />
          <StatTile
            caption="rising / cooling"
            label="Groups"
            testID="meta-stat-groups"
            value={`${summary.risingCount} ▲ ${summary.coolingCount} ▼`}
          />
        </View>
        <Text style={[theme.typography.cardMeta, styles.headlineFootnote]}>{HEADLINE_FOOTNOTE}</Text>
      </View>
    </View>
  );
}

function StatTile({
  caption,
  captionColor,
  label,
  testID,
  value,
}: {
  caption: string;
  captionColor?: string;
  label: string;
  testID: string;
  value: string;
}) {
  const theme = useSpotlightTheme();
  return (
    <View
      accessibilityLabel={`${label}: ${value}, ${caption}`}
      accessible
      style={[styles.statTile, { backgroundColor: theme.colors.gray0 }]}
      testID={testID}
    >
      <Text style={theme.typography.cardMeta}>{label}</Text>
      <Text numberOfLines={1} style={theme.typography.titleSmall}>
        {value}
      </Text>
      <Text numberOfLines={1} style={[theme.typography.cardMeta, captionColor ? { color: captionColor } : null]}>
        {caption}
      </Text>
    </View>
  );
}

/** Flips the Groups table between biggest gains first and biggest drops first. */
function GroupSortToggle({ onToggle, risingFirst }: { onToggle: () => void; risingFirst: boolean }) {
  const theme = useSpotlightTheme();
  const color = risingFirst ? theme.colors.deltaUpText : theme.colors.deltaDownText;
  const Icon = risingFirst ? ArrowUp : ArrowDown;
  return (
    <Pressable
      accessibilityHint="Changes the sort order"
      accessibilityLabel={risingFirst ? 'Sorted by biggest gains first' : 'Sorted by biggest drops first'}
      accessibilityRole="button"
      hitSlop={spacing.xs}
      onPress={onToggle}
      style={({ pressed }) => [styles.sortToggle, { opacity: pressed ? 0.7 : 1 }]}
      testID="meta-groups-sort"
    >
      <Icon color={color} height={14} strokeWidth={2.2} width={14} />
      <Text style={[theme.typography.captionStrong, { color }]}>{risingFirst ? 'Rising first' : 'Falling first'}</Text>
    </Pressable>
  );
}

function GroupsTable({
  groups,
  onSelectGroup,
  selectedGroupKey,
}: {
  groups: MetaGroup[];
  onSelectGroup: (groupKey: string) => void;
  selectedGroupKey: string;
}) {
  const theme = useSpotlightTheme();
  const headerColor = { color: theme.colors.gray700 };

  return (
    <View>
      <View style={[styles.tableRow, styles.tableHeader, { borderBottomColor: theme.colors.gray300 }]}>
        <Text style={[theme.typography.cardMetaStrong, headerColor, styles.groupColumn]}>Group</Text>
        <Text style={[theme.typography.cardMetaStrong, headerColor, styles.numeric, { width: COLUMN_WIDTHS.price }]}>Price</Text>
        <Text style={[theme.typography.cardMetaStrong, headerColor, styles.numeric, { width: COLUMN_WIDTHS.money }]}>Value</Text>
        <Text style={[theme.typography.cardMetaStrong, headerColor, styles.numeric, { width: COLUMN_WIDTHS.cards }]}>Cards</Text>
      </View>
      {groups.map((group, index) => (
        <GroupRow
          key={group.groupKey}
          group={group}
          isLast={index === groups.length - 1}
          onPress={() => onSelectGroup(group.groupKey)}
          selected={group.groupKey === selectedGroupKey}
        />
      ))}
    </View>
  );
}

function GroupRow({
  group,
  isLast,
  onPress,
  selected,
}: {
  group: MetaGroup;
  isLast: boolean;
  onPress: () => void;
  selected: boolean;
}) {
  const theme = useSpotlightTheme();
  const valueColor = useSignedColor(group.valueChangeUsd);
  const priceLabel = formatSignedPercent(group.medianChangePercent);
  const valueLabel = formatSignedCompactUsd(group.valueChangeUsd);

  return (
    <Pressable
      accessibilityHint="Shows the cards driving this group"
      accessibilityLabel={`${group.label}, ${group.lane}, price ${priceLabel}, value ${valueLabel}, ${formatCount(group.cardCount)} cards`}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.tableRow,
        styles.groupRow,
        isLast ? null : { borderBottomColor: theme.colors.gray300, borderBottomWidth: borderWidths.rule },
        selected ? { backgroundColor: theme.colors.gray50 } : null,
        { opacity: pressed ? 0.86 : 1 },
      ]}
      testID={`meta-group-${group.groupKey}`}
    >
      <View style={styles.groupColumn}>
        <View style={styles.groupLabelRow}>
          <Text numberOfLines={2} style={[theme.typography.bodyMedium, styles.groupLabel]}>
            {group.label}
          </Text>
          <LaneTag lane={group.lane} />
        </View>
        <PriceSparkline
          backgroundColor={selected ? theme.colors.gray50 : theme.colors.gray0}
          height={GROUP_SPARK.height}
          points={group.sparkPoints}
          trendPct={group.medianChangePercent}
          width={GROUP_SPARK.width}
        />
      </View>
      <View style={[styles.priceCell, { width: COLUMN_WIDTHS.price }]}>
        <DeltaPill changePercent={group.medianChangePercent} label={priceLabel} />
      </View>
      <Text numberOfLines={1} style={[theme.typography.bodyMedium, styles.numeric, { color: valueColor, width: COLUMN_WIDTHS.money }]}>
        {valueLabel}
      </Text>
      <Text numberOfLines={1} style={[theme.typography.bodyMedium, styles.numeric, { color: theme.colors.gray700, width: COLUMN_WIDTHS.cards }]}>
        {formatCount(group.cardCount)}
      </Text>
    </Pressable>
  );
}

function LadderSection({ ladder, testID, windowDays }: { ladder: MetaLadder; testID: string; windowDays: number }) {
  const theme = useSpotlightTheme();
  const maxMagnitude = Math.max(...ladder.rungs.map((rung) => Math.abs(rung.medianChangePercent)), 0);
  if (ladder.rungs.length === 0) {
    return null;
  }

  return (
    <MetaSection caption={windowCaption(windowDays)} testID={testID} title={ladder.title}>
      <View style={styles.ladder}>
        {ladder.rungs.map((rung, index) => {
          const fraction = maxMagnitude > 0 ? Math.abs(rung.medianChangePercent) / maxMagnitude : 0;
          const label = formatSignedPercent(rung.medianChangePercent);
          const up = rung.medianChangePercent >= 0;
          return (
            <View
              key={`${rung.label}:${index}`}
              accessibilityLabel={`${rung.label}, ${rung.lane}, ${label}`}
              accessible
              testID={`${testID}-rung-${index}`}
            >
              <View style={styles.rungHeader}>
                <View style={styles.groupLabelRow}>
                  <Text style={theme.typography.bodyMedium}>{rung.label}</Text>
                  <LaneTag lane={rung.lane} />
                </View>
                <Text style={[theme.typography.bodyMedium, { color: up ? theme.colors.deltaUpText : theme.colors.deltaDownText }]}>
                  {label}
                </Text>
              </View>
              <View style={[styles.barTrack, { backgroundColor: theme.colors.gray100 }]}>
                <View
                  style={[
                    styles.barFill,
                    {
                      backgroundColor: up ? theme.colors.purple500 : theme.colors.red500,
                      width: `${Math.round(fraction * 100)}%`,
                    },
                  ]}
                />
              </View>
            </View>
          );
        })}
      </View>
    </MetaSection>
  );
}

function MetaSkeleton() {
  return (
    <View style={styles.skeleton} testID="meta-loading">
      <SkeletonBlock height={220} radius={radii.lg} />
      <SkeletonBlock height={18} width="40%" />
      {Array.from({ length: 5 }).map((_, index) => (
        <SkeletonBlock key={index} height={44} radius={radii.sm} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  sortToggle: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xxxs,
  },
  barFill: {
    borderCurve: 'continuous',
    borderRadius: radii.pill,
    height: LADDER_BAR_HEIGHT,
  },
  barTrack: {
    borderCurve: 'continuous',
    borderRadius: radii.pill,
    height: LADDER_BAR_HEIGHT,
    marginTop: spacing.xxxs,
    overflow: 'hidden',
  },
  chip: {
    borderRadius: radii.pill,
  },
  footnote: {
    marginTop: spacing.xxs,
  },
  gameChips: {
    gap: spacing.xxs,
    paddingBottom: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.sm,
  },
  groupColumn: {
    flex: 1,
    gap: spacing.xxxs,
    minWidth: 0,
  },
  groupLabel: {
    flexShrink: 1,
  },
  groupLabelRow: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  groupRow: {
    alignItems: 'center',
    minHeight: 44,
    paddingVertical: 10,
  },
  headlineBody: {
    marginTop: spacing.xxs,
  },
  headlineCard: {
    borderCurve: 'continuous',
    borderRadius: radii.lg,
    padding: spacing.sm,
  },
  headlineFootnote: {
    marginTop: 10,
  },
  headlineTitle: {
    marginTop: 6,
  },
  headlineWrap: {
    borderBottomWidth: spacing.xxxs,
    paddingBottom: spacing.sm,
    paddingHorizontal: spacing.sm,
  },
  ladder: {
    gap: spacing.xs,
    marginTop: spacing.xs,
  },
  laneSegment: {},
  list: {
    marginTop: spacing.xxs,
  },
  numeric: {
    textAlign: 'right',
  },
  overline: {
    textTransform: 'uppercase',
  },
  priceCell: {
    alignItems: 'flex-end',
  },
  rungHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  safeArea: {
    flex: 1,
  },
  segments: {
    gap: spacing.xxs,
    paddingBottom: spacing.sm,
    paddingHorizontal: spacing.sm,
  },
  skeleton: {
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
  },
  stale: {
    opacity: 0.6,
  },
  stateWrap: {
    paddingHorizontal: spacing.sm,
  },
  statRow: {
    flexDirection: 'row',
    gap: spacing.xxs,
    marginTop: 14,
  },
  statTile: {
    borderCurve: 'continuous',
    borderRadius: radii.md,
    flex: 1,
    gap: 2,
    minWidth: 0,
    padding: 10,
  },
  tableHeader: {
    borderBottomWidth: borderWidths.containerRule,
    paddingBottom: 6,
    paddingTop: spacing.xs,
  },
  tableRow: {
    flexDirection: 'row',
    gap: spacing.xxs,
  },
  windowSegment: {},
});
