import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import QRCode from 'react-native-qrcode-svg';

import type { PaymentMethod, VendorWalletHandles } from '@spotlight/api-client';
import {
  Button,
  SurfaceCard,
  colors,
  textStyles,
} from '@spotlight/design-system';

import { useAppServices } from '@/providers/app-providers';
import { ChromeBackButton } from '@/components/chrome-back-button';
import {
  consumePendingBatchSalePayloads,
  consumePendingSalePayload,
} from '@/features/sell/pending-sale-session';
import { SellStatusOverlay } from '@/features/sell/components/sell-ui';

type PaymentScreenProps = {
  method: PaymentMethod;
  amount: number;
  currencyCode: string;
  memo: string;
  onCancel: () => void;
  onConfirmed: (method: PaymentMethod) => void;
};

function buildPaymentUrl(method: PaymentMethod, handles: VendorWalletHandles, amount: number, memo: string): string | null {
  switch (method) {
    case 'venmo':
      if (!handles.venmoHandle) return null;
      return `https://venmo.com/?txn=pay&recipients=${encodeURIComponent(handles.venmoHandle)}&amount=${amount.toFixed(2)}&note=${encodeURIComponent(memo)}`;
    case 'cashapp':
      if (!handles.cashappHandle) return null;
      return `https://cash.app/$${encodeURIComponent(handles.cashappHandle.replace(/^\$/, ''))}/${amount.toFixed(2)}`;
    case 'paypal':
      if (!handles.paypalMeSlug) return null;
      return `https://paypal.me/${encodeURIComponent(handles.paypalMeSlug)}/${amount.toFixed(2)}`;
    default:
      return null;
  }
}

function methodDisplayName(method: PaymentMethod): string {
  switch (method) {
    case 'venmo': return 'Venmo';
    case 'cashapp': return 'Cash App';
    case 'paypal': return 'PayPal';
    case 'zelle': return 'Zelle';
    case 'cash': return 'Cash';
    default: return method;
  }
}

function formatCurrency(amount: number, currencyCode: string) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currencyCode,
  }).format(amount);
}

