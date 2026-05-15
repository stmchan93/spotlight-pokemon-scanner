import { StateCard } from '@spotlight/design-system';

type PaymentsNotEnabledStateProps = {
  message?: string;
  onRetry?: () => void;
  testID?: string;
};

/**
 * Renders the "Payments aren't enabled in this environment" empty state.
 * Surfaces when the backend reports HTTP 503 for any /payments/* endpoint
 * (e.g. live Stripe keys are not configured in this environment).
 */
export function PaymentsNotEnabledState({
  message,
  onRetry,
  testID = 'payments-not-enabled-state',
}: PaymentsNotEnabledStateProps) {
  return (
    <StateCard
      actionLabel={onRetry ? 'Try again' : undefined}
      actionTestID={onRetry ? `${testID}-retry` : undefined}
      actionVariant="secondary"
      centered
      message={
        message
          ?? 'Stripe is not configured in this environment yet. Switch to a build with live keys to use payments.'
      }
      onActionPress={onRetry}
      testID={testID}
      title="Payments aren’t enabled"
      variant="muted"
    />
  );
}
