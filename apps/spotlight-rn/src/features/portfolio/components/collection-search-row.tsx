import { StyleSheet, View } from 'react-native';
import type { ReactNode, RefObject } from 'react';
import type { TextInput, TextInputProps } from 'react-native';

import { IconButton, SearchField, Text, colors, textStyles } from '@spotlight/design-system';

import { GridViewIcon, ListViewIcon } from '../../../components/view-toggle-icons';

export type CollectionViewMode = 'grid' | 'list';

type CollectionSearchRowProps = {
  query: string;
  onChangeQuery: (value: string) => void;
  viewMode?: CollectionViewMode;
  onToggleViewMode?: () => void;
  onFocus?: TextInputProps['onFocus'];
  /** Ref to the underlying search input so callers can focus it (e.g. the
   * top-bar search bubble that scrolls here and drops the keyboard open). */
  inputRef?: RefObject<TextInput | null>;
  /**
   * Optional element rendered at the right edge of the "My Collection" title
   * line (e.g. the SINCE ADDED / 30D trend-window tag).
   */
  titleAccessory?: ReactNode;
  testID?: string;
};

export function CollectionSearchRow({
  query,
  onChangeQuery,
  viewMode,
  onToggleViewMode,
  onFocus,
  inputRef,
  titleAccessory,
  testID = 'collection-search-row',
}: CollectionSearchRowProps) {
  const showToggle = viewMode != null && onToggleViewMode != null;
  const toggleToList = viewMode === 'grid';
  const ToggleIcon = toggleToList ? ListViewIcon : GridViewIcon;
  const toggleLabel = toggleToList ? 'Switch to list view' : 'Switch to grid view';

  return (
    <View style={styles.container} testID={testID}>
      <View style={styles.titleRow}>
        <Text style={styles.title}>My Portfolio</Text>
        {titleAccessory ?? null}
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
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 12,
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
  title: {
    ...textStyles.titleMedium,
    color: colors.gray900,
  },
  titleRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
});
