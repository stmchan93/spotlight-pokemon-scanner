import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';

import type {
  AssistantCardRef,
  AssistantFeedbackInput,
  AssistantMessage,
  AssistantProposedAction,
  AssistantSetRef,
} from '@spotlight/api-client';
import { layout, radii, SectionHeader, spacing, Text, useSpotlightTheme } from '@spotlight/design-system';

import { AssistantRichText } from '@/features/assistant/assistant-markdown';
import {
  AssistantActionCard,
  initialActionUiState,
  type AssistantActionUiState,
} from '@/features/assistant/components/assistant-action-card';
import { AssistantCardRows } from '@/features/assistant/components/assistant-card-row';
import { AssistantCardTile } from '@/features/assistant/components/assistant-card-tile';
import { AssistantFeedbackControls } from '@/features/assistant/components/assistant-feedback';
import { AssistantPriceChartCard } from '@/features/assistant/components/assistant-price-chart';
import { AssistantSetTile } from '@/features/assistant/components/assistant-set-tile';
import { AssistantVerdictCard } from '@/features/assistant/components/assistant-verdict-card';

const ENTER_MS = 220;
export const ASSISTANT_PICK_HINT = 'Tap to pick';
const PRESSED_OPACITY = 0.7;

/**
 * A subtle rise-and-fade for rows that arrive while the user watches.
 * Layout animations default to `ReduceMotion.System`, so Reduce Motion skips it.
 */
export const assistantRowEntering = FadeInDown.duration(ENTER_MS);

/**
 * 2+ cards in a price answer (a chart, or any card with a sparkline): render them
 * all as compact rows. Other multi-card answers (art, collection) keep the tile rail.
 */
export function isAssistantPriceList(message: Pick<AssistantMessage, 'cards' | 'charts'>): boolean {
  if (message.cards.length < 2) {
    return false;
  }
  return (message.charts?.length ?? 0) > 0 || message.cards.some((card) => card.sparkline != null);
}

/** The text a long-press copies: the reply without its markdown markers. */
export function assistantCopyText(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^\s*#{1,3}\s+/gm, '')
    .trim();
}

type AssistantMessageBubbleProps = {
  message: AssistantMessage;
  actionStates: Readonly<Record<string, AssistantActionUiState>>;
  onOpenCard: (cardId: string) => void;
  /** Set tiles (set-level answers); omitted = set tiles don't navigate. */
  onOpenSet?: (set: AssistantSetRef) => void;
  /** "View all N" under a capped Watchlist preview; omitted = no link. */
  onOpenWatchlist?: () => void;
  onConfirmAction: (action: AssistantProposedAction, message: AssistantMessage) => void;
  onDismissAction: (action: AssistantProposedAction) => void;
  /**
   * A tap-to-pick reply (message.choice): tapping a tile picks that printing.
   * Omitted (e.g. an older reply) = tiles open the card page as usual.
   */
  onPickCard?: (card: AssistantCardRef, message: AssistantMessage) => void;
  /** Undo on a server-executed add. */
  onUndoAction?: (action: AssistantProposedAction) => void;
  onCopy?: (text: string) => void;
  /** 👍/👎 under assistant replies; omitted = no controls. */
  onFeedback?: (message: AssistantMessage, input: AssistantFeedbackInput) => void;
  /** Animate in: only for rows that arrive live, never for a loaded history. */
  animateEntrance?: boolean;
  /** Rendered under the reply (the latest reply's follow-up chips). */
  footer?: ReactNode;
};

/** One copy kind of a card: raw, or a grader + grade slab. */
function assistantSlabKey(ref: { cardId: string; grader: string | null; grade: string | null }): string {
  const grader = (ref.grader ?? '').trim().toUpperCase();
  return grader ? `${ref.cardId}|${grader}|${(ref.grade ?? '').trim()}` : ref.cardId;
}

