import { Check } from 'iconoir-react-native';
import { StyleSheet, View } from 'react-native';

import type { AssistantProposedAction } from '@spotlight/api-client';
import { Button, Text, radii, spacing, useSpotlightTheme } from '@spotlight/design-system';

import { isExecutedAssistantAction } from '@/features/assistant/assistant-action-runner';

export type AssistantActionUiState =
  | { status: 'proposed' }
  | { status: 'running' }
  | { status: 'done'; note?: string }
  | { status: 'dismissed' }
  | { status: 'failed'; message: string }
  | { status: 'undoing' }
  | { status: 'undone' };

export function initialActionUiState(action: AssistantProposedAction): AssistantActionUiState {
  if (action.state === 'confirmed' || action.state === 'done') {
    return { status: 'done' };
  }
  if (action.state === 'dismissed') {
    return { status: 'dismissed' };
  }
  if (action.state === 'undone') {
    return { status: 'undone' };
  }
  return { status: 'proposed' };
}

function doneCopy(action: AssistantProposedAction): string {
  switch (action.type) {
    case 'add_to_collection':
      return 'Added to your collection';
    case 'update_holding':
      return 'Collection updated';
    case 'watch_card':
      return action.params.targetPriceUsd != null ? 'On your Watchlist with an alert' : 'Added to your Watchlist';
    case 'remove_holding':
      return 'Removed from your collection';
    case 'move_holding':
      return action.params.collectionName ? `Moved to ${action.params.collectionName}` : 'Moved';
    case 'create_collection':
      return 'Collection created';
    case 'add_tray_to_collection':
      return 'Added to your collection';
    case 'swap_tray_card':
      return 'Changed in your scan tray';
    case 'remove_tray_card':
      return 'Removed from your scan tray';
  }
}

/** Removes are destructive: red card and a red Remove button. */
export function isDestructiveAction(action: AssistantProposedAction): boolean {
  return action.type === 'remove_holding' || action.type === 'remove_tray_card';
}

function undoAvailable(action: AssistantProposedAction, now = Date.now()): boolean {
  if (!action.undo) {
    return false;
  }
  const expiresAt = action.undo.expiresAt ? Date.parse(action.undo.expiresAt) : Number.NaN;
  return Number.isNaN(expiresAt) || expiresAt > now;
}

type AssistantActionCardProps = {
  action: AssistantProposedAction;
  state: AssistantActionUiState;
  onConfirm: (action: AssistantProposedAction) => void;
  onDismiss: (action: AssistantProposedAction) => void;
  onUndo?: (action: AssistantProposedAction) => void;
};

/** A server-executed add: "✓ Added …" with Undo, no Confirm. */
function ExecutedActionCard({ action, state, onUndo }: Omit<AssistantActionCardProps, 'onConfirm' | 'onDismiss'>) {
  const theme = useSpotlightTheme();
  const testID = `assistant-action-${action.id}`;
  const undone = state.status === 'undone';
  const canUndo = !undone && onUndo != null && undoAvailable(action);

  return (
    <View
      style={[styles.card, styles.executed, { backgroundColor: theme.colors.purple50, borderColor: theme.colors.purple200 }]}
      testID={testID}
    >
      <View style={styles.executedText}>
        <View style={styles.resolved} testID={`${testID}-${undone ? 'undone' : 'done'}`}>
          {undone ? null : <Check color={theme.colors.green500} height={16} strokeWidth={2} width={16} />}
          <Text style={[theme.typography.bodyStrong, styles.shrink]}>{action.summary}</Text>
        </View>
        {undone ? (
          <Text style={[theme.typography.captionMedium, { color: theme.colors.gray600 }]}>
            Undone · removed from your collection
          </Text>
        ) : null}
        {state.status === 'failed' ? (
          <Text style={[theme.typography.caption, { color: theme.colors.dangerStrong }]} testID={`${testID}-error`}>
            {state.message}
          </Text>
        ) : null}
      </View>
      {canUndo ? (
        <Button
          disabled={state.status === 'undoing'}
          label={state.status === 'undoing' ? 'Undoing…' : 'Undo'}
          labelStyleVariant="control"
          onPress={() => onUndo?.(action)}
          size="sm"
          testID={`${testID}-undo`}
          variant="outline"
        />
      ) : null}
    </View>
  );
}

export function AssistantActionCard({ action, state, onConfirm, onDismiss, onUndo }: AssistantActionCardProps) {
  const theme = useSpotlightTheme();
  const testID = `assistant-action-${action.id}`;

  if (isExecutedAssistantAction(action)) {
    return <ExecutedActionCard action={action} onUndo={onUndo} state={state} />;
  }

  const showButtons = state.status === 'proposed' || state.status === 'running' || state.status === 'failed';
  const destructive = isDestructiveAction(action);

  return (
    <View
      style={[
        styles.card,
        destructive
          ? { backgroundColor: theme.colors.red50, borderColor: theme.colors.red100 }
          : { backgroundColor: theme.colors.purple50, borderColor: theme.colors.purple200 },
      ]}
      testID={testID}
    >
      <Text style={theme.typography.bodyStrong}>{action.summary}</Text>
      {state.status === 'failed' ? (
        <Text style={[theme.typography.caption, { color: theme.colors.dangerStrong }]} testID={`${testID}-error`}>
          {state.message}
        </Text>
      ) : null}
      {showButtons ? (
        <View style={styles.buttons}>
          <Button
            disabled={state.status === 'running'}
            label={state.status === 'running' ? 'Working…' : destructive ? 'Remove' : 'Confirm'}
            labelStyleVariant="control"
            onPress={() => onConfirm(action)}
            size="sm"
            style={styles.button}
            testID={`${testID}-confirm`}
            variant={destructive ? 'destructive' : 'dark'}
          />
          <Button
            disabled={state.status === 'running'}
            label="Dismiss"
            labelStyleVariant="control"
            onPress={() => onDismiss(action)}
            size="sm"
            style={styles.button}
            testID={`${testID}-dismiss`}
            variant="outline"
          />
        </View>
      ) : (
        <View style={styles.resolved} testID={`${testID}-${state.status}`}>
          {state.status === 'done' ? (
            <Check color={theme.colors.green500} height={16} strokeWidth={2} width={16} />
          ) : null}
          <Text style={[theme.typography.captionMedium, styles.shrink, { color: theme.colors.gray600 }]}>
            {state.status === 'done' ? doneCopy(action) : 'Dismissed'}
          </Text>
        </View>
      )}
      {state.status === 'done' && state.note ? (
        <Text style={[theme.typography.caption, { color: theme.colors.gray600 }]} testID={`${testID}-note`}>
          {state.note}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderCurve: 'continuous',
    borderRadius: radii.md,
    borderWidth: 1,
    gap: spacing.xxs,
    padding: spacing.xs,
  },
  executed: {
    alignItems: 'center',
    flexDirection: 'row',
  },
  executedText: {
    flex: 1,
    gap: spacing.xxxs,
  },
  shrink: {
    flexShrink: 1,
  },
  buttons: {
    flexDirection: 'row',
    gap: spacing.xxs,
  },
  button: {
    flex: 1,
  },
  resolved: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xxxs,
  },
});
