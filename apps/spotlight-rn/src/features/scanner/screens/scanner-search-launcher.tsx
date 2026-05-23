import { IconSearch } from '@tabler/icons-react-native';
import { StyleSheet } from 'react-native';

import { SearchField, colors } from '@spotlight/design-system';

export function ScannerSearchLauncher({
  onChangeText,
  onFocusChange,
  onSubmit,
  value,
}: {
  onChangeText: (value: string) => void;
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
      leading={<IconSearch color={colors.gray0} size={16} strokeWidth={2} />}
      size="compact"
      onBlur={() => {
        onFocusChange(false);
      }}
      onChangeText={onChangeText}
      onFocus={() => {
        onFocusChange(true);
      }}
      onSubmitEditing={onSubmit}
      placeholder="Search cards"
      placeholderTextColor={colors.gray0}
      returnKeyType="search"
      value={value}
    />
  );
}

const styles = StyleSheet.create({
  searchLauncher: {
    backgroundColor: 'rgba(0, 0, 0, 0.1)',
    borderColor: colors.gray0,
    flex: 1,
    height: 32,
    minWidth: 0,
    paddingVertical: 0,
  },
  searchLauncherInput: {
    color: colors.gray0,
    fontSize: 13,
    lineHeight: 18.2,
  },
});
