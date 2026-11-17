import { Check } from 'iconoir-react-native';
import { StyleSheet, View } from 'react-native';

import type { AssistantProposedAction } from '@spotlight/api-client';
import { Button, Text, radii, spacing, useSpotlightTheme } from '@spotlight/design-system';

export type AssistantActionUiState =
  | { status: 'proposed' }
  | { status: 'running' }
  | { status: 'done' }
  | { status: 'dismissed' }
  | { status: 'failed'; message: string };

export function initialActionUiState(action: AssistantProposedAction): AssistantActionUiState {
  if (action.state === 'confirmed') {
    return { status: 'done' };
  }
  if (action.state === 'dismissed') {
    return { status: 'dismissed' };
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
  }
}

type AssistantActionCardProps = {
  action: AssistantProposedAction;
  state: AssistantActionUiState;
  onConfirm: (action: AssistantProposedAction) => void;
  onDismiss: (action: AssistantProposedAction) => void;
};

export function AssistantActionCard({ action, state, onConfirm, onDismiss }: AssistantActionCardProps) {
  const theme = useSpotlightTheme();
  const testID = `assistant-action-${action.id}`;
  const showButtons = state.status === 'proposed' || state.status === 'running' || state.status === 'failed';

  return (
    <View
      style={[styles.card, { backgroundColor: theme.colors.purple50, borderColor: theme.colors.purple200 }]}
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
            label={state.status === 'running' ? 'Working…' : 'Confirm'}
            labelStyleVariant="control"
            onPress={() => onConfirm(action)}
            size="sm"
            style={styles.button}
            testID={`${testID}-confirm`}
            variant="dark"
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
          <Text style={[theme.typography.captionMedium, { color: theme.colors.gray600 }]}>
            {state.status === 'done' ? doneCopy(action) : 'Dismissed'}
          </Text>
        </View>
      )}
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
