import { Camera, MediaImage, Xmark } from 'iconoir-react-native';
import { ActivityIndicator, Image, Pressable, StyleSheet, View } from 'react-native';

import { Text, radii, spacing, useSpotlightTheme } from '@spotlight/design-system';

import type { AssistantPhotoSource } from '@/features/assistant/assistant-photo-scan';

const MENU_GLYPH_SIZE = 20;
const MENU_GLYPH_STROKE = 1.8;
const REMOVE_GLYPH_SIZE = 16;
// The card's own 5:7 shape, small enough to sit inside the composer.
const CHIP_THUMB_WIDTH = 36;
const CHIP_THUMB_HEIGHT = Math.round((CHIP_THUMB_WIDTH * 7) / 5);
const BUBBLE_THUMB_WIDTH = 96;
const BUBBLE_THUMB_HEIGHT = Math.round((BUBBLE_THUMB_WIDTH * 7) / 5);
const PRESSED_OPACITY = 0.7;

/** The "+" menu: Take photo / Choose photo, drawn inline above the field. */
export function AssistantPhotoMenu({ onSelect }: { onSelect: (source: AssistantPhotoSource) => void }) {
  const theme = useSpotlightTheme();
  const rows: { source: AssistantPhotoSource; label: string; Icon: typeof Camera }[] = [
    { source: 'camera', label: 'Take photo', Icon: Camera },
    { source: 'library', label: 'Choose photo', Icon: MediaImage },
  ];
  return (
    <View
      style={[styles.menu, { backgroundColor: theme.colors.gray50 }]}
      testID="assistant-photo-menu"
    >
      {rows.map(({ source, label, Icon }) => (
        <Pressable
          accessibilityRole="button"
          key={source}
          onPress={() => onSelect(source)}
          style={({ pressed }) => [styles.menuRow, { opacity: pressed ? PRESSED_OPACITY : 1 }]}
          testID={`assistant-photo-menu-${source}`}
        >
          <Icon
            color={theme.colors.gray900}
            height={MENU_GLYPH_SIZE}
            strokeWidth={MENU_GLYPH_STROKE}
            width={MENU_GLYPH_SIZE}
          />
          <Text style={[theme.typography.control, { color: theme.colors.gray900 }]}>
            {label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

export type AssistantPhotoChipState =
  | { status: 'identifying'; photoUri: string }
  | { status: 'failed'; photoUri: string }
  | { status: 'ready'; photoUri: string; label: string; alternateCount: number };

/**
 * The attached photo above the field: thumbnail + the scanner's top match, a
 * "Change" link to the alternates (the top match can be wrong), and an X.
 */
export function AssistantPhotoChip({
  state,
  onChangeMatch,
  onRemove,
  onRetry,
}: {
  state: AssistantPhotoChipState;
  onChangeMatch: () => void;
  onRemove: () => void;
  onRetry: () => void;
}) {
  const theme = useSpotlightTheme();
  return (
    <View style={styles.chip} testID="assistant-photo-chip">
      <View style={styles.chipThumbFrame}>
        <Image
          accessibilityIgnoresInvertColors
          source={{ uri: state.photoUri }}
          style={styles.chipThumb}
          testID="assistant-photo-chip-thumb"
        />
      </View>
      <View style={styles.chipBody}>
        {state.status === 'identifying' ? (
          <View style={styles.chipStatusRow}>
            <ActivityIndicator color={theme.colors.gray600} size="small" />
            <Text style={[theme.typography.caption, { color: theme.colors.gray600 }]} testID="assistant-photo-identifying">
              Identifying card…
            </Text>
          </View>
        ) : state.status === 'failed' ? (
          <>
            <Text style={[theme.typography.caption, { color: theme.colors.gray900 }]} testID="assistant-photo-failed">
              {"Couldn't identify this card."}
            </Text>
            <Pressable accessibilityRole="button" hitSlop={spacing.xxs} onPress={onRetry} testID="assistant-photo-retry">
              <Text style={[theme.typography.caption, styles.link, { color: theme.colors.gray900 }]}>Try again</Text>
            </Pressable>
          </>
        ) : (
          <>
            <Text
              numberOfLines={2}
              style={[theme.typography.caption, { color: theme.colors.gray900 }]}
              testID="assistant-photo-match"
            >
              {state.label}
            </Text>
            {state.alternateCount > 0 ? (
              <Pressable
                accessibilityHint="Pick another match for this photo"
                accessibilityRole="button"
                hitSlop={spacing.xxs}
                onPress={onChangeMatch}
                testID="assistant-photo-change"
              >
                <Text style={[theme.typography.caption, styles.link, { color: theme.colors.gray600 }]}>
                  Not it? Change
                </Text>
              </Pressable>
            ) : null}
          </>
        )}
      </View>
      <Pressable
        accessibilityLabel="Remove photo"
        accessibilityRole="button"
        hitSlop={spacing.xxs}
        onPress={onRemove}
        style={({ pressed }) => [styles.remove, { backgroundColor: theme.colors.gray200, opacity: pressed ? PRESSED_OPACITY : 1 }]}
        testID="assistant-photo-remove"
      >
        <Xmark color={theme.colors.gray900} height={REMOVE_GLYPH_SIZE} strokeWidth={2} width={REMOVE_GLYPH_SIZE} />
      </Pressable>
    </View>
  );
}

/** The photo above the user's bubble, with the card it was sent as. */
export function AssistantPhotoBubbleThumb({ photoUri, label }: { photoUri: string; label: string }) {
  const theme = useSpotlightTheme();
  return (
    <View style={styles.bubbleColumn} testID="assistant-photo-bubble">
      <View style={styles.bubbleThumbFrame}>
        <Image
          accessibilityIgnoresInvertColors
          accessibilityLabel={`Photo of ${label}`}
          source={{ uri: photoUri }}
          style={styles.bubbleThumb}
        />
      </View>
      <Text numberOfLines={1} style={[theme.typography.caption, styles.bubbleLabel, { color: theme.colors.gray600 }]}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  menu: {
    alignSelf: 'flex-start',
    borderCurve: 'continuous',
    borderRadius: radii.lg,
    marginBottom: spacing.xxs,
    paddingVertical: spacing.xxxs,
  },
  menuRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  chip: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xs,
    paddingBottom: spacing.xxs,
  },
  chipThumbFrame: {
    borderCurve: 'continuous',
    borderRadius: radii.xs,
    height: CHIP_THUMB_HEIGHT,
    overflow: 'hidden',
    width: CHIP_THUMB_WIDTH,
  },
  chipThumb: {
    height: '100%',
    width: '100%',
  },
  chipBody: {
    flex: 1,
    gap: 2,
  },
  chipStatusRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xxs,
  },
  link: {
    textDecorationLine: 'underline',
  },
  remove: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: radii.pill,
    height: 24,
    justifyContent: 'center',
    width: 24,
  },
  bubbleColumn: {
    alignItems: 'flex-end',
    gap: spacing.xxxs,
  },
  bubbleThumbFrame: {
    borderCurve: 'continuous',
    borderRadius: radii.md,
    height: BUBBLE_THUMB_HEIGHT,
    overflow: 'hidden',
    width: BUBBLE_THUMB_WIDTH,
  },
  bubbleThumb: {
    height: '100%',
    width: '100%',
  },
  bubbleLabel: {
    maxWidth: 240,
  },
});
