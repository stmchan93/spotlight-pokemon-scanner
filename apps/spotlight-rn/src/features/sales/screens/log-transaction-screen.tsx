import { useCallback, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { EncodingType, readAsStringAsync } from 'expo-file-system/legacy';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

import type { CardTransactionKind } from '@spotlight/api-client';
import {
  Button,
  SectionHeader,
  SegmentedControl,
  SurfaceCard,
  TextField,
  colors,
  useSpotlightTheme,
  type SegmentedControlItem,
} from '@spotlight/design-system';

import { ChromeBackButton } from '@/components/chrome-back-button';
import { TransactionPhotoCapture } from '@/features/sales/components/transaction-photo-capture';
import { parseSellPrice, sanitizeSellPriceText } from '@/features/sell/sell-order-helpers';
import { capturePostHogEvent } from '@/lib/observability/posthog';
import { useAppServices } from '@/providers/app-providers';

const kindItems: readonly SegmentedControlItem<CardTransactionKind>[] = [
  { label: 'Bought', value: 'bought' },
  { label: 'Sold', value: 'sold' },
  { label: 'Traded', value: 'traded' },
];

const photoMaxDimension = 1280;
const photoCompress = 0.72;

type LogTransactionScreenProps = {
  onClose: () => void;
  onComplete: () => void;
  /** When started from a specific card, its label — shown for context and saved as the note. */
  cardLabel?: string;
  /** Absolute card image URL carried from the source card; saved on the transaction. */
  cardImageUrl?: string | null;
};

type ReadyPhoto = {
  jpegBase64: string;
  width: number;
  height: number;
};

async function readTransactionPhoto(uri: string): Promise<ReadyPhoto> {
  const context = ImageManipulator.manipulate(uri);
  context.resize({ width: photoMaxDimension });

  let renderedRef: {
    height: number;
    release?: () => void;
    saveAsync: (options?: { base64?: boolean; compress?: number; format?: SaveFormat }) => Promise<{
      base64?: string;
      height: number;
      uri: string;
      width: number;
    }>;
    width: number;
  } | null = null;

  try {
    renderedRef = await context.renderAsync();
    const rendered = await renderedRef.saveAsync({
      base64: true,
      compress: photoCompress,
      format: SaveFormat.JPEG,
    });

    if (rendered.base64) {
      return {
        jpegBase64: rendered.base64,
        width: rendered.width,
        height: rendered.height,
      };
    }

    const jpegBase64 = await readAsStringAsync(rendered.uri, { encoding: EncodingType.Base64 });
    return {
      jpegBase64,
      width: rendered.width,
      height: rendered.height,
    };
  } finally {
    renderedRef?.release?.();
    context.release?.();
  }
}

export function LogTransactionScreen({
  onClose,
  onComplete,
  cardLabel,
  cardImageUrl,
}: LogTransactionScreenProps) {
  const theme = useSpotlightTheme();
  const { spotlightRepository, refreshData } = useAppServices();

  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [kind, setKind] = useState<CardTransactionKind>('sold');
  const [itemCountText, setItemCountText] = useState('1');
  const [priceText, setPriceText] = useState('');
  const [submitState, setSubmitState] = useState<'idle' | 'saving' | 'success'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const parsedPrice = useMemo(() => parseSellPrice(priceText), [priceText]);
  const itemCount = useMemo(() => {
    const parsed = Number.parseInt(itemCountText, 10);
    return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
  }, [itemCountText]);
  const canSubmit = submitState === 'idle';

  const handleChangeItemCount = useCallback((value: string) => {
    setItemCountText(value.replace(/[^0-9]/g, ''));
  }, []);

  const handleChangePrice = useCallback((value: string) => {
    setPriceText(sanitizeSellPriceText(value));
  }, []);

  const handleSave = useCallback(async () => {
    if (submitState !== 'idle') {
      return;
    }

    setSubmitState('saving');
    setErrorMessage(null);

    try {
      let photo: ReadyPhoto | null = null;
      if (photoUri) {
        photo = await readTransactionPhoto(photoUri);
      }

      await spotlightRepository.createCardTransaction({
        kind,
        amountCents: parsedPrice != null ? Math.round(parsedPrice * 100) : null,
        currencyCode: 'USD',
        occurredAt: new Date().toISOString(),
        note: cardLabel ?? null,
        itemCount,
        photo,
        imageUrl: cardImageUrl ?? null,
      });

      capturePostHogEvent('transaction_logged', { kind });
      refreshData();
      setSubmitState('success');
      onComplete();
    } catch {
      setSubmitState('idle');
      setErrorMessage('Could not save this transaction. Please try again.');
    }
  }, [
    cardImageUrl,
    cardLabel,
    itemCount,
    kind,
    onComplete,
    parsedPrice,
    photoUri,
    refreshData,
    spotlightRepository,
    submitState,
  ]);

  const saveLabel =
    submitState === 'saving'
      ? 'Saving...'
      : submitState === 'success'
        ? 'Saved'
        : 'Save transaction';

  return (
    <SafeAreaView
      edges={['top', 'left', 'right', 'bottom']}
      style={[styles.safeArea, { backgroundColor: colors.gray0 }]}
    >
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        testID="log-transaction-scroll"
      >
        <ChromeBackButton onPress={onClose} testID="log-transaction-close" />

        <SectionHeader
          subtitle={cardLabel ?? 'Snap the card, set a price, and pick what happened.'}
          testID="log-transaction-header"
          title="Log a transaction"
        />

        <SurfaceCard style={styles.card} testID="log-transaction-card">
          <TransactionPhotoCapture
            fallbackImageUrl={cardImageUrl ?? null}
            onCapture={setPhotoUri}
            onClear={() => setPhotoUri(null)}
            photoUri={photoUri}
            testIDPrefix="log-transaction"
          />

          <View style={styles.divider} />

          <View style={styles.fieldBlock}>
            <Text style={[theme.typography.micro, styles.fieldLabel]}>TYPE</Text>
            <SegmentedControl
              items={kindItems}
              onChange={setKind}
              testID="log-transaction-kind"
              value={kind}
            />
          </View>

          <TextField
            inputMode="numeric"
            keyboardType="number-pad"
            label="Items"
            onChangeText={handleChangeItemCount}
            placeholder="1"
            returnKeyType="done"
            testID="log-transaction-item-count"
            value={itemCountText}
          />

          <TextField
            inputMode="decimal"
            keyboardType="decimal-pad"
            label="Price"
            onChangeText={handleChangePrice}
            placeholder="0.00"
            returnKeyType="done"
            testID="log-transaction-price"
            value={priceText}
          />

          {errorMessage ? (
            <Text
              style={[theme.typography.caption, { color: theme.colors.danger }]}
              testID="log-transaction-error"
            >
              {errorMessage}
            </Text>
          ) : null}

          <Button
            disabled={!canSubmit}
            label={saveLabel}
            onPress={() => {
              void handleSave();
            }}
            testID="log-transaction-save"
          />
        </SurfaceCard>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  content: {
    gap: 20,
    paddingBottom: 32,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  card: {
    gap: 16,
  },
  divider: {
    backgroundColor: 'rgba(0, 0, 0, 0.08)',
    height: 1,
  },
  fieldBlock: {
    gap: 8,
  },
  fieldLabel: {
    letterSpacing: 1.2,
  },
});
