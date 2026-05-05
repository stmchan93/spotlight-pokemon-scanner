import { useEffect, useMemo, useState } from 'react';
import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  deckConditionOptions,
  graderOptions,
  type AddToCollectionOptions,
  type CardDetailRecord,
  type DeckConditionCode,
  type GraderOption,
} from '@spotlight/api-client';
import { PillButton, useSpotlightTheme } from '@spotlight/design-system';

import { ChromeBackButton, chromeBackButtonSize } from '@/components/chrome-back-button';
import { capturePostHogEvent } from '@/lib/observability/posthog';
import { useAppServices } from '@/providers/app-providers';

type AddToCollectionScreenProps = {
  cardId: string;
  entryId?: string;
  onClose: () => void;
};

const gradedOptions = [
  '10',
  '9.5',
  '9',
  '8.5',
  '8',
  '7.5',
  '7',
  '6.5',
  '6',
  '5.5',
  '5',
  '4.5',
  '4',
  '3.5',
  '3',
  '2.5',
  '2',
  '1.5',
  '1',
] as const;

function isGenericRawVariantLabel(value?: string | null) {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'normal'
    || normalized === 'raw'
    || normalized === 'standard'
    || normalized === 'default';
}

function displayNumber(value?: string | null) {
  const trimmed = value?.trim();
  if (!trimmed) {
    return '#--';
  }

  return trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
}

function AddStateCard({
  title,
  message,
  onRetry,
}: {
  title: string;
  message: string;
  onRetry?: () => void;
}) {
  const theme = useSpotlightTheme();

  return (
    <View
      style={[
        styles.stateCard,
        {
          backgroundColor: theme.colors.canvasElevated,
          borderColor: theme.colors.outlineSubtle,
        },
      ]}
    >
      <View style={styles.stateCopy}>
        <Text style={theme.typography.headline}>{title}</Text>
        <Text
          style={[
            theme.typography.body,
            styles.stateMessage,
            { color: theme.colors.textSecondary },
          ]}
        >
          {message}
        </Text>
      </View>

      {onRetry ? (
        <Pressable
          accessibilityRole="button"
          onPress={onRetry}
          style={({ pressed }) => [
            styles.stateAction,
            {
              backgroundColor: theme.colors.info,
              opacity: pressed ? 0.88 : 1,
            },
          ]}
          testID="add-to-collection-retry"
        >
          <Text style={[theme.typography.control, styles.stateActionLabel]}>Retry</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function SelectionSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const theme = useSpotlightTheme();

  return (
    <View style={styles.section}>
      <Text style={theme.typography.headline}>{title}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={styles.selectionRow}>{children}</View>
      </ScrollView>
    </View>
  );
}

function QuantityButton({
  disabled,
  label,
  onPress,
  testID,
}: {
  disabled: boolean;
  label: string;
  onPress: () => void;
  testID: string;
}) {
  const theme = useSpotlightTheme();

  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.quantityButton,
        {
          backgroundColor: theme.colors.canvasElevated,
          borderColor: theme.colors.outlineSubtle,
          opacity: disabled ? 0.4 : pressed ? 0.88 : 1,
        },
      ]}
      testID={testID}
    >
      <Text style={[styles.quantityButtonLabel, { color: theme.colors.textPrimary }]}>{label}</Text>
    </Pressable>
  );
}

