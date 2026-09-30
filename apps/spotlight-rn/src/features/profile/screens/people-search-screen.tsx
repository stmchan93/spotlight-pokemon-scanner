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
// Longer than any native push (~350ms iOS / Android) on a slow device.
const AUTOFOCUS_FALLBACK_MS = 1000;

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
    Focus AFTER the push transition, not `autoFocus`: an input focused mid push
    starts presenting the keyboard while the screen is still sliding in, UIKit
    interrupts it as the screen attaches, and it presents again — the keyboard
    reads as "up, down, up".

    WHICH navigator's `transitionEnd` matters: pushed from the tabs, this route
    mounts the `(stack)` group with itself as that stack's ONLY screen. The
    slide the user sees is the ROOT stack pushing the group; the inner stack
    never animates, and its bottom-most screen reports "appeared" as soon as the
    nested navigation controller attaches (react-native-screens adds it to the
    parent only once it reaches the window — i.e. at the START of the parent's
    push). Listening on our own navigation therefore focused mid-slide, which is
    the bounce. When we are the stack's first screen, listen on the parent's.

    Once-only, opening transitions only: `transitionEnd` also fires with
    `closing: true` when a profile row pushes over this screen, and coming back
    from that profile must not re-pop the keyboard.
  */
  const navigation = useNavigation();
  const searchFieldRef = useRef<TextInput>(null);
  const didAutoFocusRef = useRef(false);
  useEffect(() => {
    const focusOnce = () => {
      if (!didAutoFocusRef.current) {
        didAutoFocusRef.current = true;
        searchFieldRef.current?.focus();
      }
    };
    const isStackRoot = (navigation.getState?.()?.routes.length ?? 1) <= 1;
    const transitionOwner = (isStackRoot ? navigation.getParent?.() : null) ?? navigation;
    const unsubscribe = transitionOwner.addListener('transitionEnd' as never, ((event: {
      data?: { closing?: boolean };
    }) => {
      if (!event?.data?.closing) {
        focusOnce();
      }
    }) as never);
    // Safety net only: if no opening transition is ever reported (a route
    // shape we didn't anticipate), still bring the keyboard up — well after
    // any push animation has finished, so it cannot reintroduce the bounce.
    // Skipped if a row already pushed a profile over this screen.
    const fallback = setTimeout(() => {
      if (navigation.isFocused?.() !== false) {
        focusOnce();
      }
    }, AUTOFOCUS_FALLBACK_MS);
    return () => {
      clearTimeout(fallback);
      unsubscribe();
    };
  }, [navigation]);

  const [suggestionsStatus, setSuggestionsStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [suggestionsAttempt, setSuggestionsAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setSuggestionsStatus('loading');
    void fetchSuggestedUsers(viewerId).then(({ failed, profiles }) => {
      if (!cancelled) {
        setSuggestions(profiles);
        setSuggestionsStatus(failed ? 'failed' : 'ready');
      }
    });
    return () => {
      cancelled = true;
    };
  }, [viewerId, suggestionsAttempt]);
  const retrySuggestions = useCallback(() => setSuggestionsAttempt((attempt) => attempt + 1), []);

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
          ) : suggestionsStatus === 'loading' ? (
            <StateCard
              loading
              message="Finding collectors to follow."
              style={styles.stateCard}
              testID={`${testID}-suggested-loading`}
              title="Loading"
              variant="field"
            />
          ) : suggestionsStatus === 'failed' ? (
            <StateCard
              actionLabel="Try again"
              actionTestID={`${testID}-suggested-retry`}
              actionVariant="secondary"
              message="Could not load collectors. You can still search by name or @handle."
              onActionPress={retrySuggestions}
              style={styles.stateCard}
              testID={`${testID}-suggested-error`}
              title="Something went wrong"
              variant="field"
            />
          ) : (
            <StateCard
              message="Search by name or @handle to find collectors."
              style={styles.stateCard}
              testID={`${testID}-suggested-empty`}
              title="Find collectors"
              variant="field"
            />
          )
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
