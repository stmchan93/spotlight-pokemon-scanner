import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Check as IconCheck } from 'iconoir-react-native';

import { useSpotlightTheme } from '@spotlight/design-system';

export type GradeConditionOption = {
  id: string;
  label: string;
};

type GradeConditionSheetProps = {
  visible: boolean;
  /** Section title, e.g. "Grade". */
  title: string;
  options: GradeConditionOption[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
  testID?: string;
};

/**
 * Bottom-sheet picker for the card-detail grade (graded lane) / condition (raw
 * lane) selection — Figma 1185:1808 / 1185:2471. Slides up from the bottom like
 * the scanner tray: a handle, a section title, and a scrollable option list
 * where the selected row is purple with a check.
 */
export function GradeConditionSheet({
  visible,
  title,
  options,
  selectedId,
  onSelect,
  onClose,
  testID = 'grade-condition-sheet',
}: GradeConditionSheetProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="overFullScreen"
      statusBarTranslucent
      transparent
      visible={visible}
    >
      <View style={styles.root}>
        <Pressable
          accessibilityLabel="Close"
          accessibilityRole="button"
          onPress={onClose}
          style={styles.backdrop}
          testID={`${testID}-backdrop`}
        />
        <View
          style={[
            styles.sheet,
            {
              backgroundColor: theme.colors.gray0,
              paddingBottom: Math.max(insets.bottom, 16) + 8,
            },
          ]}
          testID={testID}
        >
          <View style={[styles.handle, { backgroundColor: theme.colors.gray200 }]} />
          <Text style={[theme.typography.titleSmall, styles.title, { color: theme.colors.gray900 }]}>
            {title}
          </Text>
          <ScrollView
            contentContainerStyle={styles.listContent}
            showsVerticalScrollIndicator
            style={styles.list}
            testID={`${testID}-list`}
          >
            {options.map((option) => {
              const selected = option.id === selectedId;
              return (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  key={option.id}
                  onPress={() => {
                    onSelect(option.id);
                    onClose();
                  }}
                  style={({ pressed }) => [styles.row, { opacity: pressed ? 0.7 : 1 }]}
                  testID={`${testID}-option-${option.id}`}
                >
                  <Text
                    style={[
                      selected ? theme.typography.bodyStrong : theme.typography.body,
                      { color: selected ? theme.colors.purple500 : theme.colors.gray900 },
                    ]}
                  >
                    {option.label}
                  </Text>
                  {selected ? (
                    <IconCheck color={theme.colors.purple500} height={24} width={24} />
                  ) : null}
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.3)',
  },
  sheet: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    maxHeight: '70%',
    paddingTop: 10,
  },
  handle: {
    alignSelf: 'center',
    borderRadius: 2,
    height: 4,
    width: 36,
  },
  title: {
    paddingBottom: 4,
    paddingHorizontal: 16,
    paddingTop: 18,
  },
  list: {
    flexGrow: 0,
  },
  listContent: {
    paddingVertical: 8,
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
});

export default GradeConditionSheet;