export function AssistantMessageBubble({
  message,
  actionStates,
  onOpenCard,
  onOpenSet,
  onOpenWatchlist,
  onConfirmAction,
  onDismissAction,
  onUndoAction,
  onPickCard,
  onCopy,
  onFeedback,
  animateEntrance = false,
  footer,
}: AssistantMessageBubbleProps) {
  const theme = useSpotlightTheme();
  const testID = `assistant-message-${message.id}`;
  const viewAll = message.cardsViewAll && onOpenWatchlist ? message.cardsViewAll : null;
  // The header shows for a label, or to carry "View all" (titled after its screen).
  const cardsTitle = message.cardsLabel || (viewAll ? 'Your Watchlist' : null);
  const sets = message.sets ?? [];
  const allCharts = message.charts ?? [];
  // A price answer about 2+ cards: every card is a compact row with its own sparkline,
  // never one big chart beside plain tiles. Single-card answers keep the big chart.
  const picking = message.choice != null && onPickCard != null;
  // Choice tiles stay a tile rail: each one is a tap target, not a price row.
  const asRows = !picking && isAssistantPriceList(message);
  const rowIds = new Set(asRows ? message.cards.map((card) => card.cardId) : []);
  const charts = allCharts.filter((chart) => !rowIds.has(chart.cardId));
  // A chart answer about exactly the charted card(s): the chart card carries the art,
  // so a lone tile underneath would only repeat it.
  // Keyed by slab too: a raw chart doesn't stand in for the CGC copy's tile.
  const chartKeys = new Set(charts.map(assistantSlabKey));
  const tilesRepeatCharts =
    !picking &&
    charts.length > 0 && message.cards.length > 0 && message.cards.every((card) => chartKeys.has(assistantSlabKey(card)));
  const verdicts = message.verdicts ?? [];
  // A single-card deal / grading card carries the art: a lone tile underneath would repeat it.
  const verdictIds = new Set(
    verdicts.flatMap((verdict): string[] => {
      if (verdict.kind === 'grading') {
        return verdict.cards.map((card) => card.cardId);
      }
      return verdict.kind === 'deal' ? verdict.items.map((item) => item.cardId) : [];
    }),
  );
  const tilesRepeatVerdict =
    !picking && verdicts.length > 0 && message.cards.length > 0 && message.cards.every((card) => verdictIds.has(card.cardId));
  const tileCards = tilesRepeatCharts || tilesRepeatVerdict ? [] : message.cards;

  if (message.role === 'user') {
    return <UserBubble animateEntrance={animateEntrance} onCopy={onCopy} testID={testID} text={message.text} />;
  }

  return (
    <Animated.View entering={animateEntrance ? assistantRowEntering : undefined} style={styles.assistantColumn} testID={testID}>
      {/* Full-width plain text, no bubble — the reply reads like a page, as in Claude/ChatGPT. */}
      <Pressable
        accessibilityHint="Long press to copy"
        delayLongPress={350}
        onLongPress={onCopy ? () => onCopy(assistantCopyText(message.text)) : undefined}
        style={({ pressed }) => (pressed && onCopy ? { opacity: PRESSED_OPACITY } : null)}
        testID={`${testID}-press`}
      >
        <AssistantRichText
          color={message.status === 'error' ? theme.colors.dangerStrong : theme.colors.gray800}
          strongColor={message.status === 'error' ? theme.colors.dangerStrong : theme.colors.gray900}
          testID={`${testID}-text`}
          text={message.text}
        />
      </Pressable>
      {verdicts.map((verdict, index) => (
        <AssistantVerdictCard
          key={`${verdict.kind}-${index}`}
          onOpenCard={onOpenCard}
          testID={`${testID}-verdict-${index}`}
          verdict={verdict}
        />
      ))}
      {charts.map((chart, index) => (
        <AssistantPriceChartCard
          card={
            message.cards.find((card) => assistantSlabKey(card) === assistantSlabKey(chart))
            ?? message.cards.find((card) => card.cardId === chart.cardId)
            ?? null
          }
          chart={chart}
          key={`${chart.cardId}-${index}`}
          onOpenCard={onOpenCard}
          testID={`${testID}-chart-${index}`}
        />
      ))}
      {sets.length > 0 ? (
        // Set-level answers ("which sets are up?") show the sets, not cards.
        <ScrollView
          contentContainerStyle={styles.cardRail}
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.cardRailScroller}
          testID={`${testID}-sets`}
        >
          {sets.map((set, index) => (
            <AssistantSetTile
              key={`${set.setId}-${index}`}
              onPress={(next) => onOpenSet?.(next)}
              set={set}
              testID={`assistant-set-${set.setId}`}
            />
          ))}
        </ScrollView>
      ) : null}
      {tileCards.length > 0 && cardsTitle ? (
        <View style={styles.cardsHeader}>
          <SectionHeader
            actionLabel={viewAll ? `View all ${viewAll.total}` : undefined}
            actionTestID={`${testID}-cards-view-all`}
            onActionPress={viewAll ? onOpenWatchlist : undefined}
            size="compact"
            testID={`${testID}-cards-label`}
            title={cardsTitle}
          />
        </View>
      ) : null}
      {tileCards.length > 0 && asRows ? (
        <AssistantCardRows cards={tileCards} onOpenCard={onOpenCard} testID={`${testID}-rows`} />
      ) : null}
      {tileCards.length > 0 && !asRows ? (
        <ScrollView
          contentContainerStyle={styles.cardRail}
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.cardRailScroller}
          testID={`${testID}-cards`}
        >
          {tileCards.map((card, index) => (
            <AssistantCardTile
              card={card}
              key={`${card.cardId}-${index}`}
              onLongPress={picking ? onOpenCard : undefined}
              onPress={picking ? () => onPickCard?.(card, message) : onOpenCard}
              pickHint={picking ? ASSISTANT_PICK_HINT : undefined}
              testID={`assistant-card-${card.cardId}`}
            />
          ))}
        </ScrollView>
      ) : null}
      {message.actions.map((action) => (
        <AssistantActionCard
          action={action}
          key={action.id}
          onConfirm={(next) => onConfirmAction(next, message)}
          onDismiss={onDismissAction}
          onUndo={onUndoAction}
          state={actionStates[action.id] ?? initialActionUiState(action)}
        />
      ))}
      {onFeedback ? (
        <AssistantFeedbackControls
          feedback={message.feedback ?? null}
          onChange={(input) => onFeedback(message, input)}
          testID={`${testID}-feedback`}
        />
      ) : null}
      {footer}
    </Animated.View>
  );
}