export function AddToCollectionScreen({
  cardId,
  entryId,
  onClose,
}: AddToCollectionScreenProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const { refreshData, spotlightRepository } = useAppServices();

  const [detail, setDetail] = useState<CardDetailRecord | null>(null);
  const [options, setOptions] = useState<AddToCollectionOptions | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [reloadCount, setReloadCount] = useState(0);
  const [selectedVariant, setSelectedVariant] = useState('normal');
  const [selectedGrader, setSelectedGrader] = useState<GraderOption>('Raw');
  const [selectedCondition, setSelectedCondition] = useState<DeckConditionCode>('near_mint');
  const [selectedNumericGrade, setSelectedNumericGrade] = useState('10');
  const [quantity, setQuantity] = useState(1);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  useEffect(() => {
    let isCancelled = false;

    setIsLoading(true);
    setLoadError('');

    void Promise.all([
      spotlightRepository.getCardDetail({ cardId }),
      spotlightRepository.getAddToCollectionOptions(cardId),
    ])
      .then(([nextDetail, nextOptions]) => {
        if (isCancelled) {
          return;
        }

        const resolvedVariants = nextOptions.variants.length > 0
          ? nextOptions.variants
          : [{ id: 'normal', label: 'Normal' }];

        const editingEntry = entryId
          ? nextDetail?.ownedEntries.find((entry) => entry.id === entryId) ?? null
          : null;
        const nextSelectedGrader = editingEntry?.kind === 'graded'
          ? (graderOptions.find((grader) => grader === editingEntry.slabContext?.grader) ?? 'PSA')
          : 'Raw';
        const nextSelectedVariant = editingEntry?.kind === 'graded'
          ? (editingEntry.slabContext?.variantName ?? nextOptions.defaultVariant ?? resolvedVariants[0]?.id ?? 'normal')
          : (editingEntry?.variantName ?? nextOptions.defaultVariant ?? resolvedVariants[0]?.id ?? 'normal');

        setDetail(nextDetail);
        setOptions({
          ...nextOptions,
          variants: resolvedVariants,
          defaultVariant: nextOptions.defaultVariant ?? resolvedVariants[0]?.id ?? 'normal',
        });
        setSelectedVariant(nextSelectedVariant);
        setSelectedGrader(nextSelectedGrader);
        setSelectedCondition(editingEntry?.conditionCode ?? 'near_mint');
        setSelectedNumericGrade(editingEntry?.slabContext?.grade ?? '10');
        setQuantity(editingEntry?.quantity ?? 1);
        setSubmitError('');
        setIsLoading(false);
      })
      .catch(() => {
        if (isCancelled) {
          return;
        }

        setDetail(null);
        setOptions(null);
        setLoadError('Unable to load this card right now.');
        setIsLoading(false);
      });

    return () => {
      isCancelled = true;
    };
  }, [cardId, entryId, reloadCount, spotlightRepository]);

  useEffect(() => {
    if (selectedGrader === 'Raw') {
      return;
    }

    setSelectedNumericGrade((current) => current || '10');
  }, [selectedGrader]);

  const variantChoices = useMemo(() => {
    return options?.variants.length ? options.variants : [{ id: 'normal', label: 'Normal' }];
  }, [options]);

  const editingEntry = useMemo(() => {
    if (!entryId || !detail) {
      return null;
    }

    return detail.ownedEntries.find((entry) => entry.id === entryId) ?? null;
  }, [detail, entryId]);

  const isEditingEntry = editingEntry != null;
  const submitLabel = isSubmitting
    ? (isEditingEntry ? 'Saving...' : 'Adding...')
    : (isEditingEntry ? 'Save changes' : 'Add to collection');
  const cardName = detail?.name ?? 'Card';
  const cardMeta = detail ? [displayNumber(detail.cardNumber), detail.setName].filter(Boolean).join(' • ') : '';
  const canSubmit = !isLoading && !loadError && !isSubmitting;

  const handleSubmit = () => {
    if (!canSubmit) {
      return;
    }

    setSubmitError('');
    setIsSubmitting(true);

    const selectedVariantLabel = variantChoices.find((variant) => variant.id === selectedVariant)?.label ?? selectedVariant;
    const nextKind = selectedGrader === 'Raw' ? 'raw' : 'graded';
    const rawVariantName = selectedGrader === 'Raw' && !isGenericRawVariantLabel(selectedVariantLabel)
      ? selectedVariantLabel
      : null;
    const nextSlabContext = selectedGrader === 'Raw'
      ? null
      : {
          grader: selectedGrader,
          grade: selectedNumericGrade,
          certNumber: editingEntry?.slabContext?.certNumber ?? null,
          variantName: selectedVariant,
        };

    const request = isEditingEntry
      ? spotlightRepository.replacePortfolioEntry({
          deckEntryID: editingEntry.id,
          cardID: cardId,
          slabContext: nextSlabContext,
          variantName: rawVariantName,
          condition: selectedGrader === 'Raw' ? selectedCondition : null,
          quantity,
          unitPrice: editingEntry.costBasisPerUnit ?? null,
          currencyCode: detail?.currencyCode ?? 'USD',
          updatedAt: new Date().toISOString(),
        })
      : spotlightRepository.createInventoryEntry({
          cardID: cardId,
          slabContext: nextSlabContext,
          variantName: rawVariantName,
          condition: selectedGrader === 'Raw' ? selectedCondition : null,
          quantity,
          sourceScanID: null,
          addedAt: new Date().toISOString(),
        });

    void request.then(() => {
      if (!isEditingEntry) {
        capturePostHogEvent('collection_add_succeeded', {
          kind: nextKind,
          quantity,
        });
      }
      refreshData();
      onClose();
    }).catch(() => {
      setSubmitError(isEditingEntry ? 'Unable to update this collection item right now.' : 'Unable to add this card right now.');
      setIsSubmitting(false);
    });
  };

  return (
    <SafeAreaView
      edges={['top', 'left', 'right', 'bottom']}
      style={[styles.safeArea, { backgroundColor: theme.colors.pageLight }]}
    >
      <View style={styles.sheetViewport}>
        <View
          style={[
            styles.sheetWrap,
            {
              backgroundColor: theme.colors.pageLight,
              paddingBottom: insets.bottom + 12,
            },
          ]}
        >
          <View style={styles.sheetHeader} testID="add-to-collection-header">
            <ChromeBackButton
              onPress={onClose}
              style={styles.sheetBackButton}
              testID="add-to-collection-close"
            />

            <View style={styles.sheetHeaderCopy}>
              <Text style={[theme.typography.title, styles.sheetTitle]}>{isEditingEntry ? 'Edit Collection' : 'Add to Collection'}</Text>
            </View>

            <View style={styles.sheetHeaderSpacer} />
          </View>
          <View style={[styles.headerDivider, { backgroundColor: theme.colors.outlineSubtle }]} />

          <ScrollView contentContainerStyle={styles.sheetContent} showsVerticalScrollIndicator={false}>
            {loadError ? (
              <AddStateCard
                message={loadError}
                onRetry={() => setReloadCount((count) => count + 1)}
                title="Unable to load card"
              />
            ) : (
              <View
                style={[
                  styles.sheetCard,
                  {
                    backgroundColor: theme.colors.canvasElevated,
                    borderColor: theme.colors.outlineSubtle,
                  },
                ]}
              >
                <View style={styles.heroSection} testID="add-to-collection-hero">
                  <View
                    style={[
                      styles.heroArtStage,
                      {
                        backgroundColor: theme.colors.canvasElevated,
                        borderColor: theme.colors.outlineSubtle,
                      },
                    ]}
                  >
                    {(detail?.largeImageUrl ?? detail?.imageUrl) ? (
                      <Image source={{ uri: detail?.largeImageUrl ?? detail?.imageUrl ?? '' }} style={styles.heroArt} />
                    ) : (
                      <Text style={[theme.typography.caption, styles.heroFallback, { color: theme.colors.textSecondary }]}>
                        {cardName}
                      </Text>
                    )}
                  </View>

                  <View style={styles.heroCopy}>
                    <Text style={[theme.typography.titleCompact, styles.heroName]}>{cardName}</Text>
                    <Text style={[theme.typography.body, styles.heroMeta, { color: theme.colors.textSecondary }]}>
                      {cardMeta}
                    </Text>
                  </View>
                </View>

                <View style={[styles.divider, { backgroundColor: theme.colors.outlineSubtle }]} />

                <View style={styles.formSection}>
                  <SelectionSection title="Variant">
                    {variantChoices.map((variant) => (
                      <PillButton
                        key={variant.id}
                        label={variant.label}
                        minWidth={78}
                        onPress={() => setSelectedVariant(variant.id)}
                        selected={selectedVariant === variant.id}
                        testID={`add-to-collection-variant-${variant.id}`}
                      />
                    ))}
                  </SelectionSection>

                  <SelectionSection title="Grader">
                    {graderOptions.map((grader) => (
                      <PillButton
                        key={grader}
                        label={grader}
                        minWidth={72}
                        onPress={() => setSelectedGrader(grader)}
                        selected={selectedGrader === grader}
                        testID={`add-to-collection-grader-${grader}`}
                      />
                    ))}
                  </SelectionSection>

                  <SelectionSection title="Grade">
                    {selectedGrader === 'Raw'
                      ? deckConditionOptions.map((condition) => (
                          <PillButton
                            key={condition.code}
                            label={condition.label}
                            minWidth={126}
                            onPress={() => setSelectedCondition(condition.code)}
                            selected={selectedCondition === condition.code}
                            testID={`add-to-collection-condition-${condition.code}`}
                          />
                        ))
                      : gradedOptions.map((grade) => (
                          <PillButton
                            key={grade}
                            label={grade}
                            minWidth={62}
                            onPress={() => setSelectedNumericGrade(grade)}
                            selected={selectedNumericGrade === grade}
                            testID={`add-to-collection-grade-${grade}`}
                          />
                        ))}
                  </SelectionSection>

                  <View style={styles.section}>
                    <Text style={theme.typography.headline}>Quantity</Text>

                    <View style={styles.quantityRow}>
                      <QuantityButton
                        disabled={quantity <= 1}
                        label="−"
                        onPress={() => setQuantity((value) => Math.max(1, value - 1))}
                        testID="add-to-collection-quantity-decrease"
                      />

                      <Text style={[theme.typography.headline, styles.quantityValue]} testID="add-to-collection-quantity-value">
                        {quantity}
                      </Text>

                      <QuantityButton
                        disabled={quantity >= 99}
                        label="+"
                        onPress={() => setQuantity((value) => Math.min(99, value + 1))}
                        testID="add-to-collection-quantity-increase"
                      />
                    </View>
                  </View>
                </View>
              </View>
            )}

            {submitError ? (
              <Text style={[theme.typography.caption, styles.submitError, { color: theme.colors.danger }]}>
                {submitError}
              </Text>
            ) : null}
          </ScrollView>

          <View style={[styles.bottomActionBar, { borderTopColor: theme.colors.outlineSubtle }]}>
            <Pressable
              accessibilityRole="button"
              disabled={!canSubmit}
              onPress={handleSubmit}
              style={({ pressed }) => [
                styles.submitButton,
                {
                  backgroundColor: theme.colors.brand,
                  opacity: !canSubmit ? 0.6 : pressed ? 0.9 : 1,
                },
              ]}
              testID="submit-add-to-collection"
            >
              <Text style={[theme.typography.control, styles.submitButtonLabel]}>{submitLabel}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  bottomActionBar: {
    paddingHorizontal: 16,
    paddingTop: 10,
  },
  divider: {
    height: 1,
    width: '100%',
  },
  formSection: {
    gap: 18,
    padding: 18,
    paddingTop: 18,
  },
  headerDivider: {
    height: 1,
    width: '100%',
  },
  heroArt: {
    height: '100%',
    resizeMode: 'contain',
    width: '100%',
  },
  heroArtStage: {
    alignItems: 'center',
    borderRadius: 28,
    borderWidth: 1,
    height: 176,
    justifyContent: 'center',
    overflow: 'hidden',
    padding: 12,
    width: 132,
  },
  heroCopy: {
    alignItems: 'center',
    gap: 8,
    width: '100%',
  },
  heroFallback: {
    paddingHorizontal: 10,
    textAlign: 'center',
  },
  heroMeta: {
    paddingHorizontal: 16,
    textAlign: 'center',
    width: '100%',
  },
  heroName: {
    textAlign: 'center',
  },
  heroSection: {
    alignItems: 'center',
    gap: 16,
    paddingBottom: 20,
    paddingHorizontal: 18,
    paddingTop: 20,
  },
  quantityButton: {
    alignItems: 'center',
    borderRadius: 24,
    borderWidth: 1,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  quantityButtonLabel: {
    fontSize: 22,
    fontWeight: '700',
    lineHeight: 22,
  },
  quantityRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
  },
  quantityValue: {
    minWidth: 36,
    textAlign: 'center',
  },
  safeArea: {
    flex: 1,
  },
  section: {
    gap: 12,
  },
  selectionRow: {
    flexDirection: 'row',
    gap: 10,
  },
  sheetCard: {
    borderRadius: 28,
    borderWidth: 1,
    overflow: 'hidden',
  },
  sheetContent: {
    gap: 14,
    paddingBottom: 132,
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  sheetHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    paddingBottom: 8,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  sheetHeaderCopy: {
    alignItems: 'center',
    flex: 1,
    gap: 12,
  },
  sheetHeaderSpacer: {
    width: chromeBackButtonSize,
  },
  sheetBackButton: {
    flexShrink: 0,
  },
  sheetTitle: {
    color: '#0F0F12',
  },
  sheetViewport: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheetWrap: {
    flex: 1,
    gap: 0,
    marginTop: 10,
    overflow: 'hidden',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
  },
  stateAction: {
    alignItems: 'center',
    borderRadius: 14,
    justifyContent: 'center',
    minHeight: 46,
    minWidth: 112,
    paddingHorizontal: 18,
  },
  stateActionLabel: {
    color: '#FFFFFF',
  },
  stateCard: {
    alignItems: 'flex-start',
    borderRadius: 18,
    borderWidth: 1,
    gap: 14,
    padding: 18,
  },
  stateCopy: {
    gap: 4,
  },
  stateMessage: {
    maxWidth: 320,
  },
  submitButton: {
    alignItems: 'center',
    borderRadius: 28,
    justifyContent: 'center',
    minHeight: 48,
  },
  submitButtonLabel: {
    color: '#0F0F12',
  },
  submitError: {
    paddingHorizontal: 2,
  },
});
