import { ScrollView, StyleSheet, View } from 'react-native';

import { AppText } from './app-text';
import { SkeletonBlock } from './skeleton-block';
import {
  TOP_MOVER_TILE_HEIGHT,
  TOP_MOVER_TILE_WIDTH,
  TopMoverTile,
  type TopMoverTileProps,
} from './top-mover-tile';

export type TopTrendsRailItem = TopMoverTileProps & { key: string };

export type TopTrendsRailProps = {
  /** Caption above the rail, e.g. "TOP TRENDS · 30 DAYS". */
  caption: string;
  items: TopTrendsRailItem[];
  /** While true and `items` is empty, two skeleton tiles hold the rail's height. */
  loading?: boolean;
  testID?: string;
};

const RAIL_GUTTER = 16;
const TILE_GAP = 8;
const SKELETON_TILE_RADIUS = 8;

export function TopTrendsRail({ caption, items, loading = false, testID }: TopTrendsRailProps) {
  const showSkeleton = loading && items.length === 0;
  if (!showSkeleton && items.length === 0) {
    return null;
  }

  return (
    <View testID={testID}>
      <AppText color="gray600" style={styles.caption} variant="captionMedium">
        {caption}
      </AppText>
      <ScrollView
        contentContainerStyle={styles.content}
        decelerationRate="fast"
        horizontal
        showsHorizontalScrollIndicator={false}
        snapToAlignment="start"
        snapToInterval={TOP_MOVER_TILE_WIDTH + TILE_GAP}
        testID={testID ? `${testID}-scroll` : undefined}
      >
        {showSkeleton
          ? [0, 1].map((index) => (
            <SkeletonBlock
              height={TOP_MOVER_TILE_HEIGHT}
              key={`skeleton-${index}`}
              radius={SKELETON_TILE_RADIUS}
              testID={testID ? `${testID}-skeleton-${index}` : undefined}
              width={TOP_MOVER_TILE_WIDTH}
            />
          ))
          : items.map(({ key, ...tile }) => (
            <TopMoverTile key={key} {...tile} testID={tile.testID ?? (testID ? `${testID}-${key}` : undefined)} />
          ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  caption: {
    paddingHorizontal: RAIL_GUTTER,
    marginBottom: 8,
  },
  content: {
    paddingHorizontal: RAIL_GUTTER,
    gap: TILE_GAP,
    flexDirection: 'row',
  },
});
