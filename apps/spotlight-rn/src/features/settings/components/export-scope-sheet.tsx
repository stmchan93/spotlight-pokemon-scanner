import { NavArrowRight } from 'iconoir-react-native';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { Collection } from '@spotlight/api-client';
import {
  Button,
  SheetHeader,
  SheetSurface,
  Text,
  borderWidths,
  spacing,
  useSpotlightTheme,
} from '@spotlight/design-system';

const ROW_ICON_SIZE = 20;

type ExportScopeSheetProps = {
  visible: boolean;
  collections: Collection[];
  /** `null` = every collection. */
  onChoose: (collectionId: string | null) => void;
  onClose: () => void;
  testID?: string;
};

/**
 * Settings → Export collection, when the owner has more than one collection:
 * export everything, or just one. Hidden collections are left out of "All"
 * server-side (the same rule as the All Collections total), so they say so.
 */
export function ExportScopeSheet({
  visible,
  collections,
  onChoose,
  onClose,
  testID = 'export-scope-sheet',
}: ExportScopeSheetProps) {
  const insets = useSafeAreaInsets();
  const hasHidden = collections.some((collection) => collection.hidden);

  return (
    <Modal animationType="slide" onRequestClose={onClose} transparent visible={visible}>
      <View style={styles.overlay}>
        <Pressable
          accessibilityLabel="Close export options"
          accessibilityRole="button"
          onPress={onClose}
          style={styles.backdrop}
          testID={`${testID}-backdrop`}
        />
        <SheetSurface
          style={{ paddingBottom: Math.max(insets.bottom, spacing.md) }}
          testID={testID}
        >
          <SheetHeader title="Export collection" subtitle="Choose what goes in the spreadsheet." />
          <View style={styles.list}>
            <ScopeRow
              detail={hasHidden ? 'Hidden collections are left out' : undefined}
              label="All collections"
              onPress={() => onChoose(null)}
              testID={`${testID}-all`}
            />
            {collections.map((collection) => (
              <ScopeRow
                key={collection.id}
                label={collection.name}
                onPress={() => onChoose(collection.id)}
                testID={`${testID}-collection-${collection.id}`}
              />
            ))}
          </View>
          <Button label="Cancel" onPress={onClose} size="lg" testID={`${testID}-cancel`} variant="outline" />
        </SheetSurface>
      </View>
    </Modal>
  );
}

function ScopeRow({
  label,
  detail,
  onPress,
  testID,
}: {
  label: string;
  detail?: string;
  onPress: () => void;
  testID: string;
}) {
  const theme = useSpotlightTheme();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        { borderBottomColor: theme.colors.gray200, opacity: pressed ? 0.7 : 1 },
      ]}
      testID={testID}
    >
      <View style={styles.rowCopy}>
        <Text numberOfLines={1} style={[theme.typography.bodyStrong, { color: theme.colors.gray900 }]}>
          {label}
        </Text>
        {detail ? (
          <Text style={[theme.typography.caption, { color: theme.colors.gray600 }]}>{detail}</Text>
        ) : null}
      </View>
      <NavArrowRight color={theme.colors.gray500} height={ROW_ICON_SIZE} width={ROW_ICON_SIZE} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // Same dim as the collection picker's sheet backdrop.
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
  },
  list: {
    marginBottom: spacing.md,
  },
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  row: {
    alignItems: 'center',
    borderBottomWidth: borderWidths.rule,
    flexDirection: 'row',
    gap: spacing.xs,
    minHeight: 52,
  },
  rowCopy: {
    flex: 1,
    gap: 2,
  },
});
