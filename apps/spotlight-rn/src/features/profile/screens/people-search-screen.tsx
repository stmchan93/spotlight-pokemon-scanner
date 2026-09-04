import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { CheckCircle } from 'iconoir-react-native';

import { Avatar, SearchField, StateCard, Text, useSpotlightTheme } from '@spotlight/design-system';

import { ChromeBackButton } from '@/components/chrome-back-button';
import type { UserProfile } from '@/features/auth/auth-models';
import { searchUsers } from '@/features/profile/profile-service';
import {
  getProfileDisplayName,
  getProfileInitials,
} from '@/features/profile/screens/public-profile-screen';

const SEARCH_DEBOUNCE_MS = 250;

/**
 * People search — the profile top bar's magnifier. Searches USERS (handle or
 * display name, prefix-style, via `searchUsers` / public_profiles), not the
 * card catalog: card search already lives on Home's bar and the scanner. Rows
 * route to the person's public profile. Same debounce + stale-response token
 * discipline as the DM inbox's people search.
 */
export function PeopleSearchScreen({ testID = 'people-search' }: { testID?: string }) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<UserProfile[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const searchTokenRef = useRef(0);

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
        }
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [isSearching, trimmedQuery]);

  const handlePressRow = useCallback(
    (profile: UserProfile) => {
      const handle = profile.handle?.trim();
      router.push({
        pathname: '/u/[handle]',
        params: {
          handle: handle && handle.length > 0 ? handle : profile.userID,
          userId: profile.userID,
        },
      });
    },
    [router],
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
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
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
        data={results}
        keyboardShouldPersistTaps="handled"
        keyExtractor={(person) => person.userID}
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
