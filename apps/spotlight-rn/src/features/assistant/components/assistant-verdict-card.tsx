import { useEffect, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import type {
  AssistantDealVerdict,
  AssistantGradingVerdict,
  AssistantTradeSide,
  AssistantTradeVerdict,
  AssistantVerdict,
  AssistantVerdictItem,
} from '@spotlight/api-client';
import { AppText, radii, spacing, Text, useSpotlightTheme } from '@spotlight/design-system';

import { CachedImage } from '@/components/cached-image';
import { formatCurrency } from '@/features/portfolio/components/portfolio-formatting';

// Same thumb as the assistant card rows (tile art ratio 86x120).
const THUMB_WIDTH = 40;
const THUMB_HEIGHT = 56;
const THUMB_RADIUS = 4;
const MAX_TRADE_NAMES = 4;

type Tone = 'good' | 'neutral' | 'bad' | 'unknown';

const TONES: Record<string, Tone> = {
  good_buy: 'good',
  strong_offer: 'good',
  worth_grading: 'good',
  fair: 'neutral',
  typical_offer: 'neutral',
  slightly_uneven: 'neutral',
  grade_if_confident_10: 'neutral',
  above_market: 'bad',
  low_offer: 'bad',
  uneven: 'bad',
  not_worth_it: 'bad',
};

const GRADING_LABELS: Record<string, string> = {
  worth_grading: 'Worth grading',
  grade_if_confident_10: 'Only for a 10',
  not_worth_it: 'Not worth it',
  no_comps: 'No graded sales',
  no_raw_price: 'No raw price',
};

export function verdictTone(code: string | null | undefined): Tone {
  return (code && TONES[code]) || 'unknown';
}

/** "$1,234.56"; negative nets as "-$12.00", positive as "+$12.00" when signed. */
export function verdictMoney(value: number | null | undefined, { signed = false } = {}): string {
  if (value == null) {
    return '—';
  }
  const text = formatCurrency(Math.abs(value), 'USD');
  if (value < 0) {
    return `-${text}`;
  }
  return signed && value > 0 ? `+${text}` : text;
}

function pctText(value: number | null | undefined): string {
  return value == null ? '—' : `${Math.round(value)}%`;
}

function itemMeta(item: AssistantVerdictItem): string {
  const where = [item.setName, item.number ? `#${item.number}` : ''].filter(Boolean).join(' ');
  const state = item.grader
    ? `${item.grader} ${item.grade ?? ''}`.trim()
    : item.condition
      ? `${item.condition}${item.conditionAssumed ? ' assumed' : ''}`
      : '';
  return [where, item.variant, state].filter(Boolean).join(' · ');
}

function VerdictChip({ label, tone, testID }: { label: string; tone: Tone; testID?: string }) {
  const theme = useSpotlightTheme();
  const palette = {
    good: { bg: theme.colors.green100, fg: theme.colors.green500 },
    neutral: { bg: theme.colors.yellow50, fg: theme.colors.gray900 },
    bad: { bg: theme.colors.red100, fg: theme.colors.dangerStrong },
    unknown: { bg: theme.colors.gray100, fg: theme.colors.gray600 },
  }[tone];
  return (
    <View style={[styles.chip, { backgroundColor: palette.bg }]} testID={testID}>
      <Text style={[theme.typography.captionMedium, { color: palette.fg }]}>{label}</Text>
    </View>
  );
}

function Thumb({ uri, testID }: { uri: string | null; testID?: string }) {
  const theme = useSpotlightTheme();
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [uri]);
  const show = Boolean(uri) && !failed;
  return (
    <View style={[styles.thumb, { backgroundColor: show ? theme.colors.gray100 : theme.colors.field }]}>
      {show ? (
        <CachedImage contentFit="contain" onError={() => setFailed(true)} style={styles.fill} testID={testID} uri={uri} />
      ) : (
        <AppText color="textSecondary" variant="micro">
          CARD
        </AppText>
      )}
    </View>
  );
}

