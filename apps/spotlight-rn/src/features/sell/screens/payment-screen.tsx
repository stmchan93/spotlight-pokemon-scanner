import * as Clipboard from 'expo-clipboard';
import { useCallback, useEffect, useState } from 'react';
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

type PaymentScreenProps = {
  saleId: string;
  method: PaymentMethod;
  amount: number;
  currencyCode: string;
  memo: string;
  onCancel: () => void;
  onConfirmed: () => void;
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
  saleId,
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

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    void spotlightRepository.getVendorWalletHandles()
      .then((next) => {
        if (cancelled) return;
        setHandles(next);
      })
      .catch((failure) => {
        if (cancelled) return;
        setError(failure instanceof Error ? failure.message : 'Could not load wallet handles.');
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [spotlightRepository]);

  const handleMarkPaid = useCallback(async () => {
    if (isConfirming) return;
    setIsConfirming(true);
    setError(null);
    try {
      await spotlightRepository.markSalePaid(saleId);
      onConfirmed();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not mark sale paid.');
    } finally {
      setIsConfirming(false);
    }
  }, [isConfirming, onConfirmed, saleId, spotlightRepository]);

  const handleCancel = useCallback(async () => {
    if (isVoiding) return;
    setIsVoiding(true);
    setError(null);
    try {
      await spotlightRepository.voidSale(saleId);
    } catch {
      // Best-effort void; back out either way.
    } finally {
      setIsVoiding(false);
      onCancel();
    }
  }, [isVoiding, onCancel, saleId, spotlightRepository]);

  const copyToClipboard = useCallback(async (value: string) => {
    try {
      await Clipboard.setStringAsync(value);
    } catch {
      // ignore
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

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.headerRow}>
        <Pressable
          accessibilityLabel="Cancel payment"
          disabled={isVoiding}
          onPress={() => void handleCancel()}
          style={styles.cancelButton}
          testID="payment-cancel"
        >
          <Text style={styles.cancelLabel}>Cancel</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <Text style={styles.title} testID="payment-title">
          Pay {amountLabel} with {methodDisplayName(method)}
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
            <Text style={styles.helpText}>
              Buyer: point your camera at the QR code.
            </Text>
          </SurfaceCard>
        ) : (
          <SurfaceCard padding={20} radius={24} style={styles.card}>
            <Text style={styles.errorText}>
              No {methodDisplayName(method)} handle saved. Set one up in Account → Sell setup.
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
          disabled={isConfirming || isVoiding}
          label={isConfirming ? 'Confirming…' : 'Buyer paid ✓'}
          onPress={() => void handleMarkPaid()}
          size="lg"
          style={styles.confirmButton}
          testID="payment-confirm"
          variant="primary"
        />
      </ScrollView>
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
    paddingHorizontal: 8,
    paddingVertical: 8,
  },
  cancelLabel: {
    ...textStyles.control,
    color: colors.textSecondary,
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
  headerRow: {
    alignItems: 'flex-end',
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: 12,
    paddingVertical: 8,
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
