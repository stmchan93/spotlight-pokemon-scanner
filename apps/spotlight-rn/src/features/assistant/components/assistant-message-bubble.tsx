import type { ReactNode } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import type { AssistantMessage, AssistantProposedAction } from '@spotlight/api-client';
import { Text, layout, radii, spacing, useSpotlightTheme } from '@spotlight/design-system';

import { AssistantRichText } from '@/features/assistant/assistant-markdown';
import {
  AssistantActionCard,
  initialActionUiState,
  type AssistantActionUiState,
} from '@/features/assistant/components/assistant-action-card';
import { AssistantCardTile } from '@/features/assistant/components/assistant-card-tile';

type AssistantMessageBubbleProps = {
  message: AssistantMessage;
  actionStates: Readonly<Record<string, AssistantActionUiState>>;
  onOpenCard: (cardId: string) => void;
  onConfirmAction: (action: AssistantProposedAction, message: AssistantMessage) => void;
  onDismissAction: (action: AssistantProposedAction) => void;
};

export function AssistantMessageBubble({
  message,
  actionStates,
  onOpenCard,
  onConfirmAction,
  onDismissAction,
}: AssistantMessageBubbleProps) {
  const theme = useSpotlightTheme();
  const testID = `assistant-message-${message.id}`;

  if (message.role === 'user') {
    return <UserBubble testID={testID} text={message.text} />;
  }

  return (
    <View style={styles.assistantColumn} testID={testID}>
      <View style={[styles.bubble, styles.assistantBubble, { backgroundColor: theme.colors.gray100 }]}>
        <AssistantRichText
          color={message.status === 'error' ? theme.colors.dangerStrong : theme.colors.textPrimary}
          testID={`${testID}-text`}
          text={message.text}
        />
      </View>
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
    </View>
  );
}

export function UserBubble({
  text,
  testID,
  footer,
  dimmed = false,
}: {
  text: string;
  testID?: string;
  footer?: ReactNode;
  dimmed?: boolean;
}) {
  const theme = useSpotlightTheme();
  return (
    <View style={styles.userColumn} testID={testID}>
      <View
        style={[
          styles.bubble,
          styles.userBubble,
          { backgroundColor: theme.colors.purple500, opacity: dimmed ? 0.6 : 1 },
        ]}
      >
        <Text style={[theme.typography.body, { color: theme.colors.gray0 }]}>{text}</Text>
      </View>
      {footer}
    </View>
  );
}

const styles = StyleSheet.create({
  assistantColumn: {
    alignItems: 'flex-start',
    gap: spacing.xxs,
  },
  userColumn: {
    alignItems: 'flex-end',
    gap: spacing.xxxs,
  },
  bubble: {
    borderCurve: 'continuous',
    borderRadius: radii.lg,
    maxWidth: '86%',
    paddingHorizontal: spacing.xs,
    paddingVertical: spacing.xxs,
  },
  assistantBubble: {
    borderBottomLeftRadius: radii.sm,
  },
  userBubble: {
    borderBottomRightRadius: radii.sm,
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