function Figure({ label, value, testID }: { label: string; value: string; testID?: string }) {
  const theme = useSpotlightTheme();
  return (
    <View style={styles.figure}>
      <Text style={[theme.typography.caption, { color: theme.colors.gray600 }]}>{label}</Text>
      <Text style={[theme.typography.labelStrong, { color: theme.colors.gray900 }]} testID={testID}>
        {value}
      </Text>
    </View>
  );
}

function Shell({ children, testID }: { children: ReactNode; testID?: string }) {
  const theme = useSpotlightTheme();
  return (
    <View style={[styles.card, { backgroundColor: theme.colors.gray0, borderColor: theme.colors.gray200 }]} testID={testID}>
      {children}
    </View>
  );
}

function soldsLine(item: AssistantVerdictItem): string | null {
  if (!item.solds) {
    return null;
  }
  const average = item.solds.averageUsd != null ? ` · avg ${verdictMoney(item.solds.averageUsd)}` : '';
  return `${item.solds.count} recent sale${item.solds.count === 1 ? '' : 's'}${average}`;
}

function DealCard({ verdict, onOpenCard, testID }: { verdict: AssistantDealVerdict; onOpenCard: (id: string) => void; testID: string }) {
  const theme = useSpotlightTheme();
  const selling = verdict.side === 'selling';
  return (
    <Shell testID={testID}>
      <View style={styles.header}>
        <VerdictChip label={verdict.label} testID={`${testID}-chip`} tone={verdictTone(verdict.verdict)} />
        {verdict.pctOfMarket != null ? (
          <Text style={[theme.typography.captionMedium, { color: theme.colors.gray600 }]} testID={`${testID}-pct`}>
            {pctText(verdict.pctOfMarket)} of market
          </Text>
        ) : null}
      </View>
      {verdict.items.map((item, index) => {
        const sold = soldsLine(item);
        return (
          <Pressable
            accessibilityHint="Opens the card page"
            accessibilityRole="button"
            key={`${item.cardId}-${index}`}
            onPress={() => onOpenCard(item.cardId)}
            style={({ pressed }) => [styles.itemRow, { opacity: pressed ? 0.7 : 1 }]}
            testID={`${testID}-item-${item.cardId}`}
          >
            <Thumb uri={item.imageSmallUrl} />
            <View style={styles.copy}>
              <Text numberOfLines={1} style={[theme.typography.labelStrong, { color: theme.colors.gray900 }]}>
                {item.quantity > 1 ? `${item.quantity}× ` : ''}{item.name}
              </Text>
              <Text numberOfLines={1} style={[theme.typography.caption, { color: theme.colors.gray600 }]}>
                {itemMeta(item)}
              </Text>
              {sold ? (
                <Text numberOfLines={1} style={[theme.typography.caption, { color: theme.colors.gray600 }]} testID={`${testID}-solds`}>
                  {sold}
                </Text>
              ) : null}
            </View>
            <Text style={[theme.typography.bodyMedium, { color: theme.colors.gray900 }]}>
              {item.priceUsd != null ? verdictMoney(item.priceUsd) : 'No price'}
            </Text>
          </Pressable>
        );
      })}
      <View style={[styles.figures, { borderTopColor: theme.colors.gray200 }]}>
        <Figure label={selling ? 'Offer' : 'Asking'} testID={`${testID}-asking`} value={verdictMoney(verdict.askingUsd)} />
        <Figure label="Market" testID={`${testID}-market`} value={verdictMoney(verdict.marketUsd)} />
        <Figure label="% of market" value={pctText(verdict.pctOfMarket)} />
      </View>
      {verdict.unpricedCount > 0 ? (
        <Text style={[theme.typography.caption, { color: theme.colors.gray600 }]}>
          {verdict.unpricedCount} card{verdict.unpricedCount === 1 ? ' has' : 's have'} no price
        </Text>
      ) : null}
    </Shell>
  );
}

