import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  deckConditionOptions,
  type CardDetailRecord,
  type DeckConditionCode,
  type SlabContext,
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
import { useAppServices } from '@/providers/app-providers';

const TEST_PREFIX = 'buy-sheet';

type BuySheetProps = {
  cardId: string;
  slabContext?: SlabContext | null;
  onClose: () => void;
  onComplete: () => void;
};

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
 * Inventory-only "log a purchase" sheet. Creates a portfolio buy entry
 * via the existing `createPortfolioBuy` API. No payment flow involved.
 */
export function BuySheet({ cardId, slabContext, onClose, onComplete }: BuySheetProps) {
  const theme = useSpotlightTheme();
  const { refreshData, spotlightRepository } = useAppServices();

  const [detail, setDetail] = useState<CardDetailRecord | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [priceText, setPriceText] = useState('');
  const [quantityText, setQuantityText] = useState('1');
  const [conditionCode, setConditionCode] = useState<DeckConditionCode | null>('near_mint');
  const [submitState, setSubmitState] = useState<'idle' | 'submitting'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setLoadError(null);

    void spotlightRepository
      .getCardDetail({ cardId, slabContext: slabContext ?? null })
      .then((next) => {
        if (cancelled) {
          return;
        }
        setDetail(next);
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        setLoadError(error instanceof Error ? error.message : 'Could not load card details.');
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [cardId, slabContext, spotlightRepository]);

  const parsedPrice = useMemo(() => parsePrice(priceText), [priceText]);
  const parsedQuantity = useMemo(() => {
    const value = Number.parseInt(quantityText, 10);
    if (!Number.isFinite(value) || value < 1) {
      return null;
    }
    return value;
  }, [quantityText]);

  const handleSubmit = useCallback(async () => {
    if (parsedPrice == null) {
      setErrorMessage('Enter what you paid before saving.');
      return;
    }
    if (parsedQuantity == null) {
      setErrorMessage('Enter a quantity of at least 1.');
      return;
    }

    setSubmitState('submitting');
    setErrorMessage(null);

    try {
      await spotlightRepository.createPortfolioBuy({
        cardID: detail?.cardId ?? cardId,
        slabContext: slabContext ?? null,
        variantName: null,
        condition: slabContext ? null : conditionCode,
        quantity: parsedQuantity,
        unitPrice: parsedPrice,
        currencyCode: 'USD',
        paymentMethod: null,
        boughtAt: new Date().toISOString(),
        sourceScanID: null,
      });
      refreshData();
      onComplete();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not log this purchase.');
    } finally {
      setSubmitState('idle');
    }
  }, [
    cardId,
    conditionCode,
    detail,
    onComplete,
    parsedPrice,
    parsedQuantity,
    refreshData,
    slabContext,
    spotlightRepository,
  ]);

  if (isLoading) {
    return (
      <SafeAreaView edges={['top', 'left', 'right', 'bottom']} style={[styles.safeArea, { backgroundColor: colors.gray0 }]}>
        <View style={[styles.content, styles.loading]} testID={`${TEST_PREFIX}-loading`}>
          <ActivityIndicator color={theme.colors.brand} />
        </View>
      </SafeAreaView>
    );
  }

  if (loadError) {
    return (
      <SafeAreaView edges={['top', 'left', 'right', 'bottom']} style={[styles.safeArea, { backgroundColor: colors.gray0 }]}>
        <View style={styles.content}>
          <ChromeBackButton onPress={onClose} testID={`${TEST_PREFIX}-close`} />
          <SurfaceCard padding={20} radius={24} testID={`${TEST_PREFIX}-load-error`}>
            <SheetHeader subtitle={loadError} title="Card unavailable" />
            <Button label="Close" onPress={onClose} variant="secondary" />
          </SurfaceCard>
        </View>
      </SafeAreaView>
    );
  }

  const headerSubtitle = detail
    ? `${detail.name}${detail.setName ? ` • ${detail.setName}` : ''}`
    : 'Log a purchase';

  return (
    <SafeAreaView edges={['top', 'left', 'right', 'bottom']} style={[styles.safeArea, { backgroundColor: colors.gray0 }]}>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        testID={`${TEST_PREFIX}-scroll`}
      >
        <ChromeBackButton onPress={onClose} testID={`${TEST_PREFIX}-close`} />
        <SheetHeader showHandle subtitle={headerSubtitle} title="Log a buy" />

        <SurfaceCard padding={20} radius={24}>
          <SectionHeader title="What you paid" />
          <TextField
            helperText="Per-card price in USD."
            keyboardType="decimal-pad"
            label="Price"
            maxLength={8}
            onChangeText={(value) => {
              setPriceText(value);
              setErrorMessage(null);
            }}
            placeholder="20.00"
            testID={`${TEST_PREFIX}-price-input`}
            value={priceText}
          />
        </SurfaceCard>

        <SurfaceCard padding={20} radius={24}>
          <SectionHeader title="Quantity" />
          <TextField
            keyboardType="number-pad"
            label="Quantity"
            maxLength={3}
            onChangeText={(value) => {
              setQuantityText(value.replace(/[^0-9]/g, ''));
              setErrorMessage(null);
            }}
            placeholder="1"
            testID={`${TEST_PREFIX}-quantity-input`}
            value={quantityText}
          />
        </SurfaceCard>

        {slabContext ? null : (
          <SurfaceCard padding={20} radius={24}>
            <SectionHeader title="Condition" />
            <View style={styles.row} testID={`${TEST_PREFIX}-condition-row`}>
              {deckConditionOptions.map((option) => (
                <Button
                  key={option.code}
                  label={option.shortLabel}
                  onPress={() => setConditionCode(option.code)}
                  size="sm"
                  testID={`${TEST_PREFIX}-condition-${option.code}`}
                  variant={conditionCode === option.code ? 'primary' : 'secondary'}
                />
              ))}
            </View>
          </SurfaceCard>
        )}

        {errorMessage ? (
          <SurfaceCard padding={16} radius={20} testID={`${TEST_PREFIX}-error`} variant="muted">
            <SectionHeader subtitle={errorMessage} title="Could not log buy" />
          </SurfaceCard>
        ) : null}

        <Button
          disabled={submitState === 'submitting'}
          label={submitState === 'submitting' ? 'Saving…' : 'Save buy'}
          onPress={handleSubmit}
          size="lg"
          testID={`${TEST_PREFIX}-submit`}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: 16,
    padding: 16,
  },
  loading: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 240,
  },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  safeArea: {
    flex: 1,
  },
});
