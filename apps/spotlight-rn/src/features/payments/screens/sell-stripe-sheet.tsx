import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  PaymentsNotEnabledError,
  deckConditionOptions,
  type InventoryCardEntry,
} from '@spotlight/api-client';
import {
  Button,
  SectionHeader,
  SheetHeader,
  SurfaceCard,
  TextField,
  colors,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { ChromeBackButton } from '@/components/chrome-back-button';
import { PaymentsNotEnabledState } from '@/features/payments/components/payments-not-enabled-state';
import { useAppServices } from '@/providers/app-providers';

type SellStripeSheetProps = {
  entryId: string;
  onClose: () => void;
  /** Called with the new orderId once a Checkout Session is created. */
  onOrderCreated: (orderId: string) => void;
};

const SELL_STRIPE_TEST_PREFIX = 'sell-stripe';

function parsePrice(text: string): number | null {
  const cleaned = text.replace(/[^0-9.]/g, '');
  if (!cleaned) {
    return null;
  }
  const parsed = Number.parseFloat(cleaned);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Number(parsed.toFixed(2));
}

/**
 * Sell-via-Stripe sheet. Parallel to the existing manual sell flow under
 * features/sell/. Creates a Checkout Session order and hands the orderId
 * to the parent so it can route to the QR display screen.
 *
 * TODO(payments-mvp): see /docs/payments-mvp-plan-2026-05-15.md — long-term
 * we will likely migrate the existing manual sell flow to this surface.
 */
export function SellStripeSheet({ entryId, onClose, onOrderCreated }: SellStripeSheetProps) {
  const theme = useSpotlightTheme();
  const { spotlightRepository } = useAppServices();
  const [entry, setEntry] = useState<InventoryCardEntry | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [priceText, setPriceText] = useState('');
  const [conditionCode, setConditionCode] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [submitState, setSubmitState] = useState<'idle' | 'submitting'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [paymentsDisabled, setPaymentsDisabled] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setErrorMessage(null);

    void spotlightRepository
      .getInventoryEntries()
      .then((inventory) => {
        if (cancelled) {
          return;
        }
        const next = inventory.find((candidate) => candidate.id === entryId) ?? null;
        setEntry(next);
        setConditionCode(next?.conditionCode ?? null);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setEntry(null);
        setErrorMessage('Could not load this inventory card.');
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [entryId, spotlightRepository]);

  const parsedAmount = useMemo(() => parsePrice(priceText), [priceText]);

  const handleSubmit = useCallback(async () => {
    if (!entry) {
      return;
    }
    if (parsedAmount == null) {
      setErrorMessage('Enter a sale price greater than $0 before continuing.');
      return;
    }
    setSubmitState('submitting');
    setErrorMessage(null);

    try {
      const response = await spotlightRepository.createPaymentOrder({
        deckEntryId: entry.id,
        amountCents: Math.round(parsedAmount * 100),
        condition: conditionCode ?? entry.conditionCode ?? null,
        description: description.trim() ? description.trim() : null,
      });
      onOrderCreated(response.orderId);
    } catch (error) {
      if (error instanceof PaymentsNotEnabledError) {
        setPaymentsDisabled(error.message);
      } else {
        setErrorMessage(error instanceof Error ? error.message : 'Could not create order.');
      }
    } finally {
      setSubmitState('idle');
    }
  }, [conditionCode, description, entry, onOrderCreated, parsedAmount, spotlightRepository]);

  if (paymentsDisabled) {
    return (
      <SafeAreaView edges={['top', 'left', 'right', 'bottom']} style={[styles.safeArea, { backgroundColor: colors.gray0 }]}>
        <View style={styles.content}>
          <ChromeBackButton onPress={onClose} testID={`${SELL_STRIPE_TEST_PREFIX}-close`} />
          <PaymentsNotEnabledState message={paymentsDisabled} testID={`${SELL_STRIPE_TEST_PREFIX}-not-enabled`} />
        </View>
      </SafeAreaView>
    );
  }

  if (isLoading) {
    return (
      <SafeAreaView edges={['top', 'left', 'right', 'bottom']} style={[styles.safeArea, { backgroundColor: colors.gray0 }]}>
        <View style={[styles.content, styles.loading]} testID={`${SELL_STRIPE_TEST_PREFIX}-loading`}>
          <ActivityIndicator color={theme.colors.brand} />
        </View>
      </SafeAreaView>
    );
  }

  if (!entry) {
    return (
      <SafeAreaView edges={['top', 'left', 'right', 'bottom']} style={[styles.safeArea, { backgroundColor: colors.gray0 }]}>
        <View style={styles.content}>
          <ChromeBackButton onPress={onClose} testID={`${SELL_STRIPE_TEST_PREFIX}-close`} />
          <SurfaceCard padding={20} radius={24}>
            <SheetHeader
              subtitle="This inventory card could not be found."
              title="Card unavailable"
            />
            <Button label="Close" onPress={onClose} variant="secondary" />
          </SurfaceCard>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={['top', 'left', 'right', 'bottom']} style={[styles.safeArea, { backgroundColor: colors.gray0 }]}>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        testID={`${SELL_STRIPE_TEST_PREFIX}-scroll`}
      >
        <ChromeBackButton onPress={onClose} testID={`${SELL_STRIPE_TEST_PREFIX}-close`} />
        <SheetHeader
          showHandle
          subtitle={`${entry.name} • ${entry.setName}`}
          title="Sell with Stripe"
        />

        <SurfaceCard padding={20} radius={24}>
          <SectionHeader title="Price" />
          <TextField
            helperText="Amount in USD. Buyer pays this via Stripe Checkout."
            keyboardType="decimal-pad"
            label="Sale price"
            leading={null}
            maxLength={8}
            onChangeText={(value) => {
              setPriceText(value);
              setErrorMessage(null);
            }}
            placeholder="40.00"
            testID={`${SELL_STRIPE_TEST_PREFIX}-price-input`}
            value={priceText}
          />
        </SurfaceCard>

        <SurfaceCard padding={20} radius={24}>
          <SectionHeader title="Condition" />
          <View style={styles.conditionRow} testID={`${SELL_STRIPE_TEST_PREFIX}-condition-row`}>
            {deckConditionOptions.map((option) => (
              <Button
                key={option.code}
                label={option.shortLabel}
                onPress={() => setConditionCode(option.code)}
                size="sm"
                testID={`${SELL_STRIPE_TEST_PREFIX}-condition-${option.code}`}
                variant={conditionCode === option.code ? 'primary' : 'secondary'}
              />
            ))}
          </View>
        </SurfaceCard>

        <SurfaceCard padding={20} radius={24}>
          <SectionHeader subtitle="Optional. Shown to the buyer." title="Note" />
          <TextField
            label="Description"
            maxLength={120}
            onChangeText={setDescription}
            placeholder="e.g. Mint binder copy"
            testID={`${SELL_STRIPE_TEST_PREFIX}-description-input`}
            value={description}
          />
        </SurfaceCard>

        {errorMessage ? (
          <SurfaceCard padding={16} radius={20} testID={`${SELL_STRIPE_TEST_PREFIX}-error`} variant="muted">
            <SectionHeader subtitle={errorMessage} title="Could not start checkout" />
          </SurfaceCard>
        ) : null}

        <Button
          disabled={submitState === 'submitting' || parsedAmount == null}
          label={
            submitState === 'submitting'
              ? 'Creating order…'
              : parsedAmount == null
                ? 'Charge buyer'
                : `Charge $${parsedAmount.toFixed(2)}`
          }
          onPress={handleSubmit}
          size="lg"
          testID={`${SELL_STRIPE_TEST_PREFIX}-submit`}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  conditionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  content: {
    gap: 16,
    padding: 16,
  },
  loading: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 240,
  },
  safeArea: {
    flex: 1,
  },
});