function TradeColumn({ side, testID }: { side: AssistantTradeSide; testID: string }) {
  const theme = useSpotlightTheme();
  const names = side.items.map((item) => `${item.quantity > 1 ? `${item.quantity}× ` : ''}${item.name}`);
  const extra = names.length - MAX_TRADE_NAMES;
  return (
    <View style={styles.column} testID={testID}>
      <Text style={[theme.typography.caption, { color: theme.colors.gray600 }]}>{side.label}</Text>
      <Text style={[theme.typography.labelStrong, { color: theme.colors.gray900 }]} testID={`${testID}-total`}>
        {side.totalUsd != null ? verdictMoney(side.totalUsd) : '—'}
      </Text>
      {names.slice(0, MAX_TRADE_NAMES).map((name, index) => (
        <Text key={`${name}-${index}`} numberOfLines={1} style={[theme.typography.caption, { color: theme.colors.gray800 }]}>
          {name}
        </Text>
      ))}
      {extra > 0 ? (
        <Text style={[theme.typography.caption, { color: theme.colors.gray600 }]}>+{extra} more</Text>
      ) : null}
      {side.unpricedCount > 0 ? (
        <Text style={[theme.typography.caption, { color: theme.colors.gray600 }]}>{side.unpricedCount} unpriced</Text>
      ) : null}
    </View>
  );
}

export function tradeGapLine(verdict: AssistantTradeVerdict): string | null {
  if (verdict.gapUsd == null || verdict.gapPct == null) {
    return null;
  }
  const who = verdict.favors === 'you' ? ' · you get more' : verdict.favors === 'them' ? ' · you give more' : '';
  return `Gap ${verdictMoney(verdict.gapUsd)} (${pctText(verdict.gapPct)})${who}`;
}

function TradeCard({ verdict, testID }: { verdict: AssistantTradeVerdict; testID: string }) {
  const theme = useSpotlightTheme();
  const gap = tradeGapLine(verdict);
  const balance = verdict.balance;
  return (
    <Shell testID={testID}>
      <View style={styles.header}>
        <VerdictChip label={verdict.label} testID={`${testID}-chip`} tone={verdictTone(verdict.verdict)} />
      </View>
      <View style={styles.columns}>
        <TradeColumn side={verdict.sideA} testID={`${testID}-side-a`} />
        <View style={[styles.columnDivider, { backgroundColor: theme.colors.gray200 }]} />
        <TradeColumn side={verdict.sideB} testID={`${testID}-side-b`} />
      </View>
      {gap ? (
        <Text style={[theme.typography.captionMedium, { color: theme.colors.gray800 }]} testID={`${testID}-gap`}>
          {gap}
        </Text>
      ) : null}
      {balance ? (
        <Text style={[theme.typography.caption, { color: theme.colors.gray600 }]} testID={`${testID}-balance`}>
          To even it: {balance.whoAdds === 'you' ? 'you add' : 'they add'} ~{verdictMoney(balance.cashUsd)}
        </Text>
      ) : null}
    </Shell>
  );
}