export function UserBubble({
  text,
  testID,
  footer,
  dimmed = false,
  animateEntrance = false,
  onCopy,
}: {
  text: string;
  testID?: string;
  footer?: ReactNode;
  dimmed?: boolean;
  animateEntrance?: boolean;
  onCopy?: (text: string) => void;
}) {
  const theme = useSpotlightTheme();
  return (
    <Animated.View entering={animateEntrance ? assistantRowEntering : undefined} style={styles.userColumn} testID={testID}>
      <Pressable
        accessibilityHint={onCopy ? 'Long press to copy' : undefined}
        delayLongPress={350}
        onLongPress={onCopy ? () => onCopy(text) : undefined}
        style={({ pressed }) => [
          styles.userBubble,
          {
            backgroundColor: theme.colors.gray100,
            opacity: dimmed ? 0.6 : pressed && onCopy ? PRESSED_OPACITY : 1,
          },
        ]}
      >
        <Text style={[theme.typography.chatBody, { color: theme.colors.gray900 }]}>{text}</Text>
      </Pressable>
      {footer}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  // 16pt between the reply's text and its card images (Figma 6528:16791).
  assistantColumn: {
    alignSelf: 'stretch',
    gap: spacing.sm,
  },
  userColumn: {
    alignItems: 'flex-end',
    gap: spacing.xxxs,
  },
  // Gray-100, right-aligned, no tail, 12pt padding, 289 of 361 wide (Figma 6502:16698).
  userBubble: {
    borderCurve: 'continuous',
    borderRadius: radii.lg,
    maxWidth: '80%',
    padding: spacing.xs,
  },
  // Pulls the header onto its rail; the column gap would split them.
  cardsHeader: {
    marginBottom: -spacing.xxs,
  },
  // Bleeds to the screen edges so the rail scrolls under the gutter.
  cardRailScroller: {
    alignSelf: 'stretch',
    marginHorizontal: -layout.pageGutter,
  },
  cardRail: {
    gap: spacing.xs,
    paddingHorizontal: layout.pageGutter,
  },
});
