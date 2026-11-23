import { useCallback, useState, type RefObject } from 'react';
import { RefreshControl, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { InlineLoader, StateCard, spacing, useSpotlightTheme } from '@spotlight/design-system';

import {
  AnimatedFlatList,
  type CollapsiblePageProps,
  type CollapsibleScrollTarget,
} from '@/components/page-tab-pager';
import { SearchSetCard } from '@/features/catalog/components/search-set-card';
import { useMasterSetProgress } from '@/features/portfolio/hooks/use-master-set-progress';
import type { MasterSetRow } from '@/features/portfolio/master-set';

type MasterSetPageProps = {
  page: CollapsiblePageProps;
  /** Clears the floating bottom bar under the last card. */
  bottomPadding: number;
  /** False until the tab is first opened: nothing is read before that. */
  enabled: boolean;
  scrollRef?: RefObject<CollapsibleScrollTarget | null>;
  testID?: string;
};

/**
 * Home → MASTER SET (owner, 2026-11-22): your progress through every set you
 * own cards from, closest to finished first (see `compareMasterSetRows`). Each
 * row is the Search set card — logo, release date, the purple bar with its
 * percent, X of Y CARDS — and opens that set's page.
 */
export function MasterSetPage({
  page,
  bottomPadding,
  enabled,
  scrollRef,
  testID = 'portfolio-masterset-page',
}: MasterSetPageProps) {
  const theme = useSpotlightTheme();
  const router = useRouter();
  const { rows, status, reload } = useMasterSetProgress(enabled);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleRefresh = useCallback(() => {
    setIsRefreshing(true);
    reload();
  }, [reload]);
  // The spinner belongs to a pull, and a pull is over once the read settles.
  if (isRefreshing && status !== 'loading') {
    setIsRefreshing(false);
  }

  const openSet = useCallback((row: MasterSetRow) => {
    router.push({
      pathname: '/catalog/expansion/[expansionId]',
      params: {
        expansionId: row.expansion.id,
        // `set_id` is unique only WITHIN a game, so the game travels with it.
        game: row.game,
        name: row.expansion.name,
      },
    });
  }, [router]);

  const empty = rows === null ? (
    status === 'error' ? (
      <StateCard
        actionLabel="Retry"
        actionTestID={`${testID}-retry`}
        message="Check your connection and try again."
        onActionPress={reload}
        testID={`${testID}-error`}
        title="Could not load your sets"
        variant="field"
      />
    ) : (
      <InlineLoader label="Loading your sets" testID={`${testID}-loading`} />
    )
  ) : (
    <StateCard
      message="Add cards to your collection and each set you collect shows its progress here."
      testID={`${testID}-empty`}
      title="No sets yet"
      variant="field"
    />
  );

  return (
    <AnimatedFlatList
      ref={scrollRef as never}
      // Same inset behaviour as every other page of the Home pager: the chrome
      // padding is computed once for all of them.
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={[page.contentContainerStyle, { paddingBottom: bottomPadding }]}
      data={rows ?? []}
      ItemSeparatorComponent={Separator}
      keyExtractor={(row: MasterSetRow) => row.key}
      ListEmptyComponent={<View style={styles.empty}>{empty}</View>}
      ListHeaderComponent={<View style={styles.header} />}
      onScroll={page.onScroll}
      refreshControl={(
        <RefreshControl
          onRefresh={handleRefresh}
          progressViewOffset={page.progressViewOffset}
          refreshing={isRefreshing}
          testID={`${testID}-refresh`}
          tintColor={theme.colors.gray400}
        />
      )}
      renderItem={({ item }: { item: MasterSetRow }) => (
        <View style={{ paddingHorizontal: theme.layout.pageGutter }}>
          <SearchSetCard
            completion={item.completion}
            logoUrl={item.expansion.imageUrl}
            name={item.expansion.name}
            onPress={() => openSet(item)}
            releaseDate={item.expansion.releaseDate}
            setValue={item.expansion.setValue ?? null}
            testID={`${testID}-set-${item.key}`}
          />
        </View>
      )}
      scrollEventThrottle={page.scrollEventThrottle}
      scrollToOverflowEnabled={page.scrollToOverflowEnabled}
      testID={testID}
    />
  );
}

function Separator() {
  return <View style={styles.separator} />;
}

const styles = StyleSheet.create({
  // 24 between the tab rail and the first card, as on Collection.
  header: {
    height: spacing.lg,
  },
  empty: {
    paddingHorizontal: spacing.sm,
  },
  separator: {
    height: spacing.sm,
  },
});