function GradingCard({ verdict, onOpenCard, testID }: { verdict: AssistantGradingVerdict; onOpenCard: (id: string) => void; testID: string }) {
  const theme = useSpotlightTheme();
  const feeNote = verdict.fees.placeholder
    ? 'After typical grading fees + return shipping'
    : `After grading fee + return shipping${verdict.fees.asOf ? ` · fees as of ${verdict.fees.asOf}` : ''}`;
  return (
    <Shell testID={testID}>
      {verdict.cards.map((card) => (
        <View key={card.cardId} style={styles.gradingCard} testID={`${testID}-card-${card.cardId}`}>
          <Pressable
            accessibilityHint="Opens the card page"
            accessibilityRole="button"
            onPress={() => onOpenCard(card.cardId)}
            style={({ pressed }) => [styles.itemRow, { opacity: pressed ? 0.7 : 1 }]}
          >
            <Thumb uri={card.imageSmallUrl} />
            <View style={styles.copy}>
              <Text numberOfLines={1} style={[theme.typography.labelStrong, { color: theme.colors.gray900 }]}>
                {card.name}
              </Text>
              <Text numberOfLines={1} style={[theme.typography.caption, { color: theme.colors.gray600 }]}>
                Raw {verdictMoney(card.rawPriceUsd)}
              </Text>
            </View>
            {card.recommendation ? (
              <VerdictChip
                label={GRADING_LABELS[card.recommendation] ?? card.recommendation}
                testID={`${testID}-chip-${card.cardId}`}
                tone={verdictTone(card.recommendation)}
              />
            ) : null}
          </Pressable>
          {card.scenarios.map((row) => {
            const color = row.netUsd == null
              ? theme.colors.gray600
              : row.netUsd > 0
                ? theme.colors.green500
                : theme.colors.dangerStrong;
            return (
              <View key={`${row.grader}-${row.grade}`} style={styles.scenario} testID={`${testID}-row-${row.grader}-${row.grade}`}>
                <Text style={[theme.typography.captionMedium, styles.scenarioGrade, { color: theme.colors.gray900 }]}>
                  {row.grader} {row.grade}
                </Text>
                <Text style={[theme.typography.caption, styles.scenarioComp, { color: theme.colors.gray600 }]}>
                  {row.compPriceUsd != null ? verdictMoney(row.compPriceUsd) : 'No recent sale'}
                </Text>
                <Text style={[theme.typography.captionMedium, { color }]}>
                  {row.netUsd != null ? verdictMoney(row.netUsd, { signed: true }) : '—'}
                </Text>
              </View>
            );
          })}
        </View>
      ))}
      <Text style={[theme.typography.caption, { color: theme.colors.gray600 }]} testID={`${testID}-fees`}>
        {feeNote}
      </Text>
    </Shell>
  );
}

type AssistantVerdictCardProps = {
  verdict: AssistantVerdict;
  onOpenCard: (cardId: string) => void;
  testID: string;
};

/** The finished verdict under a deal / trade / grading answer; the text only explains it. */
export function AssistantVerdictCard({ verdict, onOpenCard, testID }: AssistantVerdictCardProps) {
  switch (verdict.kind) {
    case 'deal':
      return <DealCard onOpenCard={onOpenCard} testID={testID} verdict={verdict} />;
    case 'trade':
      return <TradeCard testID={testID} verdict={verdict} />;
    case 'grading':
      return <GradingCard onOpenCard={onOpenCard} testID={testID} verdict={verdict} />;
    default:
      return null;
  }
}

const styles = StyleSheet.create({
  card: {
    borderCurve: 'continuous',
    borderRadius: radii.md,
    borderWidth: 1,
    gap: spacing.xxs,
    padding: spacing.xs,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xxs,
  },
  chip: {
    borderCurve: 'continuous',
    borderRadius: radii.sm,
    paddingHorizontal: spacing.xxs,
    paddingVertical: spacing.xxxs,
  },
  itemRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xxs,
  },
  thumb: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: THUMB_RADIUS,
    height: THUMB_HEIGHT,
    justifyContent: 'center',
    overflow: 'hidden',
    width: THUMB_WIDTH,
  },
  fill: {
    height: '100%',
    width: '100%',
  },
  copy: {
    flex: 1,
    minWidth: 0,
  },
  figures: {
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    paddingTop: spacing.xxs,
  },
  figure: {
    flex: 1,
  },
  columns: {
    flexDirection: 'row',
    gap: spacing.xs,
  },
  column: {
    flex: 1,
    gap: spacing.xxxs,
    minWidth: 0,
  },
  columnDivider: {
    width: StyleSheet.hairlineWidth,
  },
  gradingCard: {
    gap: spacing.xxxs,
  },
  scenario: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xxs,
  },
  scenarioGrade: {
    width: THUMB_WIDTH + spacing.xxs + spacing.xs,
  },
  scenarioComp: {
    flex: 1,
  },
});