export function PaymentScreen({
  method,
  amount,
  currencyCode,
  memo,
  onCancel,
  onConfirmed,
}: PaymentScreenProps) {
  const { spotlightRepository } = useAppServices();
  const [handles, setHandles] = useState<VendorWalletHandles | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isConfirming, setIsConfirming] = useState(false);
  const [isVoiding, setIsVoiding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const saleIdRef = useRef<string | null>(null);
  const saleIdsRef = useRef<string[] | null>(null);
  const saleCreationPromise = useRef<Promise<string[]> | null>(null);
  const [showReceipt, setShowReceipt] = useState(false);

  useEffect(() => {
    let cancelledHandles = false;

    // Kick off background sale creation from the pending payload(s).
    // Single-sale payload takes precedence; otherwise fall back to a batch.
    const payload = consumePendingSalePayload();
    if (payload) {
      const promise = spotlightRepository.createPortfolioSale(payload).then((response) => {
        saleIdRef.current = response.saleID;
        saleIdsRef.current = [response.saleID];
        return [response.saleID];
      });
      saleCreationPromise.current = promise;
    } else {
      const batchPayloads = consumePendingBatchSalePayloads();
      if (batchPayloads && batchPayloads.length > 0) {
        const promise = spotlightRepository.createPortfolioSalesBatch(batchPayloads).then((responses) => {
          const ids = responses.map((r) => r.saleID);
          saleIdsRef.current = ids;
          saleIdRef.current = ids[0] ?? null;
          return ids;
        });
        saleCreationPromise.current = promise;
      }
    }

    // Fetch wallet handles in parallel
    setIsLoading(true);
    void spotlightRepository.getVendorWalletHandles()
      .then((next) => {
        if (cancelledHandles) return;
        setHandles(next);
      })
      .catch((failure) => {
        if (cancelledHandles) return;
        setError(failure instanceof Error ? failure.message : 'Could not load wallet handles.');
      })
      .finally(() => {
        if (!cancelledHandles) {
          setIsLoading(false);
        }
      });

    return () => {
      cancelledHandles = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleMarkPaid = useCallback(async () => {
    if (isConfirming) return;
    setIsConfirming(true);
    setError(null);
    try {
      let saleIds = saleIdsRef.current;
      if (!saleIds || saleIds.length === 0) {
        if (saleCreationPromise.current) {
          saleIds = await saleCreationPromise.current;
        } else {
          throw new Error('Sale could not be created.');
        }
      }
      await Promise.all(saleIds.map((id) => spotlightRepository.markSalePaid(id)));
      setShowReceipt(true);
      setTimeout(() => onConfirmed(method), 1500);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not mark sale paid.');
    } finally {
      setIsConfirming(false);
    }
  }, [isConfirming, method, onConfirmed, spotlightRepository]);

  const handleCancel = useCallback(async () => {
    if (isVoiding) return;
    setIsVoiding(true);
    setError(null);
    try {
      const saleIds = saleIdsRef.current;
      if (saleIds && saleIds.length > 0) {
        await Promise.all(saleIds.map((id) => spotlightRepository.voidSale(id)));
      }
      // If sales not created yet, just cancel — no void needed
    } catch {
      // Best-effort void; back out either way.
    } finally {
      setIsVoiding(false);
      onCancel();
    }
  }, [isVoiding, onCancel, spotlightRepository]);

  const copyToClipboard = useCallback(async (value: string) => {
    try {
      // expo-clipboard requires a native module compiled into the dev client.
      // Falls back to a no-op if the module isn't available yet.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const clipboard = require('expo-clipboard') as { setStringAsync?: (text: string) => Promise<void> };
      await clipboard.setStringAsync?.(value);
    } catch {
      // Clipboard unavailable on this dev build; values are still visible on screen.
    }
  }, []);

  const paymentUrl = handles ? buildPaymentUrl(method, handles, amount, memo) : null;
  const isZelle = method === 'zelle';
  const amountLabel = formatCurrency(amount, currencyCode);
  const recipientLabel = handles
    ? method === 'venmo'
      ? handles.venmoHandle ? `@${handles.venmoHandle}` : null
      : method === 'cashapp'
      ? handles.cashappHandle ? `$${handles.cashappHandle.replace(/^\$/, '')}` : null
      : method === 'paypal'
      ? handles.paypalMeSlug ? `paypal.me/${handles.paypalMeSlug}` : null
      : method === 'zelle'
      ? handles.zelleEmailOrPhone ?? null
      : null
    : null;

  const titleText = recipientLabel
    ? `Pay ${amountLabel} to ${recipientLabel}`
    : `Pay ${amountLabel} with ${methodDisplayName(method)}`;

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.headerRow}>
        <ChromeBackButton
          onPress={() => void handleCancel()}
          testID="payment-back"
        />
      </View>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <Text style={styles.title} testID="payment-title">
          {titleText}
        </Text>

        {isLoading ? (
          <ActivityIndicator color={colors.brand} style={styles.spinner} />
        ) : isZelle ? (
          <SurfaceCard padding={20} radius={24} style={styles.card}>
            <Text style={styles.helpText}>
              Zelle has no QR. Buyer copies the info below and sends in their bank app.
            </Text>
            <CopyRow
              label="Send to"
              value={recipientLabel ?? '—'}
              onCopy={recipientLabel ? () => void copyToClipboard(recipientLabel) : undefined}
              testID="payment-zelle-recipient"
            />
            <CopyRow
              label="Amount"
              value={amountLabel}
              onCopy={() => void copyToClipboard(amount.toFixed(2))}
              testID="payment-zelle-amount"
            />
            <CopyRow
              label="Note"
              value={memo}
              onCopy={() => void copyToClipboard(memo)}
              testID="payment-zelle-memo"
            />
          </SurfaceCard>
        ) : paymentUrl ? (
          <SurfaceCard padding={20} radius={24} style={styles.card}>
            <View style={styles.qrWrap} testID="payment-qr">
              <QRCode size={220} value={paymentUrl} />
            </View>
            <Text style={styles.recipientLabel}>
              {methodDisplayName(method)}
            </Text>
            {recipientLabel ? (
              <Text style={styles.recipientHandle}>{recipientLabel}</Text>
            ) : null}
          </SurfaceCard>
        ) : (
          <SurfaceCard padding={20} radius={24} style={styles.card}>
            <Text style={styles.errorText}>
              No {methodDisplayName(method)} handle saved. Set one up in Account → Payment handles.
            </Text>
          </SurfaceCard>
        )}

        {error ? (
          <Text style={styles.errorText} testID="payment-error">
            {error}
          </Text>
        ) : null}

        <Button
          contentStyle={styles.confirmContent}
          disabled={isConfirming}
          label={isConfirming ? 'Confirming…' : 'Buyer paid ✓'}
          onPress={() => void handleMarkPaid()}
          size="lg"
          style={styles.confirmButton}
          testID="payment-confirm"
          variant="primary"
        />

        <Button
          disabled={isVoiding}
          label={isVoiding ? 'Cancelling…' : 'Cancel'}
          labelStyle={styles.cancelLabel}
          onPress={() => void handleCancel()}
          size="lg"
          style={styles.cancelButton}
          testID="payment-cancel"
          variant="secondary"
        />
      </ScrollView>

      {showReceipt ? (
        <Pressable
          accessibilityLabel="Dismiss confirmation"
          onPress={() => onConfirmed(method)}
          style={styles.receiptOverlay}
          testID="payment-receipt-dismiss"
        >
          <SellStatusOverlay
            detail={`${amountLabel} · ${methodDisplayName(method)}`}
            headline={memo}
            method={method}
            state="success"
            testIDPrefix="payment"
            title="SOLD"
          />
        </Pressable>
      ) : null}
    </SafeAreaView>
  );
}

type CopyRowProps = {
  label: string;
  value: string;
  onCopy?: () => void;
  testID: string;
};

function CopyRow({ label, value, onCopy, testID }: CopyRowProps) {
  return (
    <View style={styles.copyRow}>
      <Text style={styles.copyRowLabel}>{label}</Text>
      <Pressable
        accessibilityLabel={`Copy ${label}`}
        disabled={!onCopy}
        onPress={onCopy}
        style={({ pressed }) => [
          styles.copyRowValue,
          pressed ? styles.copyRowPressed : null,
        ]}
        testID={testID}
      >
        <Text style={styles.copyRowValueText}>{value}</Text>
        {onCopy ? <Text style={styles.copyRowCopyText}>copy</Text> : null}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  cancelButton: {
    backgroundColor: colors.danger,
    borderColor: colors.danger,
    marginTop: 12,
    width: '100%',
  },
  cancelLabel: {
    color: colors.textPrimary,
  },
  headerRow: {
    paddingHorizontal: 12,
    paddingTop: 8,
  },
  receiptOverlay: {
    ...StyleSheet.absoluteFillObject,
  },
  card: {
    alignItems: 'center',
    backgroundColor: colors.canvasElevated,
  },
  confirmButton: {
    marginTop: 24,
    width: '100%',
  },
  confirmContent: {
    justifyContent: 'center',
  },
  copyRow: {
    alignSelf: 'stretch',
    marginTop: 12,
  },
  copyRowCopyText: {
    ...textStyles.caption,
    color: colors.brand,
  },
  copyRowLabel: {
    ...textStyles.caption,
    color: colors.textSecondary,
    marginBottom: 4,
  },
  copyRowPressed: {
    opacity: 0.86,
  },
  copyRowValue: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: 10,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  copyRowValueText: {
    ...textStyles.body,
    color: colors.textPrimary,
    flex: 1,
  },
  errorText: {
    ...textStyles.body,
    color: colors.danger,
    marginTop: 12,
    textAlign: 'center',
  },
  helpText: {
    ...textStyles.caption,
    color: colors.textSecondary,
    marginTop: 12,
    textAlign: 'center',
  },
  qrWrap: {
    alignItems: 'center',
    paddingVertical: 12,
  },
  recipientHandle: {
    ...textStyles.headline,
    color: colors.textPrimary,
    marginTop: 4,
    textAlign: 'center',
  },
  recipientLabel: {
    ...textStyles.caption,
    color: colors.textSecondary,
    marginTop: 12,
    textAlign: 'center',
  },
  safeArea: {
    backgroundColor: colors.canvas,
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 32,
    paddingHorizontal: 16,
  },
  spinner: {
    marginTop: 40,
  },
  title: {
    ...textStyles.title,
    color: colors.textPrimary,
    marginBottom: 16,
    textAlign: 'center',
  },
});
