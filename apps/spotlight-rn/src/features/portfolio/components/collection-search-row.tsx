import { StyleSheet, Text, View } from 'react-native';

import { SearchField, colors, textStyles } from '@spotlight/design-system';

type CollectionSearchRowProps = {
  query: string;
  onChangeQuery: (value: string) => void;
  testID?: string;
};

export function CollectionSearchRow({
  query,
  onChangeQuery,
  testID = 'collection-search-row',
}: CollectionSearchRowProps) {
  return (
    <View style={styles.container} testID={testID}>
      <Text style={styles.title}>My Collection</Text>
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
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 12,
    paddingHorizontal: 16,
  },
  title: {
    ...textStyles.titleMedium,
    color: colors.gray900,
  },
});
