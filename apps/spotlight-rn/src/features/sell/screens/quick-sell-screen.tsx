import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { CatalogSearchResult } from '@spotlight/api-client';
import {
  Button,
  SearchField,
  SurfaceCard,
  colors,
  textStyles,
} from '@spotlight/design-system';

import { CachedImage, imageCachePolicy } from '@/components/cached-image';
import { ChromeBackButton } from '@/components/chrome-back-button';
import { getCardImageSource } from '@/lib/card-images';
import { useAppServices } from '@/providers/app-providers';

type QuickSellScreenProps = {
  initialCardId?: string;
  onBack: () => void;
  onDone: () => void;
};

const MIN_QUERY_LENGTH = 2;
const SEARCH_DEBOUNCE_MS = 200;

export function QuickSellScreen({ initialCardId, onBack, onDone }: QuickSellScreenProps) {
  const { spotlightRepository } = useAppServices();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CatalogSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [selectedCard, setSelectedCard] = useState<CatalogSearchResult | null>(null);
  const [unitPriceInput, setUnitPriceInput] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (!initialCardId) {
      return;
    }
    let cancelled = false;
    void spotlightRepository.searchCatalogCards(initialCardId, 1).then((found) => {
      if (cancelled) {
        return;
      }
      const matched = found.find((card) => card.cardId === initialCardId) ?? found[0] ?? null;
      if (matched) {
        setSelectedCard(matched);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [initialCardId, spotlightRepository]);

  useEffect(() => {
    if (selectedCard) {
      return;
    }
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      setResults([]);
      setIsSearching(false);
      return;
    }
    setIsSearching(true);
    const handle = setTimeout(() => {
      void spotlightRepository.searchCatalogCards(trimmed, 12).then((found) => {
        setResults(found);
        setIsSearching(false);
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [query, selectedCard, spotlightRepository]);

  const parsedUnitPrice = useMemo(() => {
    const numeric = Number.parseFloat(unitPriceInput.replace(/[^0-9.]/g, ''));
    return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
  }, [unitPriceInput]);

  const canSubmit = !!selectedCard && parsedUnitPrice !== null && !isSubmitting;

  const handleSubmit = async () => {
    if (!selectedCard || parsedUnitPrice === null) {
      return;
    }
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      await spotlightRepository.createQuickSale({
        cardID: selectedCard.cardId,
        quantity: 1,
        unitPrice: parsedUnitPrice,
        currencyCode: selectedCard.currencyCode ?? 'USD',
        paymentMethod,
      });
      onDone();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Quick sale failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.headerRow}>
        <ChromeBackButton onPress={onBack} />
        <Text style={styles.headerTitle}>Quick sell</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
        {selectedCard ? (
          <SurfaceCard style={styles.cardCard}>
            <View style={styles.selectedCardRow}>
              <CachedImage
                cachePolicy={imageCachePolicy.thumbnail}
                source={getCardImageSource(selectedCard, 'thumbnail')}
                style={styles.selectedCardImage}
              />
              <View style={styles.selectedCardCopy}>
                <Text style={styles.selectedCardName} numberOfLines={2}>
                  {selectedCard.name}
                </Text>
                <Text style={styles.selectedCardMeta} numberOfLines={1}>
                  {selectedCard.cardNumber}
                </Text>
                <Text style={styles.selectedCardMeta} numberOfLines={1}>
                  {selectedCard.setName}
                </Text>
              </View>
              <Pressable
                accessibilityLabel="Change card"
                hitSlop={8}
                onPress={() => setSelectedCard(null)}
                style={styles.changeButton}
              >
                <Text style={styles.changeButtonLabel}>Change</Text>
              </Pressable>
            </View>
          </SurfaceCard>
        ) : (
          <>
            <SearchField
              autoFocus
              onChangeText={setQuery}
              placeholder="Search by name, number, or set"
              value={query}
            />
            {isSearching ? <ActivityIndicator color={colors.brand} style={styles.spinner} /> : null}
            {results.map((card) => (
              <Pressable
                accessibilityLabel={`Select ${card.name}`}
                key={card.cardId}
                onPress={() => setSelectedCard(card)}
                style={({ pressed }) => [styles.resultRow, pressed ? styles.resultRowPressed : null]}
              >
                <CachedImage
                  cachePolicy={imageCachePolicy.thumbnail}
                  source={getCardImageSource(card, 'thumbnail')}
                  style={styles.resultImage}
                />
                <View style={styles.resultCopy}>
                  <Text style={styles.resultName} numberOfLines={1}>
                    {card.name}
                  </Text>
                  <Text style={styles.resultMeta} numberOfLines={1}>
                    {card.cardNumber} • {card.setName}
                  </Text>
                </View>
              </Pressable>
            ))}
          </>
        )}

        {selectedCard ? (
          <SurfaceCard style={styles.formCard}>
            <Text style={styles.fieldLabel}>Sale price</Text>
            <TextInput
              keyboardType="decimal-pad"
              onChangeText={setUnitPriceInput}
              placeholder="0.00"
              placeholderTextColor={colors.textMuted}
              style={styles.priceInput}
              value={unitPriceInput}
            />

            <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>Payment method</Text>
            <View style={styles.methodRow}>
              {(['cash', 'venmo', 'zelle', 'paypal', 'cashapp', 'other'] as const).map((method) => (
                <Pressable
                  accessibilityLabel={`Set payment method to ${method}`}
                  key={method}
                  onPress={() => setPaymentMethod(method === paymentMethod ? null : method)}
                  style={({ pressed }) => [
                    styles.methodChip,
                    paymentMethod === method ? styles.methodChipActive : null,
                    pressed ? styles.methodChipPressed : null,
                  ]}
                >
                  <Text
                    style={[
                      styles.methodChipLabel,
                      paymentMethod === method ? styles.methodChipLabelActive : null,
                    ]}
                  >
                    {method}
                  </Text>
                </Pressable>
              ))}
            </View>

            {submitError ? <Text style={styles.errorText}>{submitError}</Text> : null}
          </SurfaceCard>
        ) : null}
      </ScrollView>

      {selectedCard ? (
        <View style={styles.footer}>
          <Button
            disabled={!canSubmit}
            label={isSubmitting ? 'Recording…' : 'Record sale'}
            onPress={handleSubmit}
          />
        </View>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  cardCard: {
    padding: 12,
  },
  changeButton: {
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  changeButtonLabel: {
    ...textStyles.control,
    color: colors.brand,
  },
  errorText: {
    ...textStyles.caption,
    color: colors.danger,
    marginTop: 8,
  },
  fieldLabel: {
    ...textStyles.caption,
    color: colors.textSecondary,
    marginBottom: 6,
  },
  fieldLabelSpaced: {
    marginTop: 16,
  },
  footer: {
    backgroundColor: colors.canvas,
    borderTopColor: colors.outlineSubtle,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  formCard: {
    marginTop: 16,
    padding: 16,
  },
  headerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    height: 48,
    paddingHorizontal: 12,
  },
  headerSpacer: {
    width: 40,
  },
  headerTitle: {
    ...textStyles.headline,
    color: colors.textPrimary,
    flex: 1,
    textAlign: 'center',
  },
  methodChip: {
    borderColor: colors.outlineSubtle,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  methodChipActive: {
    backgroundColor: colors.brand,
    borderColor: colors.brand,
  },
  methodChipLabel: {
    ...textStyles.control,
    color: colors.textPrimary,
    textTransform: 'capitalize',
  },
  methodChipLabelActive: {
    color: '#000000',
  },
  methodChipPressed: {
    opacity: 0.86,
  },
  methodRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  priceInput: {
    ...textStyles.headline,
    borderBottomColor: colors.outlineSubtle,
    borderBottomWidth: 1,
    color: colors.textPrimary,
    paddingVertical: 8,
  },
  resultCopy: {
    flex: 1,
    gap: 2,
  },
  resultImage: {
    borderRadius: 6,
    height: 56,
    width: 40,
  },
  resultMeta: {
    ...textStyles.caption,
    color: colors.textSecondary,
  },
  resultName: {
    ...textStyles.body,
    color: colors.textPrimary,
  },
  resultRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    paddingVertical: 10,
  },
  resultRowPressed: {
    opacity: 0.7,
  },
  safeArea: {
    backgroundColor: colors.canvas,
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 32,
    paddingHorizontal: 16,
  },
  selectedCardCopy: {
    flex: 1,
    gap: 2,
  },
  selectedCardImage: {
    borderRadius: 8,
    height: 80,
    width: 56,
  },
  selectedCardMeta: {
    ...textStyles.caption,
    color: colors.textSecondary,
  },
  selectedCardName: {
    ...textStyles.headline,
    color: colors.textPrimary,
  },
  selectedCardRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
  },
  spinner: {
    marginVertical: 8,
  },
});
