import { useState } from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import type { PaymentMethod, VendorWalletHandlesUpdate } from '@spotlight/api-client';
import {
  Button,
  SurfaceCard,
  colors,
  textStyles,
} from '@spotlight/design-system';

type WalletHandleSetupModalProps = {
  visible: boolean;
  method: PaymentMethod;
  initialValue: string | null | undefined;
  onCancel: () => void;
  onSave: (update: VendorWalletHandlesUpdate) => Promise<void> | void;
};

const COPY: Record<Exclude<PaymentMethod, 'cash' | 'other'>, { title: string; help: string; placeholder: string; prefix: string; field: keyof VendorWalletHandlesUpdate }> = {
  venmo: {
    title: 'Set up Venmo',
    help: 'Buyers will scan a QR code that pre-fills a Venmo payment.',
    placeholder: 'username',
    prefix: '@',
    field: 'venmoHandle',
  },
  cashapp: {
    title: 'Set up Cash App',
    help: 'Buyers will scan a QR that opens Cash App with the amount pre-filled.',
    placeholder: 'cashtag',
    prefix: '$',
    field: 'cashappHandle',
  },
  paypal: {
    title: 'Set up PayPal',
    help: 'Buyers will scan a QR that opens your paypal.me/<slug> link.',
    placeholder: 'paypal-me-slug',
    prefix: 'paypal.me/',
    field: 'paypalMeSlug',
  },
  zelle: {
    title: 'Set up Zelle',
    help: 'Zelle has no QR — buyers will copy your email/phone to send in their bank app.',
    placeholder: 'you@email.com or phone',
    prefix: '',
    field: 'zelleEmailOrPhone',
  },
};

export function WalletHandleSetupModal({
  visible,
  method,
  initialValue,
  onCancel,
  onSave,
}: WalletHandleSetupModalProps) {
  const [value, setValue] = useState(initialValue ?? '');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (method === 'cash' || method === 'other') {
    return null;
  }
  const copy = COPY[method];

  const handleSave = async () => {
    const trimmed = value.trim();
    if (!trimmed) {
      setError('Enter a value to continue.');
      return;
    }
    setIsSaving(true);
    setError(null);
    try {
      await onSave({ [copy.field]: trimmed });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not save handle.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Modal
      animationType="fade"
      onRequestClose={onCancel}
      transparent
      visible={visible}
    >
      <Pressable
        accessibilityLabel="Close wallet setup"
        onPress={onCancel}
        style={styles.backdrop}
        testID="wallet-handle-setup-backdrop"
      >
        <Pressable onPress={() => undefined} style={styles.sheetWrap}>
          <SurfaceCard padding={20} radius={24} style={styles.sheet}>
            <Text style={styles.title} testID="wallet-handle-setup-title">
              {copy.title}
            </Text>
            <Text style={styles.help}>{copy.help}</Text>
            <View style={styles.inputRow}>
              {copy.prefix ? <Text style={styles.prefix}>{copy.prefix}</Text> : null}
              <TextInput
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
                editable={!isSaving}
                onChangeText={(next) => {
                  setValue(next);
                  setError(null);
                }}
                placeholder={copy.placeholder}
                placeholderTextColor={colors.textMuted}
                style={styles.input}
                testID="wallet-handle-setup-input"
                value={value}
              />
            </View>
            {error ? <Text style={styles.errorText}>{error}</Text> : null}
            <View style={styles.actionsRow}>
              <Button
                disabled={isSaving}
                label="Cancel"
                onPress={onCancel}
                size="lg"
                style={styles.actionButton}
                testID="wallet-handle-setup-cancel"
                variant="secondary"
              />
              <Button
                disabled={isSaving || value.trim().length === 0}
                label={isSaving ? 'Saving…' : 'Save & use'}
                onPress={() => void handleSave()}
                size="lg"
                style={styles.actionButton}
                testID="wallet-handle-setup-save"
                variant="primary"
              />
            </View>
          </SurfaceCard>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  actionButton: {
    flex: 1,
  },
  actionsRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 16,
  },
  backdrop: {
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.42)',
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  errorText: {
    ...textStyles.caption,
    color: colors.danger,
    marginTop: 8,
  },
  help: {
    ...textStyles.body,
    color: colors.textSecondary,
    marginBottom: 16,
  },
  input: {
    ...textStyles.body,
    color: colors.textPrimary,
    flex: 1,
    paddingVertical: 4,
  },
  inputRow: {
    alignItems: 'center',
    borderBottomColor: colors.outlineSubtle,
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: 6,
  },
  prefix: {
    ...textStyles.body,
    color: colors.textSecondary,
  },
  sheet: {
    backgroundColor: colors.canvasElevated,
  },
  sheetWrap: {
    width: '100%',
  },
  title: {
    ...textStyles.headline,
    color: colors.textPrimary,
    marginBottom: 8,
  },
});
