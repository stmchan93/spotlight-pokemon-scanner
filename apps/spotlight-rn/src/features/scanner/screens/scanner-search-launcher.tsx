import { IconSearch } from '@tabler/icons-react-native';
import { FilterList } from 'iconoir-react-native';
import { Pressable, StyleSheet } from 'react-native';

import { SearchField, colors } from '@spotlight/design-system';

export function ScannerSearchLauncher({
  onChangeText,
  onFilterPress,
  onFocusChange,
  onSubmit,
  value,
}: {
  onChangeText: (value: string) => void;
  onFilterPress?: () => void;
  onFocusChange: (focused: boolean) => void;
  onSubmit: () => void;
  value: string;
}) {
  return (
    <SearchField
      autoCapitalize="none"
      autoCorrect={false}
      containerStyle={styles.searchLauncher}
      containerTestID="scanner-search-launcher"
      inputStyle={styles.searchLauncherInput}
      leading={<IconSearch color={colors.gray0} size={18} strokeWidth={2} />}
      trailing={
        onFilterPress ? (
          <Pressable hitSlop={8} onPress={onFilterPress}>
            <FilterList color={colors.gray0} height={16} width={16} />
          </Pressable>
        ) : undefined
      }
      onBlur={() => {
        onFocusChange(false);
      }}
      onChangeText={onChangeText}
      onFocus={() => {
        onFocusChange(true);
      }}
      onSubmitEditing={onSubmit}
      placeholder="Search for a card"
      placeholderTextColor="rgba(255, 255, 255, 0.6)"
      returnKeyType="search"
      value={value}
    />
  );
}

const styles = StyleSheet.create({
  searchLauncher: {
    backgroundColor: 'transparent',
    borderColor: colors.gray0,
    borderRadius: 999,
    borderWidth: 1,
    flex: 1,
    minHeight: 0,
    minWidth: 0,
    paddingHorizontal: 8,
    paddingVertical: 7,
  },
  searchLauncherInput: {
    color: colors.gray0,
  },
});
