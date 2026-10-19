import { Pressable, StyleSheet, View } from 'react-native';

import { gameDisplayName, type CardGame } from '@spotlight/api-client';
import { RadioDot, Text, useSpotlightTheme } from '@spotlight/design-system';

import { InsightsBottomSheet } from '@/features/insights/components/insights-bottom-sheet';

type InsightsGameSheetProps = {
  visible: boolean;
  /** Games the portfolio has entries for, in CARD_GAMES order. */
  games: readonly CardGame[];
  selectedGame: CardGame;
  /** Tapping a row commits immediately and closes the sheet. */
  onSelect: (game: CardGame) => void;
  onClose: () => void;
  testID?: string;
};

/**
 * Game picker behind the Insights category header (Figma 5689:18276 chevron).
 * Lists only the games the user actually holds; a tap commits at once, so the
 * header is just the handle + a title (no CANCEL/APPLY draft like the sort
 * sheet). Rows follow the scanner's "Scanning for" sheet: uppercase caption
 * label, purple radio dot on the selected game.
 */
export function InsightsGameSheet({
  visible,
  games,
  selectedGame,
  onSelect,
  onClose,
  testID = 'insights-game-sheet',
}: InsightsGameSheetProps) {
  const theme = useSpotlightTheme();

  return (
    <InsightsBottomSheet
      header={
        <Text
          style={[theme.typography.titleSmall, styles.title, { color: theme.colors.gray900 }]}
        >
          Game
        </Text>
      }
      onClose={onClose}
      testID={testID}
      visible={visible}
    >
      <View style={styles.options}>
        {games.map((game) => {
          const selected = game === selectedGame;
          return (
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              key={game}
              onPress={() => onSelect(game)}
              style={({ pressed }) => [styles.optionRow, pressed ? styles.optionRowPressed : null]}
              testID={`${testID}-option-${game}`}
            >
              {/* String casing rather than textTransform so the flex row
                  measures the capitals (iOS clips textTransform'd text in
                  tight rows). */}
              <Text style={[theme.typography.caption, { color: theme.colors.gray900 }]}>
                {gameDisplayName(game).toUpperCase()}
              </Text>
              <RadioDot selected={selected} selectedColor={theme.colors.purple500} />
            </Pressable>
          );
        })}
      </View>
    </InsightsBottomSheet>
  );
}

const styles = StyleSheet.create({
  optionRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
    width: '100%',
  },
  optionRowPressed: {
    opacity: 0.7,
  },
  options: {
    paddingTop: 16,
  },
  title: {
    marginTop: 14,
    textAlign: 'center',
  },
});

export default InsightsGameSheet;
