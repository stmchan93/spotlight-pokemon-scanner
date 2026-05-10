import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import type {
  InventoryCardEntry,
  InventoryFilterOption,
  InventorySortOption,
} from '@spotlight/api-client';
import {
  Button,
  IconButton,
  InventoryCardTile,
  PillButton,
  SearchField,
  StateCard,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { ChromeBackButton } from '@/components/chrome-back-button';
import {
  formatOptionalCurrency,
  formatSignedCurrency,
} from '@/features/portfolio/components/portfolio-formatting';
import { makeInventorySmokeTestID } from '@/features/inventory/inventory-smoke-selectors';
import { resolveConditionDisplayLabel } from '@/lib/condition-display';
import { getCardImageUrl } from '@/lib/card-images';
import { useAppServices } from '@/providers/app-providers';

type InventoryBrowserScreenProps = {
  initialMode?: 'browse' | 'select';
  initialSelectedIds?: string[];
  onBack: () => void;
  onOpenAddCard?: () => void;
  onOpenBulkSell: (entryIds: string[]) => void;
  onOpenEntry: (entry: InventoryCardEntry) => void;
};

const sortOptions: { label: string; value: InventorySortOption }[] = [
  { label: 'Recent', value: 'recent' },
  { label: 'Value', value: 'value' },
  { label: 'A-Z', value: 'a-z' },
];

const filterOptions: { label: string; value: InventoryFilterOption }[] = [
  { label: 'All', value: 'all' },
  { label: 'Raw', value: 'raw' },
  { label: 'Graded', value: 'graded' },
  { label: 'Favorites', value: 'favorite' },
];

const PAGE_GUTTER = 16;
const GRID_GAP = 12;

function searchText(entry: InventoryCardEntry) {
  return [
    entry.name,
    entry.setName,
    entry.cardNumber,
    entry.conditionLabel,
    entry.conditionShortLabel,
    entry.variantName,
    entry.slabContext?.grader,
    entry.slabContext?.grade,
    entry.slabContext?.variantName,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function rawConditionLabelFor(entry: InventoryCardEntry) {
  return resolveConditionDisplayLabel({
    conditionCode: entry.conditionCode,
    conditionLabel: entry.conditionLabel,
    conditionShortLabel: entry.conditionShortLabel,
    fallback: '',
  }) || null;
}

function priceLabelFor(entry: InventoryCardEntry) {
  if (!entry.hasMarketPrice) {
    return null;
  }
  return formatOptionalCurrency(entry.marketPrice, entry.currencyCode);
}

function dayChangeLabelFor(entry: InventoryCardEntry) {
  const amount = entry.dayChangeAmount;
  if (amount == null || amount === 0) {
    return null;
  }
  // The tile renders its own ↑ / ↓ arrow based on `dayChangeDirection`, so
  // we strip the leading sign and pass an unsigned currency string here.
  const formatted = formatSignedCurrency(amount, entry.currencyCode);
  if (formatted.startsWith('+') || formatted.startsWith('-')) {
    return formatted.slice(1);
  }
  return formatted;
}

function dayChangeDirectionFor(entry: InventoryCardEntry) {
  const amount = entry.dayChangeAmount;
  if (amount == null || amount === 0) {
    return null;
  }
  return amount > 0 ? 'up' : 'down';
}

function SortRow({
  children,
}: {
  children: ReactNode;
}) {
  const theme = useSpotlightTheme();

  return (
    <View style={styles.controlGroup}>
      <Text style={[theme.typography.micro, styles.sectionLabel]}>SORT</Text>
      <ScrollView
        horizontal
        contentContainerStyle={styles.chipRow}
        showsHorizontalScrollIndicator={false}
      >
        {children}
      </ScrollView>
    </View>
  );
}

export function InventoryBrowserScreen({
  initialMode = 'browse',
  initialSelectedIds = [],
  onBack,
  onOpenAddCard,
  onOpenBulkSell,
  onOpenEntry,
}: InventoryBrowserScreenProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { spotlightRepository, dataVersion } = useAppServices();

  const [entries, setEntries] = useState<InventoryCardEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortOption, setSortOption] = useState<InventorySortOption>('value');
  const [filterOption, setFilterOption] = useState<InventoryFilterOption>('all');
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [selectionMode, setSelectionMode] = useState(initialMode === 'select');
  const [selectedIds, setSelectedIds] = useState<string[]>(initialSelectedIds);

  const tileWidth = useMemo(() => {
    return Math.max(96, Math.floor((width - PAGE_GUTTER * 2 - GRID_GAP * 2) / 3));
  }, [width]);

  const loadEntries = useCallback(async () => {
    setIsLoading(true);
    const loadResult = await spotlightRepository.loadInventoryEntries();
    setEntries(loadResult.data ?? []);
    setLoadError(loadResult.state === 'error' ? loadResult.errorMessage : null);
    setIsLoading(false);
  }, [spotlightRepository]);

  useEffect(() => {
    void loadEntries();
  }, [dataVersion, loadEntries]);

  const displayedEntries = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();
    let nextEntries = entries.filter((entry) => {
      if (filterOption === 'raw') {
        return entry.kind === 'raw';
      }
      if (filterOption === 'graded') {
        return entry.kind === 'graded';
      }
      if (filterOption === 'favorite') {
        return entry.isFavorite === true;
      }
      return true;
    });

    if (normalizedQuery.length > 0) {
      nextEntries = nextEntries.filter((entry) => searchText(entry).includes(normalizedQuery));
    }

    return nextEntries.slice().sort((left, right) => {
      switch (sortOption) {
        case 'value':
          return right.marketPrice - left.marketPrice;
        case 'a-z':
          return left.name.localeCompare(right.name);
        case 'recent':
        default:
          return new Date(right.addedAt).valueOf() - new Date(left.addedAt).valueOf();
      }
    });
  }, [entries, filterOption, searchQuery, sortOption]);

  const selectionCount = selectedIds.length;
  const trimmedSearchQuery = searchQuery.trim();

  const emptyState = useMemo(() => {
    if (entries.length === 0) {
      return {
        title: 'No cards in your inventory yet',
        message: 'Scan a card or add one manually.',
      };
    }

    if (trimmedSearchQuery.length > 0) {
      return {
        title: 'No cards match that search',
        message: 'Try a different name, set, card number, or collection filter.',
      };
    }

    return {
      title: 'No cards match that search',
      message: 'Try a different name, set, card number, or collection filter.',
    };
  }, [entries.length, trimmedSearchQuery.length]);

  const handleResetSelection = useCallback(() => {
    setSelectedIds([]);
  }, []);

  const toggleSelection = useCallback((entryId: string) => {
    setSelectedIds((current) => {
      if (current.includes(entryId)) {
        return current.filter((candidate) => candidate !== entryId);
      }

      return [...current, entryId];
    });
  }, []);

  const handleEntryPress = useCallback(
    (entry: InventoryCardEntry) => {
      if (selectionMode) {
        toggleSelection(entry.id);
        return;
      }
      onOpenEntry(entry);
    },
    [onOpenEntry, selectionMode, toggleSelection],
  );

  const handleEntryLongPress = useCallback((entry: InventoryCardEntry) => {
    setSelectionMode(true);
    setSelectedIds((current) => {
      if (current.includes(entry.id)) {
        return current;
      }

      return [...current, entry.id];
    });
  }, []);

  const handleToggleBulkSell = useCallback(() => {
    setSelectionMode((current) => {
      if (current) {
        setSelectedIds([]);
        return false;
      }
      return true;
    });
  }, []);

  const handleSelectFilter = useCallback((value: InventoryFilterOption) => {
    setFilterOption(value);
    setFilterMenuOpen(false);
  }, []);

  return (
    <SafeAreaView
      edges={['top', 'left', 'right', 'bottom']}
      style={[styles.safeArea, { backgroundColor: theme.colors.canvas }]}
    >
      <View style={[styles.screen, { paddingBottom: insets.bottom + 24 }]}>
        <View style={styles.navRow}>
          <ChromeBackButton onPress={onBack} testID="inventory-back" />
          <Text style={[theme.typography.headline, { color: theme.colors.textSecondary }]}>
            Collection
          </Text>
          <View style={styles.navSpacer} />
        </View>

        <View style={styles.headerCopy}>
          <Text style={theme.typography.display}>View all cards</Text>
          <Text style={[theme.typography.headline, { color: theme.colors.textSecondary }]}>
            {displayedEntries.length} shown
          </Text>
        </View>

        <View style={styles.actionRow}>
          <Button
            label="Add Card"
            onPress={() => onOpenAddCard?.()}
            style={styles.actionButton}
            testID="inventory-add-card"
            variant="primary"
          />
          <Button
            label={selectionMode ? 'Cancel' : 'Bulk Sell'}
            onPress={handleToggleBulkSell}
            style={styles.actionButton}
            testID="inventory-bulk-sell-toggle"
            variant="secondary"
          />
        </View>

        <SearchField
          containerStyle={styles.searchField}
          onChangeText={setSearchQuery}
          placeholder="Search collection cards"
          returnKeyType="search"
          value={searchQuery}
          trailing={
            <IconButton
              accessibilityLabel="Filter inventory"
              onPress={() => setFilterMenuOpen(true)}
              size={32}
              testID="inventory-filter-button"
              variant={filterOption === 'all' ? 'elevated' : 'brand'}
            >
              <Text
                style={[
                  theme.typography.caption,
                  {
                    color:
                      filterOption === 'all'
                        ? theme.colors.textSecondary
                        : theme.colors.textInverse,
                  },
                ]}
              >
                ⛛
              </Text>
            </IconButton>
          }
        />

        <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
          <SortRow>
            {sortOptions.map((option) => (
              <PillButton
                key={option.value}
                label={option.label}
                onPress={() => setSortOption(option.value)}
                selected={sortOption === option.value}
                testID={`inventory-sort-${option.value}`}
              />
            ))}
          </SortRow>

          {isLoading ? (
            <StateCard
              message="Fetching your deck entries and artwork."
              style={styles.stateCard}
              title="Loading your inventory..."
            />
          ) : loadError ? (
            <StateCard
              message={loadError}
              style={styles.stateCard}
              title="Could not load your backend data"
              variant="field"
            />
          ) : displayedEntries.length === 0 ? (
            <StateCard
              message={emptyState.message}
              style={styles.stateCard}
              title={emptyState.title}
            />
          ) : (
            <View style={styles.grid}>
              {displayedEntries.map((entry) => {
                const isSelected = selectedIds.includes(entry.id);
                const tileKind = entry.kind === 'graded' ? 'slab' : 'raw';
                return (
                  <View key={entry.id} style={[styles.tileWrap, { width: tileWidth }]}>
                    <View testID={`inventory-entry-${entry.id}`}>
                      <InventoryCardTile
                        cardNumber={entry.cardNumber ?? null}
                        conditionLabel={tileKind === 'raw' ? rawConditionLabelFor(entry) : null}
                        dayChangeDirection={dayChangeDirectionFor(entry)}
                        dayChangeLabel={dayChangeLabelFor(entry)}
                        gradeLabel={tileKind === 'slab' ? entry.slabContext?.grade ?? null : null}
                        graderLabel={tileKind === 'slab' ? entry.slabContext?.grader ?? null : null}
                        imageUrl={getCardImageUrl(entry, 'small')}
                        isFavorite={entry.isFavorite === true}
                        kind={tileKind}
                        name={entry.name}
                        onLongPress={() => handleEntryLongPress(entry)}
                        onPress={() => handleEntryPress(entry)}
                        priceLabel={priceLabelFor(entry)}
                        quantity={entry.quantity}
                        selected={selectionMode && isSelected}
                        setName={entry.setName}
                        testID={makeInventorySmokeTestID(entry)}
                      />
                    </View>
                  </View>
                );
              })}
            </View>
          )}
        </ScrollView>
      </View>

      {selectionMode ? (
        <View
          style={[
            styles.selectionBar,
            {
              paddingBottom: insets.bottom + 10,
            },
          ]}
        >
          <View style={styles.selectionInner}>
            <Pressable
              accessibilityRole="button"
              onPress={handleResetSelection}
              testID="inventory-clear-selection"
              style={[
                styles.selectionDismiss,
                {
                  backgroundColor: theme.colors.canvasElevated,
                  borderColor: theme.colors.outlineSubtle,
                },
              ]}
            >
              <Text style={theme.typography.titleCompact}>×</Text>
            </Pressable>

            <Button
              disabled={selectionCount === 0}
              label="Sell selected"
              labelStyleVariant="body"
              onPress={() => {
                if (selectionCount === 0) {
                  return;
                }
                onOpenBulkSell(selectedIds);
              }}
              style={styles.selectionAction}
              testID="inventory-sell-selected"
              variant="primary"
            />
          </View>
        </View>
      ) : null}

      <Modal
        animationType="fade"
        onRequestClose={() => setFilterMenuOpen(false)}
        transparent
        visible={filterMenuOpen}
      >
        <Pressable
          accessibilityLabel="Dismiss filter menu"
          onPress={() => setFilterMenuOpen(false)}
          style={styles.filterBackdrop}
          testID="inventory-filter-backdrop"
        >
          <Pressable
            accessibilityRole="menu"
            onPress={() => {}}
            style={[
              styles.filterSheet,
              {
                backgroundColor: theme.colors.canvasElevated,
                borderColor: theme.colors.outlineSubtle,
              },
            ]}
            testID="inventory-filter-menu"
          >
            <Text style={[theme.typography.micro, styles.filterSheetTitle]}>FILTER</Text>
            {filterOptions.map((option) => {
              const isActive = filterOption === option.value;
              return (
                <Pressable
                  accessibilityRole="menuitem"
                  accessibilityState={{ selected: isActive }}
                  key={option.value}
                  onPress={() => handleSelectFilter(option.value)}
                  style={({ pressed }) => [
                    styles.filterOption,
                    {
                      backgroundColor: isActive
                        ? theme.colors.surfaceMuted
                        : 'transparent',
                      opacity: pressed ? 0.85 : 1,
                    },
                  ]}
                  testID={`inventory-filter-${option.value}`}
                >
                  <Text
                    style={[
                      theme.typography.body,
                      { color: theme.colors.textPrimary },
                    ]}
                  >
                    {option.label}
                  </Text>
                  {isActive ? (
                    <Text
                      style={[theme.typography.body, { color: theme.colors.brand }]}
                    >
                      ✓
                    </Text>
                  ) : null}
                </Pressable>
              );
            })}
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  actionButton: {
    flex: 1,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 12,
  },
  chipRow: {
    flexDirection: 'row',
    gap: 10,
    paddingRight: 8,
  },
  controlGroup: {
    gap: 10,
  },
  filterBackdrop: {
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  filterOption: {
    alignItems: 'center',
    borderRadius: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  filterSheet: {
    borderRadius: 18,
    borderWidth: 1,
    gap: 4,
    padding: 16,
  },
  filterSheetTitle: {
    letterSpacing: 1.8,
    marginBottom: 6,
    paddingHorizontal: 14,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: GRID_GAP,
  },
  headerCopy: {
    gap: 4,
  },
  navRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  navSpacer: {
    width: 44,
  },
  safeArea: {
    flex: 1,
  },
  screen: {
    flex: 1,
    gap: 18,
    paddingHorizontal: PAGE_GUTTER,
    paddingTop: 8,
  },
  scrollContent: {
    gap: 18,
    paddingBottom: 120,
  },
  searchField: {},
  sectionLabel: {
    letterSpacing: 1.8,
  },
  selectionAction: {
    flex: 1,
    minHeight: 56,
  },
  selectionBar: {
    paddingHorizontal: PAGE_GUTTER,
    paddingTop: 12,
  },
  selectionDismiss: {
    alignItems: 'center',
    borderRadius: 32,
    borderWidth: 1,
    height: 56,
    justifyContent: 'center',
    width: 56,
  },
  selectionInner: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
  },
  stateCard: {
    alignItems: 'flex-start',
    paddingVertical: 20,
  },
  tileWrap: {
    minWidth: 96,
  },
});
