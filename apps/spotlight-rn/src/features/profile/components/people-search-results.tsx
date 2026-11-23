import { useCallback, useMemo, type ComponentProps } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { InventoryCardEntry } from '@spotlight/api-client';
import { StateCard, layout, spacing } from '@spotlight/design-system';

import type { UserProfile } from '@/features/auth/auth-models';
import { PersonSearchCard } from '@/features/profile/components/person-search-card';
import { usePeopleSearch } from '@/features/profile/hooks/use-people-search';
import { useProfilesTopHoldings } from '@/features/profile/hooks/use-profiles-top-holdings';
import { AnalyticsEvent } from '@/lib/observability/analytics-events';
import { capturePostHogEvent } from '@/lib/observability/posthog';

type PeopleSearchResultsProps = {
  query: string;
  viewerId: string | null;
  /** False until the PEOPLE tab is first shown: no suggestions read before then. */
  enabled: boolean;
  onOpenProfile: (profile: UserProfile) => void;
  onOpenHolding: (profile: UserProfile, entry: InventoryCardEntry) => void;
  /** Extra FlatList props (the screen's pull-down-to-dismiss scroll handlers). */
  scrollProps?: Partial<ComponentProps<typeof FlatList<UserProfile>>>;
  bottomInset?: number;
  testID?: string;
};

/**
 * Search's PEOPLE tab body (Figma 6642:14400): collectors only, never cards.
 * Before anything is typed it lists popular collectors; a query searches
 * handles and names. Each card's rail of most valuable holdings is read for
 * the whole visible list in one batched request.
 */
export function PeopleSearchResults({
  query,
  viewerId,
  enabled,
  onOpenProfile,
  onOpenHolding,
  scrollProps,
  bottomInset,
  testID = 'search-people',
}: PeopleSearchResultsProps) {
  const insets = useSafeAreaInsets();
  const people = usePeopleSearch(query, { enabled, viewerId });
  const list = people.isSearching ? people.results : people.suggestions;
  const userIds = useMemo(() => list.map((profile) => profile.userID), [list]);
  const holdings = useProfilesTopHoldings(enabled ? userIds : []);
  const source = people.isSearching ? 'search' : 'suggested';

  const openProfile = useCallback(
    (profile: UserProfile) => {
      capturePostHogEvent(AnalyticsEvent.peopleProfileOpened, { source });
      onOpenProfile(profile);
    },
    [onOpenProfile, source],
  );

  const renderItem = useCallback(
    ({ item }: { item: UserProfile }) => (
      <PersonSearchCard
        holdings={holdings[item.userID]}
        onPressHolding={onOpenHolding}
        onPressProfile={openProfile}
        profile={item}
        testID={`${testID}-person-${item.userID}`}
      />
    ),
    [holdings, onOpenHolding, openProfile, testID],
  );

  const emptyState = () => {
    if (people.isSearching) {
      return (
        <StateCard
          loading={people.isLoading}
          message={people.isLoading ? 'Searching collectors.' : `No collectors match “${people.trimmedQuery}”.`}
          style={styles.stateCard}
          testID={people.isLoading ? `${testID}-loading` : `${testID}-empty`}
          title={people.isLoading ? 'Searching' : 'No matches'}
          variant="field"
        />
      );
    }
    if (people.suggestionsStatus === 'loading') {
      return (
        <StateCard
          loading
          message="Finding collectors to follow."
          style={styles.stateCard}
          testID={`${testID}-suggested-loading`}
          title="Loading"
          variant="field"
        />
      );
    }
    if (people.suggestionsStatus === 'failed') {
      return (
        <StateCard
          actionLabel="Try again"
          actionTestID={`${testID}-suggested-retry`}
          actionVariant="secondary"
          message="Could not load collectors. You can still search by name or @handle."
          onActionPress={people.retrySuggestions}
          style={styles.stateCard}
          testID={`${testID}-suggested-error`}
          title="Something went wrong"
          variant="field"
        />
      );
    }
    return (
      <StateCard
        message="Search by name or @handle to find collectors."
        style={styles.stateCard}
        testID={`${testID}-suggested-empty`}
        title="Find collectors"
        variant="field"
      />
    );
  };

  return (
    <FlatList
      {...scrollProps}
      contentContainerStyle={{ paddingBottom: (bottomInset ?? insets.bottom) + spacing.lg }}
      data={list}
      ItemSeparatorComponent={Separator}
      keyboardShouldPersistTaps="handled"
      keyExtractor={(profile) => profile.userID}
      ListEmptyComponent={<View style={styles.emptyWrap}>{emptyState()}</View>}
      renderItem={renderItem}
      showsVerticalScrollIndicator={false}
      style={styles.list}
      testID={testID}
    />
  );
}

// Figma 6642:14443: people sit 4 apart on the gray-50 page.
function Separator() {
  return <View style={styles.separator} />;
}

const styles = StyleSheet.create({
  emptyWrap: {
    paddingHorizontal: layout.pageGutter,
  },
  list: {
    flex: 1,
  },
  separator: {
    height: spacing.xxxs,
  },
  stateCard: {
    marginTop: spacing.lg,
  },
});
