import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';

import type {
  CardGame,
  CardGradingAnalysis,
  CardGradingOutcome,
  CardGradingVerdict,
} from '@spotlight/api-client';
import {
  Button,
  SheetHeader,
  SheetSurface,
  SkeletonBlock,
  Text,
  borderWidths,
  layout,
  spacing,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { EkalightAiFlare } from '@/components/ekalight-ai-glyph';
import { assistantHref } from '@/features/assistant/assistant-route';
import { formatCurrency } from '@/features/portfolio/components/portfolio-formatting';
import { useReduceMotion } from '@/features/scanner/use-reduce-motion';
import { AnalyticsEvent } from '@/lib/observability/analytics-events';
import { capturePostHogEvent } from '@/lib/observability/posthog';
import { useAppServices } from '@/providers/app-providers';

export const GRADING_VERDICT_HEADLINES: Record<CardGradingVerdict, string> = {
  worth_it: 'Worth grading',
  only_at_10: 'Only worth it at a PSA 10',
  not_worth_it: 'Not worth grading',
};

// Session cache per card + printing; null = the server had too few sales.
const analysisCache = new Map<string, CardGradingAnalysis | null>();

function cacheKey(cardId: string, variant: string | null) {
  return `${cardId}|${variant ?? ''}`;
}

export function clearGradingAnalysisCache() {
  analysisCache.clear();
}

// Estimates: whole dollars from $10 up, cents below.
function usd(value: number) {
  const digits = Math.abs(value) >= 10 ? 0 : 2;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function shortDate(iso: string | null): string | null {
  const match = iso ? /^(\d{4})-(\d{2})-(\d{2})/.exec(iso) : null;
  if (!match) {
    return iso;
  }
  const month = MONTHS[Number(match[2]) - 1];
  return month ? `${month} ${Number(match[3])}, ${match[1]}` : iso;
}

type SheetState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'empty' }
  | { kind: 'result'; analysis: CardGradingAnalysis };

type GradingAnalysisSheetProps = {
  visible: boolean;
  onClose: () => void;
  cardId: string;
  /** The selected printing label, sent as `variant`. */
  variant: string | null;
  game: CardGame | null | undefined;
  cardName: string;
  setName: string;
  cardNumber: string;
  testID?: string;
};

function ShimmerSkeleton({ testID }: { testID: string }) {
  const theme = useSpotlightTheme();
  const reduceMotion = useReduceMotion();
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (reduceMotion) {
      return undefined;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.45, duration: 700, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity, reduceMotion]);

  return (
    <Animated.View style={[styles.skeleton, { opacity }]} testID={testID}>
      <SkeletonBlock height={22} radius={theme.radii.xs} width="60%" />
      <SkeletonBlock height={14} radius={theme.radii.xs} />
      <SkeletonBlock height={14} radius={theme.radii.xs} width="85%" />
      <SkeletonBlock height={44} radius={theme.radii.sm} />
      <SkeletonBlock height={44} radius={theme.radii.sm} />
    </Animated.View>
  );
}

function OutcomeRow({ outcome, testID }: { outcome: CardGradingOutcome; testID: string }) {
  const theme = useSpotlightTheme();
  const good = outcome.gainVsRawUsd > 0;
  const keep = outcome.netUsd >= 0
    ? `you keep ~${usd(outcome.netUsd)}`
    : `you lose ~${usd(Math.abs(outcome.netUsd))}`;
  return (
    <View style={[styles.row, { borderColor: theme.colors.gray100 }]} testID={testID}>
      <Text style={[theme.typography.label, styles.rowGrade, { color: theme.colors.gray900 }]}>
        {`PSA ${outcome.grade}`}
      </Text>
      <Text numberOfLines={1} style={[theme.typography.body, styles.rowMiddle, { color: theme.colors.gray900 }]}>
        {`${usd(outcome.priceUsd)} → ${keep}`}
      </Text>
      <Text
        accessibilityLabel={good ? 'Beats selling raw' : 'Worse than selling raw'}
        style={[theme.typography.label, { color: good ? theme.colors.green500 : theme.colors.red500 }]}
        testID={`${testID}-mark`}
      >
        {good ? '✓' : '✗'}
      </Text>
    </View>
  );
}

