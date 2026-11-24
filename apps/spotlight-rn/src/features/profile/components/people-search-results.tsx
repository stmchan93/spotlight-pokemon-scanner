import { useCallback, useMemo, type ComponentProps } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { InventoryCardEntry } from '@spotlight/api-client';
import { StateCard, layout, spacing } from '@spotlight/design-system';

import type { UserProfile } from '@/features/auth/auth-models';
import { PersonSearchCard } from '@/features/profile/components/person-search-card';
import { useFollowPeople, type PeopleRelation } from '@/features/profile/hooks/use-follow-people';
import { usePeopleSearch } from '@/features/profile/hooks/use-people-search';
import { useProfilesTopHoldings } from '@/features/profile/hooks/use-profiles-top-holdings';
import { AnalyticsEvent } from '@/lib/observability/analytics-events';
import { capturePostHogEvent } from '@/lib/observability/posthog';

type PeopleSearchResultsProps = {
  query: string;
  viewerId: string | null;
  /** False until the PEOPLE tab is first shown: no suggestions read before then. */
  enabled: boolean;
  /**
   * The ALL / FOLLOWERS / FOLLOWING chip (Figma 6725:9757). `all` (default) is
   * the people search; the others list the viewer's own follow lists, narrowed
   * by the query on device.
   */
  relation?: PeopleRelation;
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
  relation = 'all',
  onOpenProfile,
  onOpenHolding,
  scrollProps,
  bottomInset,
  testID = 'search-people',
}: PeopleSearchResultsProps) {
  const insets = useSafeAreaInsets();
  const isAll = relation === 'all';
  const people = usePeopleSearch(query, { enabled: enabled && isAll, viewerId });
  const follows = useFollowPeople(relation, query, { enabled, viewerId });
  const list = isAll ? (people.isSearching ? people.results : people.suggestions) : follows.profiles;
  const userIds = useMemo(() => list.map((profile) => profile.userID), [list]);
  const holdings = useProfilesTopHoldings(enabled ? userIds : []);
  const source = isAll ? (people.isSearching ? 'search' : 'suggested') : relation;

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
    if (!isAll) {
      const noun = relation === 'followers' ? 'followers' : 'people you follow';
      return (
        <StateCard
          loading={follows.isLoading}
          message={
            follows.isLoading
              ? 'Loading collectors.'
              : follows.trimmedQuery
                ? `None of your ${noun} match “${follows.trimmedQuery}”.`
                : relation === 'followers'
                  ? 'No one follows you yet.'
                  : 'You are not following anyone yet.'
          }
          style={styles.stateCard}
          testID={follows.isLoading ? `${testID}-${relation}-loading` : `${testID}-${relation}-empty`}
          title={follows.isLoading ? 'Loading' : follows.trimmedQuery ? 'No matches' : 'Nobody here yet'}
          variant="field"
        />
      );
    }
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
      // Figma 6725:9509: the first person sits 4 under the white search header.
      contentContainerStyle={{ paddingBottom: (bottomInset ?? insets.bottom) + spacing.lg, paddingTop: spacing.xxxs }}
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
