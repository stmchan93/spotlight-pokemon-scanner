import { StyleSheet, Text, View } from 'react-native';

import { IconButton, SearchField, colors, textStyles } from '@spotlight/design-system';

import { GridViewIcon, ListViewIcon } from '../../../components/view-toggle-icons';

export type CollectionViewMode = 'grid' | 'list';

type CollectionSearchRowProps = {
  query: string;
  onChangeQuery: (value: string) => void;
  viewMode?: CollectionViewMode;
  onToggleViewMode?: () => void;
  testID?: string;
};

export function CollectionSearchRow({
  query,
  onChangeQuery,
  viewMode,
  onToggleViewMode,
  testID = 'collection-search-row',
}: CollectionSearchRowProps) {
  const showToggle = viewMode != null && onToggleViewMode != null;
  const toggleToList = viewMode === 'grid';
  const ToggleIcon = toggleToList ? ListViewIcon : GridViewIcon;
  const toggleLabel = toggleToList ? 'Switch to list view' : 'Switch to grid view';

  return (
    <View style={styles.container} testID={testID}>
      <Text style={styles.title}>My Collection</Text>
      <View style={styles.row}>
        <View style={styles.searchSlot}>
          <SearchField
            accessibilityLabel="Search your collection"
            autoCorrect={false}
            autoCapitalize="none"
            clearButtonMode="while-editing"
            containerTestID={`${testID}-input`}
            onChangeText={onChangeQuery}
            placeholder="Search your collection"
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
});
