import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View, type TextInput } from 'react-native';
import { useNavigation, useRouter } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { CheckCircle } from 'iconoir-react-native';

import { Avatar, SearchField, StateCard, Text, useSpotlightTheme } from '@spotlight/design-system';

import { ChromeBackButton } from '@/components/chrome-back-button';
import type { UserProfile } from '@/features/auth/auth-models';
import { fetchSuggestedUsers, searchUsers } from '@/features/profile/profile-service';
import { AnalyticsEvent } from '@/lib/observability/analytics-events';
import { capturePostHogEvent } from '@/lib/observability/posthog';
import { useAuth } from '@/providers/auth-provider';
import {
  getProfileDisplayName,
  getProfileInitials,
} from '@/features/profile/screens/public-profile-screen';

const SEARCH_DEBOUNCE_MS = 250;

/**
 * People search — the profile top bar's magnifier. Searches USERS (handle or
 * display name, matched anywhere, via `searchUsers` / public_profiles), not the
 * card catalog: card search already lives on Home's bar and the scanner. Rows
 * route to the person's public profile. Same debounce + stale-response token
 * discipline as the DM inbox's people search. Before anything is typed it
 * lists popular collectors, so the screen is never a blank box.
 */
export function PeopleSearchScreen({ testID = 'people-search' }: { testID?: string }) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const auth = useAuth();
  const viewerId = auth.currentUser?.id ?? null;

  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<UserProfile[]>([]);
  const [results, setResults] = useState<UserProfile[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const searchTokenRef = useRef(0);

  /*
    Focus AFTER the push transition, not `autoFocus`: an autofocused input
    starts presenting the keyboard at mount — mid push animation — and the two
    native animations fight (keyboard begins, is interrupted as the screen
    attaches, presents again). That read as the keyboard opening twice and the
    screen "opening two pages". `transitionEnd` fires once the native stack has
    settled; the once-flag keeps the keyboard from re-popping when a profile
    row pops back to this screen.
  */
  const navigation = useNavigation();
  const searchFieldRef = useRef<TextInput>(null);
  const didAutoFocusRef = useRef(false);
  useEffect(() => {
    const unsubscribe = navigation.addListener('transitionEnd' as never, () => {
      if (!didAutoFocusRef.current) {
        didAutoFocusRef.current = true;
        searchFieldRef.current?.focus();
      }
    });
    return unsubscribe;
  }, [navigation]);

  useEffect(() => {
    let cancelled = false;
    void fetchSuggestedUsers(viewerId).then((rows) => {
      if (!cancelled) {
        setSuggestions(rows);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [viewerId]);

  const trimmedQuery = query.trim();
  const isSearching = trimmedQuery.length > 0;

  useEffect(() => {
    if (!isSearching) {
      setResults([]);
      setIsLoading(false);
      return;
    }
    const token = ++searchTokenRef.current;
    setIsLoading(true);
    const timer = setTimeout(() => {
      void searchUsers(trimmedQuery).then((rows) => {
        if (token === searchTokenRef.current) {
          setResults(rows);
          setIsLoading(false);
          // Once per settled query; the text itself never leaves the device.
          capturePostHogEvent(AnalyticsEvent.peopleSearchPerformed, {
            query_length: trimmedQuery.length,
            result_count: rows.length,
          });
        }
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [isSearching, trimmedQuery]);

  const handlePressRow = useCallback(
    (profile: UserProfile) => {
      capturePostHogEvent(AnalyticsEvent.peopleProfileOpened, {
        source: isSearching ? 'search' : 'suggested',
      });
      const handle = profile.handle?.trim();
      router.push({
        pathname: '/u/[handle]',
        params: {
          handle: handle && handle.length > 0 ? handle : profile.userID,
          userId: profile.userID,
        },
      });
    },
    [isSearching, router],
  );

  const renderItem = useCallback(
    ({ item }: { item: UserProfile }) => {
      const displayName = getProfileDisplayName(item);
      const handle = item.handle?.trim();
      return (
        <Pressable
          accessibilityRole="button"
          onPress={() => handlePressRow(item)}
          style={({ pressed }) => [styles.row, pressed ? styles.rowPressed : null]}
          testID={`${testID}-row-${item.userID}`}
        >
          <Avatar
            initials={getProfileInitials(item.displayName)}
            size={40}
            uri={item.avatarURL}
          />
          <View style={styles.rowCopy}>
            <View style={styles.nameRow}>
              <Text numberOfLines={1} style={[theme.typography.bodyMedium, styles.nameText]}>
                {displayName}
              </Text>
              {item.isVerified ? (
                <CheckCircle color={theme.colors.purple500} height={16} width={16} />
              ) : null}
            </View>
            {handle ? (
              <Text
                numberOfLines={1}
                style={[theme.typography.label, { color: theme.colors.gray600 }]}
              >
                @{handle}
              </Text>
            ) : null}
          </View>
        </Pressable>
      );
    },
    [handlePressRow, testID, theme],
  );

  return (
    <SafeAreaView
      edges={['top', 'left', 'right']}
      style={[styles.safeArea, { backgroundColor: theme.colors.gray0 }]}
      testID={testID}
    >
      <View style={styles.header}>
        <ChromeBackButton onPress={() => router.back()} testID={`${testID}-back`} />
        <Text style={[theme.typography.titleXsmall, styles.title]}>Find People</Text>
        <View style={styles.headerSpacer} />
      </View>
      <View style={[styles.searchRow, { paddingHorizontal: theme.layout.pageGutter }]}>
        <SearchField
          ref={searchFieldRef}
          autoCapitalize="none"
          autoCorrect={false}
          containerTestID={`${testID}-field`}
          onChangeText={setQuery}
          placeholder="Search collectors"
          returnKeyType="search"
          size="collection"
          surface="muted"
          value={query}
        />
      </View>
      <FlatList
        contentContainerStyle={{
          paddingBottom: insets.bottom + 24,
          paddingHorizontal: theme.layout.pageGutter,
        }}
        data={isSearching ? results : suggestions}
        keyboardShouldPersistTaps="handled"
        keyExtractor={(person) => person.userID}
        ListHeaderComponent={
          !isSearching && suggestions.length > 0 ? (
            <Text
              accessibilityRole="header"
              style={[theme.typography.titleXsmall, styles.sectionTitle]}
              testID={`${testID}-suggested-title`}
            >
              Popular collectors
            </Text>
          ) : null
        }
        ListEmptyComponent={
          isSearching ? (
            <StateCard
              loading={isLoading}
              message={isLoading ? 'Searching collectors.' : `No collectors match “${trimmedQuery}”.`}
              style={styles.stateCard}
              testID={isLoading ? `${testID}-loading` : `${testID}-empty`}
              title={isLoading ? 'Searching' : 'No matches'}
              variant="field"
            />
          ) : null
        }
        renderItem={renderItem}
        testID={`${testID}-list`}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  sectionTitle: {
    paddingBottom: 4,
    paddingTop: 12,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  headerSpacer: {
    width: 40,
  },
  nameRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
  },
  nameText: {
    flexShrink: 1,
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    paddingVertical: 8,
  },
  rowCopy: {
    flex: 1,
  },
  rowPressed: {
    opacity: 0.7,
  },
  safeArea: {
    flex: 1,
  },
  searchRow: {
    paddingBottom: 8,
  },
  stateCard: {
    marginTop: 24,
  },
  title: {
    flex: 1,
    textAlign: 'center',
  },
});
