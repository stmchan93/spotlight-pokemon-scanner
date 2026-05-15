import { useCallback, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Switch, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PaymentsNotEnabledError, type RefundedOrder } from '@spotlight/api-client';
import {
  Button,
  SectionHeader,
  SheetHeader,
  SurfaceCard,
  TextField,
  colors,
} from '@spotlight/design-system';

import { ChromeBackButton } from '@/components/chrome-back-button';
import { PaymentsNotEnabledState } from '@/features/payments/components/payments-not-enabled-state';
import { useAppServices } from '@/providers/app-providers';

const REFUND_TEST_PREFIX = 'refund-sheet';

export type RefundSheetProps = {
  orderId: string;
  /** Card name shown in the header. Falls back to "this sale" when omitted. */
  cardName?: string | null;
  /** Original captured amount in dollars. Used for the full-refund label. */
  soldAmount: number;
  currencyCode?: string | null;
  /** When true, the order is already refunded — render a read-only state. */
  alreadyRefunded?: boolean;
  onClose: () => void;
  onRefundCompleted?: (refunded: RefundedOrder) => void;
};

function formatCurrency(amount: number, currencyCode: string) {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currencyCode,
    }).format(amount);
  } catch {
    return `$${amount.toFixed(2)}`;
  }
}

function parsePartialAmount(text: string, maxDollars: number): number | null {
  const cleaned = text.replace(/[^0-9.]/g, '');
  if (!cleaned) {
    return null;
  }
  const parsed = Number.parseFloat(cleaned);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  const rounded = Number(parsed.toFixed(2));
  if (rounded > maxDollars + 1e-6) {
    return null;
  }
  return rounded;
}

/**
 * Seller-initiated refund sheet. Wraps the
 * `refundPaymentOrder` repository method and surfaces:
 *  - full refund toggle (default on)
 *  - partial amount input when toggled off
 *  - inline error states for invalid amount / already-refunded / payments
 *    not enabled in env (503 → PaymentsNotEnabledError)
 *
 * Reused from both the sales-history sheet route and any future inline
 * sale-detail screens. See `/docs/payments-mvp-plan-2026-05-15.md` Phase 5.
 */
