import { useState } from 'react';
import { Image, Pressable, StyleSheet, View } from 'react-native';

import { gameDisplayName, type CardGame, type ExpansionRecord } from '@spotlight/api-client';
import { Text, useSpotlightTheme } from '@spotlight/design-system';

type GameMosaicTileProps = {
  game: CardGame;
  /** That game's sets, newest first. Only the first few are drawn. */
  expansions: readonly ExpansionRecord[];
  /** How many sets the game has, shown under the name. */
  setCount: number;
  loading?: boolean;
  onPress: () => void;
  testID?: string;
};

/** Four panes: enough to read as a collage, few enough that each logo is legible. */
const MOSAIC_TILES = 4;

/**
 * One game in the browse grid, drawn as a mosaic of that game's own set logos.
 *
 * NOT A GAME LOGO. Pokémon and One Piece publish wordmarks we could use (both
 * are PD-textlogo on Wikimedia), but Lorcana, Riftbound and Gundam do not —
 * Riot's policy forbids their marks outright without a written licence, and
 * Ravensburger and Bandai publish no third-party terms at all. A grid where two
 * games have real logos and three have typography reads as broken.
 *
 * Set logos avoid that: every expansion has one, they arrive through the same
 * catalog feed the set browser already renders them from, and they are
 * consistent across all five games. They also preview the destination — the
 * tile shows the sets you are about to browse.
 */
export function GameMosaicTile({
  game,
  expansions,
  setCount,
  loading = false,
  onPress,
  testID,
}: GameMosaicTileProps) {
  const theme = useSpotlightTheme();
  const [failedUris, setFailedUris] = useState<readonly string[]>([]);

  const panes = expansions
    .map((expansion) => expansion.imageUrl)
    .filter((uri): uri is string => !!uri && !failedUris.includes(uri))
    .slice(0, MOSAIC_TILES);

  return (
    <Pressable
      accessibilityLabel={`${gameDisplayName(game)}, ${setCount} ${setCount === 1 ? 'set' : 'sets'}`}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.tile, { opacity: pressed ? 0.8 : 1 }]}
      testID={testID}
    >
      <View
        style={[
          styles.frame,
          { backgroundColor: theme.colors.field, borderColor: theme.colors.outlineSubtle },
        ]}
      >
        {panes.length > 0 ? (
          <View style={styles.mosaic}>
            {panes.map((uri) => (
              <View key={uri} style={[styles.pane, panes.length === 1 ? styles.paneSolo : null]}>
                <Image
                  onError={() => setFailedUris((current) => [...current, uri])}
                  resizeMode="contain"
                  source={{ uri }}
                  style={styles.paneImage}
                />
              </View>
            ))}
          </View>
        ) : (
          // No art yet (still loading, or a game whose sets carry no logo): the
          // name holds the tile's shape so the grid never reflows underneath a
          // tap.
          <Text
            numberOfLines={2}
            style={[
              styles.framePlaceholder,
              theme.typography.caption,
              { color: theme.colors.textSecondary },
            ]}
          >
            {loading ? '' : gameDisplayName(game)}
          </Text>
        )}
      </View>
      <Text
        numberOfLines={1}
        style={[styles.name, theme.typography.body, { color: theme.colors.textPrimary }]}
      >
        {gameDisplayName(game)}
      </Text>
      <Text
        numberOfLines={1}
        style={[theme.typography.caption, { color: theme.colors.textSecondary }]}
      >
        {loading ? 'Loading sets…' : `${setCount} ${setCount === 1 ? 'set' : 'sets'}`}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // Matches ExpansionCell so the game grid and the set grid are one system.
  tile: {
    alignItems: 'center',
    flex: 1 / 2,
    gap: 6,
    padding: 8,
  },
  frame: {
    alignItems: 'center',
    aspectRatio: 16 / 10,
    borderCurve: 'continuous',
    borderRadius: 12,
    borderWidth: 1,
    justifyContent: 'center',
    overflow: 'hidden',
    width: '100%',
  },
  framePlaceholder: {
    paddingHorizontal: 8,
    textAlign: 'center',
  },
  mosaic: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    height: '100%',
    width: '100%',
  },
  pane: {
    alignItems: 'center',
    height: '50%',
    justifyContent: 'center',
    padding: 4,
    width: '50%',
  },
  // A game with a single set fills the frame rather than sitting in a quarter.
  paneSolo: {
    height: '100%',
    padding: 10,
    width: '100%',
  },
  paneImage: {
    height: '100%',
    width: '100%',
  },
  name: {
    textAlign: 'center',
    width: '100%',
  },
});
