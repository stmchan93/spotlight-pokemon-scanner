import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, View } from 'react-native';

import { Button, Text, TextField, useSpotlightTheme } from '@spotlight/design-system';

type CustomDiscountSheetProps = {
  visible: boolean;
  /** Share of market currently applied, 1-100. */
  initialPercentOfMarket: number;
  /** Receives the SHARE OF MARKET the user typed, 1-100. */
  onApply: (percentOfMarket: number) => void;
  onClose: () => void;
  testID?: string;
};

/**
 * "80% of market" typed by hand, for the deals the preset rows don't cover.
 * The field takes the SHARE, not the discount — a show floor says "I'll do 80"
 * and means the customer pays 80% of the total, so 80 on $100 is $80.
 */
export function CustomDiscountSheet({
  visible,
  initialPercentOfMarket,
  onApply,
  onClose,
  testID = 'custom-discount-sheet',
}: CustomDiscountSheetProps) {
  const theme = useSpotlightTheme();
  const [value, setValue] = useState('');

  // Seed from whatever is applied each time it opens, so re-opening to nudge
  // 80 to 78 does not start from a blank field.
  useEffect(() => {
    if (visible) {
      setValue(initialPercentOfMarket >= 100 ? '' : String(initialPercentOfMarket));
    }
  }, [initialPercentOfMarket, visible]);

  if (!visible) {
    return null;
  }

  const parsed = Number.parseFloat(value);
  const isValid = Number.isFinite(parsed) && parsed > 0 && parsed <= 100;

  return (
    <Modal animationType="fade" onRequestClose={onClose} transparent visible>
      <Pressable
        accessibilityLabel="Close"
        accessibilityRole="button"
        onPress={onClose}
        style={styles.backdrop}
        testID={`${testID}-backdrop`}
      />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        pointerEvents="box-none"
        style={styles.centeringLayer}
      >
        <View
          style={[styles.card, { backgroundColor: theme.colors.gray0 }]}
          testID={testID}
        >
          {/*
            The title is the whole instruction. A line spelling out "what the
            customer pays, as a share of $90.53" restated the field and pinned
            it to one tray total, which is not what the number means — it is a
            rate (user, 2026-09-11).
          */}
          <Text style={[theme.typography.titleSmall, styles.title, { color: theme.colors.gray900 }]}>
            Percent of market
          </Text>

          <TextField
            autoFocus
            inputMode="decimal"
            keyboardType="decimal-pad"
            maxLength={5}
            onChangeText={setValue}
            onSubmitEditing={() => {
              if (isValid) {
                onApply(parsed);
              }
            }}
            placeholder="80"
            // Default placeholder grey is dark enough to read as a typed value,
            // so the empty field looked like it already held 80.
            placeholderTextColor={theme.colors.gray400}
            returnKeyType="done"
            testID={`${testID}-input`}
            trailing={(
              <Text style={[theme.typography.body, { color: theme.colors.gray600 }]}>%</Text>
            )}
            value={value}
          />

          <View style={styles.actions}>
            <Button
              label="Cancel"
              onPress={onClose}
              testID={`${testID}-cancel`}
              variant="secondary"
            />
            <Button
              disabled={!isValid}
              label="Apply"
              onPress={() => onApply(parsed)}
              testID={`${testID}-apply`}
            />
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
  },
  centeringLayer: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  card: {
    borderCurve: 'continuous',
    borderRadius: 20,
    elevation: 12,
    gap: 8,
    padding: 20,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.18,
    shadowRadius: 32,
    width: '100%',
  },
  title: {
    marginBottom: 4,
  },
  actions: {
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'flex-end',
    marginTop: 8,
  },
});

export default CustomDiscountSheet;
