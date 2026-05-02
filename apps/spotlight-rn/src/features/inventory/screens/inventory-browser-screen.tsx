import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import {
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
  PillButton,
  SearchField,
  StateCard,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { ChromeBackButton } from '@/components/chrome-back-button';
import { InventoryEntryCard } from '@/features/inventory/components/inventory-entry-card';
import { useAppServices } from '@/providers/app-providers';

type InventoryBrowserScreenProps = {
  initialMode?: 'browse' | 'select';
  initialSelectedIds?: string[];
  onBack: () => void;
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
  { label: 'Favorite', value: 'favorite' },
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

function ControlGroup({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  const theme = useSpotlightTheme();

  return (
    <View style={styles.controlGroup}>
      <Text style={[theme.typography.micro, styles.sectionLabel]}>{title}</Text>
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
  const [sortOption, setSortOption] = useState<InventorySortOption>('recent');
  const [filterOption, setFilterOption] = useState<InventoryFilterOption>('all');
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

  const handleEntryPress = useCallback((entry: InventoryCardEntry) => {
    if (selectionMode) {
      toggleSelection(entry.id);
      return;
    }
    onOpenEntry(entry);
  }, [onOpenEntry, selectionMode, toggleSelection]);

  const handleEntryLongPress = useCallback((entry: InventoryCardEntry) => {
    setSelectionMode(true);
    setSelectedIds((current) => {
      if (current.includes(entry.id)) {
        return current;
      }

      return [...current, entry.id];
    });
  }, []);

  return (
    <SafeAreaView
      edges={['top', 'left', 'right', 'bottom']}
      style={[styles.safeArea, { backgroundColor: theme.colors.canvas }]}
    >
      <View style={[styles.screen, { paddingBottom: insets.bottom + 24 }]}>
        <View style={styles.navRow}>
          <ChromeBackButton onPress={onBack} testID="inventory-back" />
          <Text style={[theme.typography.headline, { color: theme.colors.textSecondary }]}>Collection</Text>
          <View style={styles.navSpacer} />
        </View>

        <View style={styles.headerCopy}>
          <Text style={theme.typography.display}>View all cards</Text>
          <Text style={[theme.typography.headline, { color: theme.colors.textSecondary }]}>
            {displayedEntries.length} shown
          </Text>
        </View>

        <SearchField
          containerStyle={styles.searchField}
          onChangeText={setSearchQuery}
          placeholder="Search collection cards"
          returnKeyType="search"
          value={searchQuery}
        />

        <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
          <View style={styles.controlsCard}>
            <ControlGroup title="SORT">
              {sortOptions.map((option) => (
                <PillButton
                  key={option.value}
                  label={option.label}
                  onPress={() => setSortOption(option.value)}
                  selected={sortOption === option.value}
                  testID={`inventory-sort-${option.value}`}
                />
              ))}
            </ControlGroup>

            <ControlGroup title="FILTER">
              {filterOptions.map((option) => (
                <PillButton
                  key={option.value}
                  label={option.label}
                  onPress={() => setFilterOption(option.value)}
                  selected={filterOption === option.value}
                  testID={`inventory-filter-${option.value}`}
                />
              ))}
            </ControlGroup>
          </View>

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
              {displayedEntries.map((entry) => (
                <View key={entry.id} style={[styles.tileWrap, { width: tileWidth }]}>
                  <InventoryEntryCard
                    entry={entry}
                    isSelected={selectedIds.includes(entry.id)}
                    onLongPress={() => handleEntryLongPress(entry)}
                    onPress={() => handleEntryPress(entry)}
                    showConditionLabel
                    selectionMode={selectionMode}
                  />
                </View>
              ))}
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
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  chipRow: {
    flexDirection: 'row',
    gap: 10,
    paddingRight: 8,
  },
  controlGroup: {
    gap: 10,
  },
  controlsCard: {
    gap: 16,
    paddingHorizontal: 0,
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
  searchField: {
  },
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
