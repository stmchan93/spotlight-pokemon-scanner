import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { RecentSaleRecord } from '@spotlight/api-client';
import {
  Button,
  IconButton,
  SheetHeader,
  TextField,
  SurfaceCard,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { CachedImage, imageCachePolicy } from '@/components/cached-image';
import { getCardImageSource } from '@/lib/card-images';
import { formatCurrency } from './portfolio-formatting';

type SalePriceEditSheetProps = {
  canConfirm: boolean;
  onChangePriceText: (value: string) => void;
  onClose: () => void;
  onConfirm: () => void;
  priceText: string;
  sale: RecentSaleRecord | null;
};

export function SalePriceEditSheet({
  canConfirm,
  onChangePriceText,
  onClose,
  onConfirm,
  priceText,
  sale,
}: SalePriceEditSheetProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();

  if (!sale) {
    return null;
  }

  return (
    <Modal
      animationType="fade"
      onRequestClose={onClose}
      presentationStyle="overFullScreen"
      statusBarTranslucent
      transparent
      visible
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Math.max(insets.bottom, 12)}
        pointerEvents="box-none"
        style={styles.overlay}
      >
        <Pressable
          accessibilityRole="button"
          onPress={onClose}
          style={styles.backdrop}
          testID="edit-sale-backdrop"
        />

        <View
          pointerEvents="box-none"
          style={[
            styles.sheetWrap,
            {
              paddingBottom: Math.max(insets.bottom, 8),
            },
          ]}
        >
          <SurfaceCard padding={18} radius={24} style={styles.sheet}>
            <SheetHeader
              leadingAccessory={(
                <CachedImage
                  cachePolicy={imageCachePolicy.thumbnail}
                  contentFit="cover"
                  source={getCardImageSource(sale, 'small')}
                  style={[
                    styles.saleArt,
                    {
                      backgroundColor: theme.colors.field,
                      borderColor: theme.colors.outlineSubtle,
                    },
                  ]}
                  testID="edit-sale-card-image"
                />
              )}
              rightAccessory={(
                <IconButton
                  accessibilityLabel="Close edit sale price"
                  onPress={onClose}
                  size={36}
                  testID="edit-sale-close"
                >
                  <Text style={[theme.typography.headline, styles.closeGlyph, { color: theme.colors.textPrimary }]}>
                    ×
                  </Text>
                </IconButton>
              )}
              showHandle
              subtitle={`${sale.name} • ${sale.soldAtLabel}`}
              title="Edit Sale Price"
              titleStyleVariant="title"
            />

            <View style={styles.content}>
              <TextField
                containerStyle={styles.priceField}
                helperText={`Previous ${formatCurrency(sale.soldPrice, sale.currencyCode)}`}
                keyboardType="decimal-pad"
                label="Sale Price"
                onChangeText={onChangePriceText}
                placeholder="$0.00"
                inputStyle={[theme.typography.display, styles.priceFieldInput]}
                testID="edit-sale-price-input"
                value={priceText}
              />
            </View>

            <Button
              disabled={!canConfirm}
              label="Confirm price"
              onPress={onConfirm}
              size="lg"
              style={styles.confirmButton}
              testID="edit-sale-confirm"
            />
          </SurfaceCard>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(15, 15, 18, 0.32)',
  },
  closeGlyph: {
    lineHeight: 20,
  },
  confirmButton: {
    marginTop: 20,
    width: '100%',
  },
  content: {
    gap: 10,
    marginTop: 18,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
  },
  priceField: {
    minHeight: 64,
  },
  priceFieldInput: {
    lineHeight: 40,
  },
  saleArt: {
    borderRadius: 10,
    borderWidth: 1,
    height: 72,
    width: 52,
  },
  sheet: {
    marginHorizontal: 16,
    marginBottom: 24,
  },
  sheetWrap: {
    justifyContent: 'flex-end',
  },
});
