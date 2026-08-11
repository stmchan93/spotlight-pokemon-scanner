import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Avatar, SearchField, StateCard, Text, useSpotlightTheme } from '@spotlight/design-system';

import { ChromeBackButton } from '@/components/chrome-back-button';
import type { UserProfile } from '@/features/auth/auth-models';
import { type DmConversation, fetchConversations, findOrCreateDm } from '@/features/social/dm-service';
import { searchUsers } from '@/features/profile/profile-service';

/** Anything past this reads as "a lot" — the badge is a signal, not a counter. */
const UNREAD_BADGE_MAX = 99;

/**
 * Debounce before a keystroke becomes a query. `searchUsers` is a network read
 * per call, so typing "trogdor" unthrottled is seven requests for one intent.
 */
const SEARCH_DEBOUNCE_MS = 250;

/**
 * DM inbox. Reached from the Messages entry point and pushed as a ROOT route
 * (see `src/app/messages.tsx` for why it can't live under `(stack)`).
 *
 * Rows arrive already newest-first: `fetchConversations` orders on
 * `last_message_at` server-side, with never-written threads sorted last. Sorting
 * again here would only hide a data-layer regression, so the list renders the
 * service's order verbatim.
 *
 * BLOCKED THREADS ARE NOT MARKED OR HIDDEN HERE — a deliberate decision, not an
 * omission:
 *
 *   * Hiding them is wrong for the same reason `messages_select` is not
 *     block-gated (social_13): the history has to stay reachable so it can be
 *     reported, and a thread that disappears on block lets a harasser erase
 *     themselves from the victim's device by blocking first.
 *   * Marking them would need a per-row answer, and the only either-direction
 *     source is `conversation_has_block(conversation, user)` — one RPC PER ROW,
 *     the exact fan-out `unread_dm_counts` and `last_message_preview` exist to
 *     kill. Doing it in one round trip needs a set-returning RPC this schema does
 *     not have.
 *   * `fetchBlockedUserIds()` would answer for free, but only for blocks I
 *     created. A badge that appears when I blocked them and not when they blocked
 *     me is both a half-fix and a direction leak — it would tell someone they had
 *     been blocked by its own absence.
 *
 * The thread already stops demanding attention without any of that:
 * `unread_dm_counts()` excludes blocked conversations, so the badge sits at zero
 * and stays there, and the thread itself explains the silence when opened.
 */
