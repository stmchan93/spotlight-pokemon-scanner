import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';

import type { AssistantFeedbackInput, AssistantMessage, AssistantProposedAction } from '@spotlight/api-client';
import { layout, radii, SectionHeader, spacing, Text, useSpotlightTheme } from '@spotlight/design-system';

import { AssistantRichText } from '@/features/assistant/assistant-markdown';
import {
  AssistantActionCard,
  initialActionUiState,
  type AssistantActionUiState,
} from '@/features/assistant/components/assistant-action-card';
import { AssistantCardTile } from '@/features/assistant/components/assistant-card-tile';
import { AssistantFeedbackControls } from '@/features/assistant/components/assistant-feedback';
import { AssistantPriceChartCard } from '@/features/assistant/components/assistant-price-chart';

const ENTER_MS = 220;
const PRESSED_OPACITY = 0.7;

/**
 * A subtle rise-and-fade for rows that arrive while the user watches.
 * Layout animations default to `ReduceMotion.System`, so Reduce Motion skips it.
 */
export const assistantRowEntering = FadeInDown.duration(ENTER_MS);

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
  /** "View all N" under a capped Watchlist preview; omitted = no link. */
  onOpenWatchlist?: () => void;
  onConfirmAction: (action: AssistantProposedAction, message: AssistantMessage) => void;
  onDismissAction: (action: AssistantProposedAction) => void;
  onCopy?: (text: string) => void;
  /** 👍/👎 under assistant replies; omitted = no controls. */
  onFeedback?: (message: AssistantMessage, input: AssistantFeedbackInput) => void;
  /** Animate in: only for rows that arrive live, never for a loaded history. */
  animateEntrance?: boolean;
  /** Rendered under the reply (the latest reply's follow-up chips). */
  footer?: ReactNode;
};

export function AssistantMessageBubble({
  message,
  actionStates,
  onOpenCard,
  onOpenWatchlist,
  onConfirmAction,
  onDismissAction,
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
          color={message.status === 'error' ? theme.colors.dangerStrong : theme.colors.textPrimary}
          testID={`${testID}-text`}
          text={message.text}
        />
      </Pressable>
      {(message.charts ?? []).map((chart, index) => (
        <AssistantPriceChartCard
          chart={chart}
          key={`${chart.cardId}-${index}`}
          onOpenCard={onOpenCard}
          testID={`${testID}-chart-${index}`}
        />
      ))}
      {message.cards.length > 0 && cardsTitle ? (
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
      {message.cards.length > 0 ? (
        <ScrollView
          contentContainerStyle={styles.cardRail}
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.cardRailScroller}
          testID={`${testID}-cards`}
        >
          {message.cards.map((card, index) => (
            <AssistantCardTile
              card={card}
              key={`${card.cardId}-${index}`}
              onPress={onOpenCard}
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
        <Text style={[theme.typography.bodyLarge, { color: theme.colors.textPrimary }]}>{text}</Text>
      </Pressable>
      {footer}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  assistantColumn: {
    alignSelf: 'stretch',
    gap: spacing.xs,
  },
  userColumn: {
    alignItems: 'flex-end',
    gap: spacing.xxxs,
  },
  // Soft gray, right-aligned, no tail: the question is context, the reply is the content.
  userBubble: {
    borderCurve: 'continuous',
    borderRadius: radii.xl,
    maxWidth: '85%',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
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
    gap: spacing.xxs,
    paddingHorizontal: layout.pageGutter,
  },
});
