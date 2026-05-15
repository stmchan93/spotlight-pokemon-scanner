import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { InventoryCardEntry, SlabContext } from '@spotlight/api-client';
import {
  Button,
  ListRow,
  SectionHeader,
  SheetHeader,
  SurfaceCard,
  TextField,
  colors,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { ChromeBackButton } from '@/components/chrome-back-button';
import { useAppServices } from '@/providers/app-providers';

const TEST_PREFIX = 'trade-sheet';

type TradeSheetProps = {
  /** Inbound card the user just scanned / received in the trade. */
  cardId: string;
  slabContext?: SlabContext | null;
  onClose: () => void;
  onComplete: () => void;
};

function parseCashDelta(text: string): number | null {
  if (!text.trim()) {
    return 0;
  }
  const cleaned = text.replace(/[^0-9.\-]/g, '');
  if (!cleaned) {
    return null;
  }
  const parsed = Number.parseFloat(cleaned);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Number(parsed.toFixed(2));
}

/**
 * Inventory-only trade-logging sheet. Multi-select outbound entries
 * from the seller's inventory; optionally enter a cash delta.
 *
 * MVP: this writes a portfolio buy on the inbound card and a sale per
 * outbound card. Until a dedicated /trades endpoint exists on the
 * backend, that's the safest way to keep both sides of the trade in
 * the existing transaction ledger. The cash delta is recorded as the
 * inbound buy's effective unit price.
 */
export function TradeSheet({ cardId, slabContext, onClose, onComplete }: TradeSheetProps) {
  const theme = useSpotlightTheme();
  const { refreshData, spotlightRepository } = useAppServices();

  const [inventory, setInventory] = useState<InventoryCardEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedEntryIds, setSelectedEntryIds] = useState<string[]>([]);
  const [cashDeltaText, setCashDeltaText] = useState('');
  const [submitState, setSubmitState] = useState<'idle' | 'submitting'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    void spotlightRepository
      .getInventoryEntries()
      .then((entries) => {
        if (cancelled) {
          return;
        }
        // Filter out 0-qty rows — those have been sold.
        setInventory(entries.filter((entry) => entry.quantity > 0));
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        setLoadError(error instanceof Error ? error.message : 'Could not load your inventory.');
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

  const cashDelta = useMemo(() => parseCashDelta(cashDeltaText), [cashDeltaText]);
  const selectedEntries = useMemo(
    () => inventory.filter((entry) => selectedEntryIds.includes(entry.id)),
    [inventory, selectedEntryIds],
  );

  const toggleSelected = useCallback((entryId: string) => {
    setSelectedEntryIds((current) =>
      current.includes(entryId)
        ? current.filter((id) => id !== entryId)
        : [...current, entryId],
    );
  }, []);

  const handleSubmit = useCallback(async () => {
    if (cashDelta == null) {
      setErrorMessage('Enter a valid cash delta (or leave blank for an even trade).');
      return;
    }
    if (selectedEntries.length === 0) {
      setErrorMessage('Pick at least one outbound card.');
      return;
    }

    setSubmitState('submitting');
    setErrorMessage(null);

    const inboundUnitPrice = Math.max(0, cashDelta);
    const nowIso = new Date().toISOString();

    try {
      // Outbound — record a sale per selected entry (quantity=1).
      for (const entry of selectedEntries) {
        await spotlightRepository.createPortfolioSale({
          deckEntryID: entry.id,
          cardID: entry.cardId,
          slabContext: entry.slabContext ?? null,
          quantity: 1,
          unitPrice: entry.marketPrice || 0,
          currencyCode: entry.currencyCode || 'USD',
          paymentMethod: 'trade',
          soldAt: nowIso,
          saleSource: 'trade',
          showSessionID: null,
          note: 'Trade outbound',
          sourceScanID: null,
        });
      }

      // Inbound — record a buy at the cash-delta value.
      await spotlightRepository.createPortfolioBuy({
        cardID: cardId,
        slabContext: slabContext ?? null,
        variantName: null,
        condition: slabContext ? null : 'near_mint',
        quantity: 1,
        unitPrice: inboundUnitPrice,
        currencyCode: 'USD',
        paymentMethod: 'trade',
        boughtAt: nowIso,
        sourceScanID: null,
      });

      refreshData();
      onComplete();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not log this trade.');
    } finally {
      setSubmitState('idle');
    }
  }, [cardId, cashDelta, onComplete, refreshData, selectedEntries, slabContext, spotlightRepository]);

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
            <SheetHeader subtitle={loadError} title="Inventory unavailable" />
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
        testID={`${TEST_PREFIX}-scroll`}
      >
        <ChromeBackButton onPress={onClose} testID={`${TEST_PREFIX}-close`} />
        <SheetHeader showHandle subtitle="Pick what you're giving up." title="Log a trade" />

        <SurfaceCard padding={16} radius={24}>
          <SectionHeader subtitle="Tap to add or remove from this trade." title="Outbound cards" />
          {inventory.length === 0 ? (
            <SectionHeader subtitle="You don't own anything to trade yet." title="Empty inventory" />
          ) : (
            <View style={styles.list} testID={`${TEST_PREFIX}-inventory-list`}>
              {inventory.map((entry) => {
                const isSelected = selectedEntryIds.includes(entry.id);
                return (
                  <ListRow
                    key={entry.id}
                    meta={isSelected ? 'Selected' : 'Tap to add'}
                    onPress={() => toggleSelected(entry.id)}
                    subtitle={`${entry.setName} • ${entry.cardNumber}`}
                    testID={`${TEST_PREFIX}-inventory-row-${entry.id}`}
                    title={entry.name}
                  />
                );
              })}
            </View>
          )}
        </SurfaceCard>

        <SurfaceCard padding={20} radius={24}>
          <SectionHeader
            subtitle="Positive if you paid the other side. Negative if they paid you."
            title="Cash delta"
          />
          <TextField
            keyboardType="numbers-and-punctuation"
            label="USD"
            maxLength={9}
            onChangeText={(value) => {
              setCashDeltaText(value);
              setErrorMessage(null);
            }}
            placeholder="0.00"
            testID={`${TEST_PREFIX}-cash-delta-input`}
            value={cashDeltaText}
          />
        </SurfaceCard>

        {errorMessage ? (
          <SurfaceCard padding={16} radius={20} testID={`${TEST_PREFIX}-error`} variant="muted">
            <SectionHeader subtitle={errorMessage} title="Could not log trade" />
          </SurfaceCard>
        ) : null}

        <Button
          disabled={submitState === 'submitting' || selectedEntries.length === 0}
          label={submitState === 'submitting' ? 'Saving…' : 'Save trade'}
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
  list: {
    gap: 4,
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