export function DmInboxScreen({ testID = 'dm-inbox' }: { testID?: string }) {
  const theme = useSpotlightTheme();
  const router = useRouter();

  const [items, setItems] = useState<DmConversation[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Guards against a slow first load landing after a pull-to-refresh and
  // overwriting the newer page.
  const loadTokenRef = useRef(0);

  /**
   * ONE request draws the whole screen.
   *
   * `DmConversation.lastMessagePreview` is denormalized onto `conversations` by
   * the trigger that already stamps `last_message_at` (social_13), so the preview
   * text arrives with the row. This deliberately replaced a second pass that
   * called `fetchMessages(id, 1)` per row — a request per thread to draw one line
   * of text each. Do not reintroduce that fan-out here: if a row needs more data,
   * denormalize it onto the conversation the same way.
   */
  const load = useCallback(async () => {
    const token = ++loadTokenRef.current;

    const rows = await fetchConversations();
    if (token !== loadTokenRef.current) {
      return;
    }
    setItems(rows);
    setIsLoading(false);
  }, []);

  /*
    ON FOCUS, not on mount.

    Opening a thread marks it read (`markConversationRead`), but that writes to
    the SERVER — this screen held whatever counts it fetched when it first
    mounted, so coming back still showed the old badge. A message you had just
    read lingered as a new one until the app was restarted or pulled to refresh.

    `useFocusEffect` also covers the first mount, so it replaces the mount
    effect rather than adding to it.
  */
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const handleRefresh = useCallback(() => {
    setIsRefreshing(true);
    void load().finally(() => setIsRefreshing(false));
  }, [load]);

  // ---------------------------------------------------------------------------
  // Search for someone to message
  // ---------------------------------------------------------------------------
  // Without this, starting a NEW conversation meant leaving the inbox entirely:
  // Collection → search bubble → People tab → their profile → Message. The inbox
  // is where you go to message someone, so the people search belongs here too.
  //
  // `searchUsers` matches handle OR display_name, prefix-style, against
  // `public_profiles` — the same query the catalog People tab issues.
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<UserProfile[]>([]);
  const [isOpening, setIsOpening] = useState(false);
  // Monotonic token: a slow response for "tro" must not overwrite the newer
  // results for "trogdor". Same guard as `loadTokenRef` above.
  const searchTokenRef = useRef(0);
  // Synchronous, unlike state — two taps in the same tick would both read a
  // stale `false` and open two threads.
  const openingRef = useRef(false);

  const trimmedQuery = query.trim();
  const isSearching = trimmedQuery.length > 0;

  useEffect(() => {
    if (!isSearching) {
      setResults([]);
      return;
    }
    const token = ++searchTokenRef.current;
    const timer = setTimeout(() => {
      void searchUsers(trimmedQuery).then((rows) => {
        if (token === searchTokenRef.current) {
          setResults(rows);
        }
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [isSearching, trimmedQuery]);

  const openThreadWith = useCallback(
    (person: UserProfile) => {
      if (openingRef.current) {
        return;
      }
      openingRef.current = true;
      setIsOpening(true);
      void findOrCreateDm(person.userID)
        .then((conversationId) => {
          if (!conversationId) {
            // Never navigate to /messages/null. Leaving the search open with the
            // query intact is the recoverable state.
            return;
          }
          setQuery('');
          router.push({
            pathname: '/messages/[conversationId]',
            params: {
              conversationId,
              name: person.displayName ?? person.handle ?? '',
              // Carried so the thread header can show — and link to — the
              // person you are talking to. The inbox already has all of it.
              avatar: person.avatarURL ?? '',
              handle: person.handle ?? '',
              userId: person.userID ?? '',
            },
          } as never);
        })
        .finally(() => {
          openingRef.current = false;
          setIsOpening(false);
        });
    },
    [router],
  );

  const renderItem = useCallback(
    ({ item }: { item: DmConversation }) => {
      const name = displayNameFor(item);
      // Null preview = a thread with no messages yet, or one whose last message
      // was moderation-removed. Neither invents a placeholder; the line is
      // simply not rendered, so the row collapses to one line and centres on the
      // avatar (see the render below).
      const preview = item.lastMessagePreview ?? '';
      const isUnread = item.unreadCount > 0;
      const relativeTime = formatRelativeTime(item.lastMessageAt);

      return (
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            setItems((current) =>
              current.map((row) => (row.id === item.id ? { ...row, unreadCount: 0 } : row)),
            );
            // Zero it locally the moment you open the thread. The focus refetch
            // above is the source of truth, but it only lands after you come
            // BACK — without this the badge is still sitting there during the
            // navigation, which is the thing that read as "it didn't clear".

            // The thread screen has no way to look up who it is talking to —
            // there is no fetch-one-conversation read, and running the whole
            // inbox query again just to title a header would cost a request per
            // thread. The name we already resolved rides along as a param.
            // The `as never` is the same escape hatch `notifications-screen`
            // uses: expo-router's typed-route union lives in the GITIGNORED,
            // generated `.expo/types/router.d.ts`, which only regenerates when
            // the dev server runs — so a route added since the last generation
            // isn't in the union and `tsc --noEmit` rejects it. The cast keeps
            // typecheck honest about everything except the freshness of a
            // generated file. Drop it once the map has been regenerated.
            router.push({
              pathname: '/messages/[conversationId]',
              params: {
                conversationId: item.id,
                name,
                avatar: item.otherUser?.avatarUrl ?? '',
                handle: item.otherUser?.handle ?? '',
                userId: item.otherUserId ?? '',
              },
            } as never);
          }}
          style={({ pressed }) => [
            styles.row,
            {
              backgroundColor: pressed ? theme.colors.gray50 : theme.colors.gray0,
              borderBottomColor: theme.colors.gray200,
            },
          ]}
          testID={`${testID}-row-${item.id}`}
        >
          <Avatar
            initials={(name[0] ?? '?').toUpperCase()}
            size={40}
            uri={item.otherUser?.avatarUrl ?? undefined}
          />

          <View style={styles.copy}>
            <Text
              numberOfLines={1}
              style={[theme.typography.bodyMedium, { color: theme.colors.gray900 }]}
            >
              {name}
            </Text>
            {/*
              Only rendered when there IS a preview. An empty string still
              occupies a full line, which pushed the name above the avatar's
              centre and left dead space beneath it — a never-messaged thread
              looked misaligned while search results (usually one line) looked
              right. Dropping the empty line lets a single-line row centre on the
              avatar exactly the way the search rows do.
            */}
            {preview ? (
              <Text
                numberOfLines={1}
                style={[
                  theme.typography.label,
                  // An unread thread's preview reads at full strength; a read one
                  // recedes. Same row, two weights of attention.
                  { color: isUnread ? theme.colors.gray800 : theme.colors.gray600 },
                ]}
                testID={`${testID}-preview-${item.id}`}
              >
                {preview}
              </Text>
            ) : null}
          </View>

          <View style={styles.meta}>
            {/*
              Only when there IS a time — same reason the preview above is
              conditional. `formatRelativeTime` returns '' for a null or
              unparseable timestamp, and an empty Text still occupies a full
              line, which pushed the unread badge to the BOTTOM of the row
              instead of centring it against the name.
            */}
            {relativeTime ? (
              <Text style={[theme.typography.label, { color: theme.colors.gray600 }]}>
                {relativeTime}
              </Text>
            ) : null}
            {isUnread ? (
              <View
                style={[
                  styles.unreadBadge,
                  { backgroundColor: theme.colors.purple500, borderRadius: theme.radii.pill },
                ]}
                testID={`${testID}-unread-${item.id}`}
              >
                <Text style={[theme.typography.micro, { color: theme.colors.gray0 }]}>
                  {item.unreadCount > UNREAD_BADGE_MAX ? `${UNREAD_BADGE_MAX}+` : item.unreadCount}
                </Text>
              </View>
            ) : null}
          </View>
        </Pressable>
      );
    },
    [router, testID, theme],
  );

  return (
    <SafeAreaView
      edges={['top', 'left', 'right']}
      style={[styles.safeArea, { backgroundColor: theme.colors.gray0 }]}
      testID={testID}
    >
      <View style={styles.header}>
        <ChromeBackButton onPress={() => router.back()} testID={`${testID}-back`} />
        <Text style={[theme.typography.titleXsmall, styles.title]}>Messages</Text>
        <View style={styles.headerSpacer} />
      </View>

      <View style={styles.searchRow}>
        <SearchField
          autoCapitalize="none"
          autoCorrect={false}
          containerTestID={`${testID}-search`}
          onChangeText={setQuery}
          placeholder="Search collectors"
          returnKeyType="search"
          size="collection"
          surface="muted"
          value={query}
        />
      </View>

      {isSearching ? (
        // While searching, people REPLACE the thread list rather than sitting
        // above it. Two stacked lists of avatars — one of threads, one of
        // strangers — makes it ambiguous which one a tap continues versus starts.
        <FlatList
          contentContainerStyle={results.length === 0 ? styles.emptyContent : undefined}
          data={results}
          keyExtractor={(person) => person.userID}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={
            <StateCard
              message="No collectors match that name or @handle."
              testID={`${testID}-search-empty`}
              title="No one found"
              variant="field"
            />
          }
          renderItem={({ item }) => (
            <Pressable
              accessibilityRole="button"
              disabled={isOpening}
              onPress={() => openThreadWith(item)}
              style={({ pressed }) => [
                styles.row,
                { borderBottomColor: theme.colors.gray200 },
                pressed ? { backgroundColor: theme.colors.gray50 } : null,
              ]}
              testID={`${testID}-person-${item.userID}`}
            >
              <Avatar
                initials={(item.displayName ?? item.handle ?? '?').charAt(0).toUpperCase()}
                size={40}
                uri={item.avatarURL ?? undefined}
              />
              <View style={styles.copy}>
                {/*
                  numberOfLines is what keeps this row vertically centred. Without
                  it a long display name wraps, the copy column grows past the 40pt
                  avatar, and the name's first line lands above the avatar's middle
                  — the row reads as top-aligned even though the container centres.
                */}
                <Text
                  numberOfLines={1}
                  style={[theme.typography.bodyMedium, { color: theme.colors.gray900 }]}
                >
                  {item.displayName ?? item.handle ?? 'Collector'}
                </Text>
                {item.handle ? (
                  <Text
                    numberOfLines={1}
                    style={[theme.typography.label, { color: theme.colors.gray600 }]}
                  >
                    @{item.handle}
                  </Text>
                ) : null}
              </View>
            </Pressable>
          )}
          testID={`${testID}-search-results`}
        />
      ) : (
        <FlatList
          contentContainerStyle={items.length === 0 ? styles.emptyContent : undefined}
          data={items}
          keyExtractor={(item) => item.id}
          ListEmptyComponent={
            isLoading ? null : (
              <StateCard
                message="Search for a collector above to start a conversation."
                testID={`${testID}-empty`}
                title="No messages yet"
                variant="field"
              />
            )
          }
          refreshControl={<RefreshControl onRefresh={handleRefresh} refreshing={isRefreshing} />}
          renderItem={renderItem}
          testID={`${testID}-list`}
        />
      )}
    </SafeAreaView>
  );
}

/**
 * Who the thread is with. `otherUser` is null whenever the other participant
 * isn't publicly visible (blocked/suspended/hidden) or the thread is a group, and
 * a blank row is worse than a generic one — you still need to be able to find and
 * open it.
 */
function displayNameFor(conversation: DmConversation): string {
  const user = conversation.otherUser;
  return user?.displayName?.trim() || user?.handle?.trim() || 'Someone';
}

/** Compact relative time — "now", "3m", "5h", "2d", then a date. */
function formatRelativeTime(iso: string | null): string {
  if (!iso) {
    return '';
  }
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return '';
  }
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) {
    return 'now';
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m`;
  }
  if (seconds < 86400) {
    return `${Math.floor(seconds / 3600)}h`;
  }
  if (seconds < 604800) {
    return `${Math.floor(seconds / 86400)}d`;
  }
  return new Date(then).toLocaleDateString();
}

const styles = StyleSheet.create({
  // Same 16pt gutter as the rows below it, so the field lines up with the
  // avatars rather than floating on its own inset.
  searchRow: {
    paddingBottom: 8,
    paddingHorizontal: 16,
  },
  copy: {
    flex: 1,
    gap: 2,
    // Yoga won't shrink a flex child below its intrinsic content width unless
    // minWidth is 0, so without this a long name pushes the timestamp column off
    // the row instead of truncating. Same fix follow-list-screen already carries.
    minWidth: 0,
  },
  emptyContent: {
    padding: 16,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  // Mirrors the back button's width so the title centres on the screen rather
  // than on the space left beside it.
  headerSpacer: {
    width: 36,
  },
  meta: {
    alignItems: 'flex-end',
    gap: 4,
  },
  row: {
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  safeArea: {
    flex: 1,
  },
  title: {
    flex: 1,
    textAlign: 'center',
  },
  unreadBadge: {
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 20,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
});