/** "✦ Ekalight analysis": is grading this card with PSA worth it? */
export function GradingAnalysisSheet({
  visible,
  onClose,
  cardId,
  variant,
  game,
  cardName,
  setName,
  cardNumber,
  testID = 'grading-analysis-sheet',
}: GradingAnalysisSheetProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { spotlightRepository } = useAppServices();
  const [state, setState] = useState<SheetState>({ kind: 'loading' });
  const requestRef = useRef(0);

  const load = useCallback((force: boolean) => {
    const key = cacheKey(cardId, variant);
    const request = ++requestRef.current;
    if (!force && analysisCache.has(key)) {
      const cached = analysisCache.get(key) ?? null;
      setState(cached ? { kind: 'result', analysis: cached } : { kind: 'empty' });
      return;
    }
    setState({ kind: 'loading' });
    spotlightRepository
      .getCardGradingAnalysis({ cardId, variant, grader: 'PSA' })
      .then((analysis) => {
        analysisCache.set(key, analysis);
        if (request === requestRef.current) {
          setState(analysis ? { kind: 'result', analysis } : { kind: 'empty' });
        }
      })
      .catch(() => {
        if (request === requestRef.current) {
          setState({ kind: 'error' });
        }
      });
  }, [cardId, spotlightRepository, variant]);

  const openedPropsRef = useRef({ cardId, game });
  openedPropsRef.current = { cardId, game };
  useEffect(() => {
    if (visible) {
      const opened = openedPropsRef.current;
      capturePostHogEvent(AnalyticsEvent.gradingAnalysisOpened, { cardId: opened.cardId, game: opened.game ?? 'pokemon' });
    }
  }, [visible]);

  useEffect(() => {
    if (!visible) {
      requestRef.current += 1;
      return;
    }
    load(false);
  }, [load, visible]);

  const resultVerdict = state.kind === 'result' ? state.analysis.verdict : null;
  const resultSource = state.kind === 'result' ? state.analysis.summarySource : null;
  useEffect(() => {
    if (visible && resultVerdict && resultSource) {
      capturePostHogEvent(AnalyticsEvent.gradingAnalysisResult, { verdict: resultVerdict, summarySource: resultSource });
    }
  }, [resultSource, resultVerdict, visible]);

  const askEkalight = useCallback(() => {
    capturePostHogEvent(AnalyticsEvent.gradingAnalysisAskEkalight, { game: game ?? 'pokemon' });
    const where = [setName, cardNumber].filter(Boolean).join(' ');
    const prompt = `Is my ${cardName}${where ? ` (${where})` : ''} worth grading with PSA? Help me pick a tier.`;
    const page = {
      kind: 'card' as const,
      label: [cardName, setName].filter(Boolean).join(' · ') || null,
      params: { card_id: cardId, grader: 'PSA', ...(variant ? { variant } : {}) },
    };
    // Close first: a presented Modal would sit over the pushed chat.
    onClose();
    router.push(assistantHref('home', [], game ?? null, page, prompt));
  }, [cardId, cardName, cardNumber, game, onClose, router, setName, variant]);

  if (!visible) {
    return null;
  }

  const renderBody = () => {
    switch (state.kind) {
      case 'loading':
        return (
          <View style={styles.block}>
            <Text style={[theme.typography.body, { color: theme.colors.gray600 }]} testID={`${testID}-loading`}>
              Analyzing…
            </Text>
            <ShimmerSkeleton testID={`${testID}-skeleton`} />
          </View>
        );
      case 'error':
        return (
          <View style={styles.block} testID={`${testID}-error`}>
            <Text style={[theme.typography.body, { color: theme.colors.gray900 }]}>
              Couldn’t load the analysis. Check your connection and try again.
            </Text>
            <Button
              label="Try again"
              labelStyleVariant="label"
              onPress={() => load(true)}
              shape="rounded"
              testID={`${testID}-retry`}
              variant="outline"
            />
          </View>
        );
      case 'empty':
        return (
          <Text style={[theme.typography.body, { color: theme.colors.gray900 }]} testID={`${testID}-empty`}>
            Not enough PSA sales to judge this card yet.
          </Text>
        );
      case 'result': {
        const { analysis } = state;
        const costs = [
          analysis.tier.name,
          // The fee is PSA's exact price; shipping is an estimate.
          `${formatCurrency(analysis.tier.feeUsd)} + ~${usd(analysis.shippingUsd)} shipping`,
          analysis.tier.turnaroundText,
        ].filter(Boolean).join(' · ');
        const feesAsOf = shortDate(analysis.feesAsOf);
        return (
          <View style={styles.block} testID={`${testID}-result`}>
            <Text style={[theme.typography.titleSmall, { color: theme.colors.gray900 }]} testID={`${testID}-headline`}>
              {GRADING_VERDICT_HEADLINES[analysis.verdict]}
            </Text>
            {analysis.summary ? (
              <Text style={[theme.typography.body, { color: theme.colors.textSecondary }]} testID={`${testID}-summary`}>
                {analysis.summary}
              </Text>
            ) : null}
            <View>
              {analysis.outcomes.map((outcome) => (
                <OutcomeRow key={outcome.grade} outcome={outcome} testID={`${testID}-outcome-${outcome.grade}`} />
              ))}
              <View style={[styles.row, { borderColor: theme.colors.gray100 }]} testID={`${testID}-raw`}>
                <Text style={[theme.typography.label, styles.rowGrade, { color: theme.colors.gray600 }]}>Raw NM</Text>
                <Text style={[theme.typography.body, styles.rowMiddle, { color: theme.colors.gray600 }]}>
                  {usd(analysis.rawPriceUsd)}
                </Text>
              </View>
            </View>
            <View style={styles.costs}>
              <Text style={[theme.typography.caption, { color: theme.colors.gray900 }]} testID={`${testID}-costs`}>
                {costs}
              </Text>
              <Text style={[theme.typography.overline, { color: theme.colors.gray600 }]} testID={`${testID}-fees-caption`}>
                {`Fees: PSA${feesAsOf ? `, as of ${feesAsOf}` : ''} · estimates, not a guarantee`}
              </Text>
            </View>
          </View>
        );
      }
      default:
        return null;
    }
  };

  return (
    <Modal animationType="slide" onRequestClose={onClose} transparent visible>
      <Pressable
        accessibilityLabel="Close"
        accessibilityRole="button"
        onPress={onClose}
        style={styles.backdrop}
        testID={`${testID}-backdrop`}
      />
      <SheetSurface
        padding={0}
        style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, spacing.sm) }]}
        testID={testID}
      >
        <SheetHeader style={styles.header} title="✦ Ekalight analysis" />
        <ScrollView contentContainerStyle={styles.body}>
          {renderBody()}
          <Button
            label="Ask Ekalight"
            labelStyleVariant="label"
            leadingAccessory={<EkalightAiFlare size={18} />}
            onPress={askEkalight}
            shape="rounded"
            testID={`${testID}-ask`}
            variant="outline"
          />
        </ScrollView>
      </SheetSurface>
    </Modal>
  );
}

const styles = StyleSheet.create({
  // Same dim as the app's other modal sheets.
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
  },
  block: {
    gap: spacing.xs,
  },
  body: {
    gap: spacing.md,
    paddingHorizontal: layout.pageGutter,
    paddingTop: spacing.xs,
  },
  costs: {
    gap: spacing.xxxs,
  },
  header: {
    paddingHorizontal: layout.pageGutter,
    paddingTop: spacing.md,
  },
  row: {
    alignItems: 'center',
    borderBottomWidth: borderWidths.ruleSnapped,
    flexDirection: 'row',
    gap: spacing.xs,
    paddingVertical: spacing.xs,
  },
  rowGrade: {
    width: 64,
  },
  rowMiddle: {
    flex: 1,
  },
  sheet: {
    bottom: 0,
    left: 0,
    maxHeight: '80%',
    position: 'absolute',
    right: 0,
  },
  skeleton: {
    gap: spacing.xxs,
  },
});
