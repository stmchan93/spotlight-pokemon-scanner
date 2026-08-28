import { Pressable, StyleSheet, View } from 'react-native';
import type { ReactNode, RefObject } from 'react';
import type { TextInput, TextInputProps } from 'react-native';
import { NavArrowDown, Search as SearchIcon } from 'iconoir-react-native';

import { IconButton, SearchField, Text, colors, textStyles } from '@spotlight/design-system';

import { GridViewIcon, ListViewIcon } from '../../../components/view-toggle-icons';

export type CollectionViewMode = 'grid' | 'list';

type CollectionSearchRowProps = {
  query: string;
  onChangeQuery: (value: string) => void;
  viewMode?: CollectionViewMode;
  onToggleViewMode?: () => void;
  onFocus?: TextInputProps['onFocus'];
  /**
   * "Search Card" action — opens the card-catalog search dialog. Rendered as the
   * bordered button to the right of the collection search input (Figma
   * 2724:1722). Replaces the old floating bottom-right catalog-search FAB.
   */
  onSearchCard?: () => void;
  /** Ref to the underlying search input so callers can focus it (e.g. the
   * top-bar search bubble that scrolls here and drops the keyboard open). */
  inputRef?: RefObject<TextInput | null>;
  /**
   * Name shown in the collection picker on the summary line (Figma 2749:4749).
   * Reads "All Collections" when the aggregate is active, otherwise the active
   * collection's name.
   */
  collectionName?: string;
  /**
   * Right side of the summary line — already formatted and already masked when
   * the viewer has hidden their balance, so this component stays presentational.
   */
  totalValueLabel?: string;
  /** Tap on the collection name + chevron. Inert (no picker) when omitted. */
  onPressCollection?: () => void;
  /**
   * Optional element rendered at the right edge of the search row, after the
   * icon buttons (e.g. the Select / Done edit-mode toggle).
   */
  trailingAction?: ReactNode;
  testID?: string;
};

export function CollectionSearchRow({
  query,
  onChangeQuery,
  viewMode,
  onToggleViewMode,
  onFocus,
  onSearchCard,
  inputRef,
  collectionName = 'Main Collection',
  totalValueLabel,
  onPressCollection,
  trailingAction,
  testID = 'collection-search-row',
}: CollectionSearchRowProps) {
  const showToggle = viewMode != null && onToggleViewMode != null;
  const toggleToList = viewMode === 'grid';
  const ToggleIcon = toggleToList ? ListViewIcon : GridViewIcon;
  const toggleLabel = toggleToList ? 'Switch to list view' : 'Switch to grid view';

  return (
    <View style={styles.container} testID={testID}>
      {/* Collection summary line, Figma 2749:4749 — the collection picker on the
          left, the running total on the right. */}
      <View style={styles.summaryRow}>
        <Pressable
          accessibilityLabel={`Collection: ${collectionName}`}
          accessibilityRole="button"
          disabled={!onPressCollection}
          hitSlop={8}
          onPress={onPressCollection}
          style={styles.collectionPicker}
          testID={`${testID}-collection`}
        >
          <Text numberOfLines={1} style={styles.summaryText}>
            {collectionName}
          </Text>
          <NavArrowDown color={colors.gray900} height={24} width={24} />
        </Pressable>
        {totalValueLabel ? (
          <Text style={styles.summaryText} testID={`${testID}-total-value`}>
            {`Total Value: ${totalValueLabel}`}
          </Text>
        ) : null}
      </View>
      <View style={styles.row}>
        <View style={styles.searchSlot}>
          <SearchField
            ref={inputRef}
            accessibilityLabel="Search your portfolio"
            autoCorrect={false}
            autoCapitalize="none"
            clearButtonMode="while-editing"
            containerTestID={`${testID}-input`}
            onChangeText={onChangeQuery}
            onFocus={onFocus}
            placeholder="Search your portfolio"
            returnKeyType="search"
            size="collection"
            surface="muted"
            value={query}
          />
        </View>
        {showToggle ? (
          <IconButton
            accessibilityLabel={toggleLabel}
            onPress={onToggleViewMode}
            shape="rounded"
            size={40}
            testID={`${testID}-view-toggle`}
            variant="outlined"
          >
            <ToggleIcon color={colors.gray900} height={16} width={16} />
          </IconButton>
        ) : null}
        {onSearchCard ? (
          <IconButton
            accessibilityLabel="Search Cards"
            onPress={onSearchCard}
            shape="rounded"
            size={40}
            testID={`${testID}-search-card`}
            variant="outlined"
          >
            <SearchIcon color={colors.gray900} height={16} width={16} />
          </IconButton>
        ) : null}
        {trailingAction ?? null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 10,
    paddingHorizontal: 16,
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  searchSlot: {
    flex: 1,
  },
  collectionPicker: {
    alignItems: 'center',
    flexDirection: 'row',
    // No gap — the 24px chevron glyph carries its own optical padding, which is
    // how it sits flush against the label in Figma 2749:4750.
    flexShrink: 1,
  },
  summaryRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  summaryText: {
    ...textStyles.bodyMedium,
    color: colors.gray900,
  },
});