export function RefundSheet({
  alreadyRefunded = false,
  cardName,
  currencyCode = 'USD',
  onClose,
  onRefundCompleted,
  orderId,
  soldAmount,
}: RefundSheetProps) {
  const { spotlightRepository } = useAppServices();
  const resolvedCurrency = currencyCode || 'USD';
  const [fullRefund, setFullRefund] = useState(true);
  const [partialText, setPartialText] = useState('');
  const [submitState, setSubmitState] = useState<'idle' | 'submitting'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [paymentsDisabled, setPaymentsDisabled] = useState<string | null>(null);

  const partialAmount = useMemo(
    () => parsePartialAmount(partialText, soldAmount),
    [partialText, soldAmount],
  );

  const canSubmit = !alreadyRefunded && (fullRefund || partialAmount != null);

  const handleSubmit = useCallback(async () => {
    if (alreadyRefunded) {
      return;
    }
    if (!fullRefund && partialAmount == null) {
      setErrorMessage(`Enter an amount between $0.01 and ${formatCurrency(soldAmount, resolvedCurrency)}.`);
      return;
    }
    setSubmitState('submitting');
    setErrorMessage(null);

    try {
      const amountCents = fullRefund
        ? undefined
        : Math.round((partialAmount ?? 0) * 100);
      const result = await spotlightRepository.refundPaymentOrder(orderId, {
        amountCents,
      });
      onRefundCompleted?.(result);
    } catch (error) {
      if (error instanceof PaymentsNotEnabledError) {
        setPaymentsDisabled(error.message);
      } else if (error instanceof Error) {
        // Surface backend hints (already_refunded → 409, amount_invalid → 400)
        // via the inline error card. The string itself comes from the backend
        // body so it can stay user-friendly without us hard-coding messages.
        setErrorMessage(error.message);
      } else {
        setErrorMessage('Could not issue refund. Please try again.');
      }
    } finally {
      setSubmitState('idle');
    }
  }, [
    alreadyRefunded,
    fullRefund,
    onRefundCompleted,
    orderId,
    partialAmount,
    resolvedCurrency,
    soldAmount,
    spotlightRepository,
  ]);

  if (paymentsDisabled) {
    return (
      <SafeAreaView
        edges={['top', 'left', 'right', 'bottom']}
        style={[styles.safeArea, { backgroundColor: colors.gray0 }]}
      >
        <View style={styles.content}>
          <ChromeBackButton onPress={onClose} testID={`${REFUND_TEST_PREFIX}-close`} />
          <PaymentsNotEnabledState
            message={paymentsDisabled}
            testID={`${REFUND_TEST_PREFIX}-not-enabled`}
          />
        </View>
      </SafeAreaView>
    );
  }

  const subtitle = `${cardName ?? 'This sale'} • Sold for ${formatCurrency(soldAmount, resolvedCurrency)}`;

  return (
    <SafeAreaView
      edges={['top', 'left', 'right', 'bottom']}
      style={[styles.safeArea, { backgroundColor: colors.gray0 }]}
    >
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        testID={`${REFUND_TEST_PREFIX}-scroll`}
      >
        <ChromeBackButton onPress={onClose} testID={`${REFUND_TEST_PREFIX}-close`} />
        <SheetHeader showHandle subtitle={subtitle} title="Refund sale" />

        {alreadyRefunded ? (
          <SurfaceCard padding={20} radius={24} testID={`${REFUND_TEST_PREFIX}-already-refunded`} variant="muted">
            <SectionHeader
              subtitle="This sale has already been refunded. No further action is needed."
              title="Already refunded"
            />
            <Button label="Close" onPress={onClose} variant="secondary" />
          </SurfaceCard>
        ) : (
          <>
            <SurfaceCard padding={20} radius={24}>
              <View style={styles.toggleRow}>
                <View style={styles.toggleCopy}>
                  <SectionHeader
                    subtitle={`Returns ${formatCurrency(soldAmount, resolvedCurrency)} to the buyer.`}
                    title="Refund full amount"
                  />
                </View>
                <Switch
                  accessibilityLabel="Refund full amount"
                  onValueChange={(next) => {
                    setFullRefund(next);
                    setErrorMessage(null);
                  }}
                  testID={`${REFUND_TEST_PREFIX}-full-toggle`}
                  value={fullRefund}
                />
              </View>
            </SurfaceCard>

            {!fullRefund ? (
              <SurfaceCard padding={20} radius={24}>
                <SectionHeader title="Partial amount" />
                <TextField
                  helperText={`Maximum ${formatCurrency(soldAmount, resolvedCurrency)}.`}
                  keyboardType="decimal-pad"
                  label="Refund amount"
                  leading={null}
                  maxLength={8}
                  onChangeText={(value) => {
                    setPartialText(value);
                    setErrorMessage(null);
                  }}
                  placeholder={soldAmount.toFixed(2)}
                  testID={`${REFUND_TEST_PREFIX}-partial-input`}
                  value={partialText}
                />
              </SurfaceCard>
            ) : null}

            {errorMessage ? (
              <SurfaceCard
                padding={16}
                radius={20}
                testID={`${REFUND_TEST_PREFIX}-error`}
                variant="muted"
              >
                <SectionHeader subtitle={errorMessage} title="Could not refund" />
              </SurfaceCard>
            ) : null}

            <Button
              disabled={!canSubmit || submitState === 'submitting'}
              label={
                submitState === 'submitting'
                  ? 'Refunding…'
                  : fullRefund
                    ? `Refund ${formatCurrency(soldAmount, resolvedCurrency)}`
                    : partialAmount != null
                      ? `Refund ${formatCurrency(partialAmount, resolvedCurrency)}`
                      : 'Refund'
              }
              onPress={handleSubmit}
              size="lg"
              testID={`${REFUND_TEST_PREFIX}-submit`}
            />
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: 16,
    padding: 16,
  },
  safeArea: {
    flex: 1,
  },
  toggleCopy: {
    flex: 1,
  },
  toggleRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
  },
});
