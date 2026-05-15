import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  PaymentsNotEnabledError,
  type PaymentOrder,
} from '@spotlight/api-client';
import {
  Button,
  SheetHeader,
  SurfaceCard,
  colors,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { ChromeBackButton } from '@/components/chrome-back-button';
import { PaymentsNotEnabledState } from '@/features/payments/components/payments-not-enabled-state';
import { QrCodeTile } from '@/features/payments/components/qr-code-tile';
import { useOrderStatus } from '@/features/payments/hooks/use-order-status';
import { useAppServices } from '@/providers/app-providers';

const TEST_PREFIX = 'sell-stripe-qr';

type SellStripeQrScreenProps = {
  orderId: string;
  onClose: () => void;
  onDone: () => void;
};

function centsToDollarsLabel(amountCents: number, currency: string) {
  const amount = (amountCents / 100).toFixed(2);
  if (currency === 'USD') {
    return `$${amount}`;
  }
  return `${amount} ${currency}`;
}

function buildStatusCopy(order: PaymentOrder | null): { title: string; subtitle: string } {
  if (!order) {
    return { title: 'Preparing checkout…', subtitle: 'Generating QR code.' };
  }

  switch (order.status) {
    case 'paid':
      return {
        title: 'Paid ✓',
        subtitle: `${centsToDollarsLabel(order.amountCents, order.currencyCode)} received.`,
      };
    case 'cancelled':
      return {
        title: 'Cancelled',
        subtitle: 'This order was cancelled before payment.',
      };
    case 'refunded':
      return { title: 'Refunded', subtitle: 'You refunded this order.' };
    case 'failed':
      return { title: 'Payment failed', subtitle: 'The buyer’s payment did not go through.' };
    case 'disputed':
      return { title: 'Disputed', subtitle: 'The buyer disputed this transaction.' };
    case 'pending':
    default:
      return {
        title: `Waiting for buyer…`,
        subtitle: `${centsToDollarsLabel(order.amountCents, order.currencyCode)} pending.`,
      };
  }
}

export function SellStripeQrScreen({ orderId, onClose, onDone }: SellStripeQrScreenProps) {
  const theme = useSpotlightTheme();
  const { spotlightRepository } = useAppServices();
  const state = useOrderStatus(orderId);
  const [isCancelling, setIsCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const handleCancel = useCallback(async () => {
    setIsCancelling(true);
    setCancelError(null);
    try {
      await spotlightRepository.cancelPaymentOrder(orderId);
      onClose();
    } catch (error) {
      if (error instanceof PaymentsNotEnabledError) {
        setCancelError(error.message);
        return;
      }
      setCancelError(error instanceof Error ? error.message : 'Could not cancel order.');
    } finally {
      setIsCancelling(false);
    }
  }, [onClose, orderId, spotlightRepository]);

  const statusCopy = useMemo(
    () => buildStatusCopy(state.kind === 'ready' ? state.order : null),
    [state],
  );

  if (state.kind === 'not_enabled') {
    return (
      <SafeAreaView edges={['top', 'left', 'right', 'bottom']} style={[styles.safeArea, { backgroundColor: colors.gray0 }]}>
        <View style={styles.content}>
          <ChromeBackButton onPress={onClose} testID={`${TEST_PREFIX}-close`} />
          <PaymentsNotEnabledState message={state.message} testID={`${TEST_PREFIX}-not-enabled`} />
        </View>
      </SafeAreaView>
    );
  }

  if (state.kind === 'loading') {
    return (
      <SafeAreaView edges={['top', 'left', 'right', 'bottom']} style={[styles.safeArea, { backgroundColor: colors.gray0 }]}>
        <View style={[styles.content, styles.loading]} testID={`${TEST_PREFIX}-loading`}>
          <ActivityIndicator color={theme.colors.brand} />
          <Text style={[theme.typography.body, { color: theme.colors.textSecondary }]}>
            Preparing payment…
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  if (state.kind === 'error') {
    return (
      <SafeAreaView edges={['top', 'left', 'right', 'bottom']} style={[styles.safeArea, { backgroundColor: colors.gray0 }]}>
        <View style={styles.content}>
          <ChromeBackButton onPress={onClose} testID={`${TEST_PREFIX}-close`} />
          <SurfaceCard padding={20} radius={24} testID={`${TEST_PREFIX}-error`}>
            <SheetHeader subtitle={state.message} title="Could not load order" />
            <Button label="Close" onPress={onClose} variant="secondary" />
          </SurfaceCard>
        </View>
      </SafeAreaView>
    );
  }

  const { order } = state;
  const isPaid = order.status === 'paid';
  const isTerminal =
    order.status === 'paid' ||
    order.status === 'cancelled' ||
    order.status === 'refunded' ||
    order.status === 'failed' ||
    order.status === 'disputed';
  const qrUrl = order.qrUrl ?? order.checkoutUrl ?? '';

  return (
    <SafeAreaView edges={['top', 'left', 'right', 'bottom']} style={[styles.safeArea, { backgroundColor: colors.gray0 }]}>
      <View style={styles.content}>
        <ChromeBackButton onPress={onClose} testID={`${TEST_PREFIX}-close`} />

        <SheetHeader
          subtitle={statusCopy.subtitle}
          title={statusCopy.title}
          titleStyleVariant="title"
        />

        {qrUrl && !isPaid ? (
          <QrCodeTile qrUrl={qrUrl} testID={`${TEST_PREFIX}-tile`} />
        ) : null}

        {isPaid ? (
          <SurfaceCard padding={24} radius={24} testID={`${TEST_PREFIX}-paid-card`}>
            <Text
              style={[theme.typography.title, styles.paidText, { color: theme.colors.textPrimary }]}
              testID={`${TEST_PREFIX}-paid-label`}
            >
              Paid ✓
            </Text>
          </SurfaceCard>
        ) : null}

        {cancelError ? (
          <SurfaceCard padding={16} radius={20} testID={`${TEST_PREFIX}-cancel-error`} variant="muted">
            <Text style={[theme.typography.body, { color: theme.colors.textPrimary }]}>{cancelError}</Text>
          </SurfaceCard>
        ) : null}

        <View style={styles.footer}>
          {!isTerminal ? (
            <Button
              disabled={isCancelling}
              label={isCancelling ? 'Cancelling…' : 'Cancel'}
              onPress={handleCancel}
              testID={`${TEST_PREFIX}-cancel`}
              variant="secondary"
            />
          ) : null}
          {isTerminal ? (
            <Button
              label="Done"
              onPress={onDone}
              size="lg"
              testID={`${TEST_PREFIX}-done`}
            />
          ) : null}
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  content: {
    flex: 1,
    gap: 16,
    padding: 16,
  },
  footer: {
    gap: 12,
    marginTop: 'auto',
  },
  loading: {
    alignItems: 'center',
    gap: 12,
    justifyContent: 'center',
  },
  paidText: {
    textAlign: 'center',
  },
  safeArea: {
    flex: 1,
  },
});
