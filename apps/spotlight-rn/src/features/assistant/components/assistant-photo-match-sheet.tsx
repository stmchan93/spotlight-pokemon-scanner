import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { CatalogSearchResult } from '@spotlight/api-client';
import {
  CardThumbnail,
  RadioDot,
  SheetHeader,
  SheetSurface,
  Text,
  layout,
  spacing,
  useSpotlightTheme,
} from '@spotlight/design-system';

const PRESSED_OPACITY = 0.7;

type AssistantPhotoMatchSheetProps = {
  visible: boolean;
  candidates: CatalogSearchResult[];
  selectedCardId: string | null;
  onSelect: (cardId: string) => void;
  onClose: () => void;
};

/** "Which card is it?": the scanner's top matches for a chat photo; a tap picks one. */
export function AssistantPhotoMatchSheet({
  visible,
  candidates,
  selectedCardId,
  onSelect,
  onClose,
}: AssistantPhotoMatchSheetProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  if (!visible) {
    return null;
  }
  return (
    <Modal animationType="slide" onRequestClose={onClose} transparent visible>
      <Pressable
        accessibilityLabel="Close"
        accessibilityRole="button"
        onPress={onClose}
        style={styles.backdrop}
        testID="assistant-photo-sheet-backdrop"
      />
      <SheetSurface
        padding={0}
        style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, spacing.sm) }]}
        testID="assistant-photo-sheet"
      >
        <SheetHeader style={styles.header} subtitle="Pick the card in your photo." title="Which card is it?" />
        <ScrollView contentContainerStyle={styles.list}>
          {candidates.map((card, index) => {
            const selected = card.cardId === selectedCardId;
            const number = (card.cardNumber ?? '').replace(/^#/, '');
            return (
              <Pressable
                accessibilityRole="radio"
                accessibilityState={{ selected }}
                key={card.cardId}
                onPress={() => onSelect(card.cardId)}
                style={({ pressed }) => [styles.row, { opacity: pressed ? PRESSED_OPACITY : 1 }]}
                testID={`assistant-photo-candidate-${index}`}
              >
                <CardThumbnail
                  accessibilityLabel={card.name}
                  size="sm"
                  source={card.smallImageUrl || card.imageUrl ? { uri: card.smallImageUrl || card.imageUrl } : null}
                />
                <View style={styles.rowText}>
                  <Text numberOfLines={1} style={[theme.typography.bodyStrong, { color: theme.colors.gray900 }]}>
                    {card.name}
                  </Text>
                  <Text numberOfLines={1} style={[theme.typography.caption, { color: theme.colors.gray600 }]}>
                    {[card.setName, number].filter(Boolean).join(' · ')}
                  </Text>
                </View>
                <RadioDot selected={selected} selectedColor={theme.colors.purple500} size={20} />
              </Pressable>
            );
          })}
        </ScrollView>
      </SheetSurface>
    </Modal>
  );
}

const styles = StyleSheet.create({
  // Same dim as the app's other modal sheets.
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
  },
  sheet: {
    bottom: 0,
    left: 0,
    maxHeight: '70%',
    position: 'absolute',
    right: 0,
  },
  header: {
    paddingHorizontal: layout.pageGutter,
    paddingTop: spacing.md,
  },
  list: {
    paddingHorizontal: layout.pageGutter,
    paddingTop: spacing.xs,
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xs,
    paddingVertical: spacing.xxs,
  },
  rowText: {
    flex: 1,
    gap: 2,
  },
});
