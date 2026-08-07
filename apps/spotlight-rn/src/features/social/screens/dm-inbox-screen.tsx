import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Avatar, StateCard, Text, useSpotlightTheme } from '@spotlight/design-system';

import { ChromeBackButton } from '@/components/chrome-back-button';
import { type DmConversation, fetchConversations } from '@/features/social/dm-service';

/** Anything past this reads as "a lot" — the badge is a signal, not a counter. */
const UNREAD_BADGE_MAX = 99;

/**
 * DM inbox. Reached from the Messages entry point and pushed as a ROOT route
 * (see `src/app/messages.tsx` for why it can't live under `(stack)`).
 *
 * Rows arrive already newest-first: `fetchConversations` orders on
 * `last_message_at` server-side, with never-written threads sorted last. Sorting
 * again here would only hide a data-layer regression, so the list renders the
 * service's order verbatim.
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

  useEffect(() => {
    void load();
  }, [load]);

  const handleRefresh = useCallback(() => {
    setIsRefreshing(true);
    void load().finally(() => setIsRefreshing(false));
  }, [load]);

  const renderItem = useCallback(
    ({ item }: { item: DmConversation }) => {
      const name = displayNameFor(item);
      // Null preview = a thread with no messages yet, or one whose last message
      // was moderation-removed. Both render as an empty line rather than a
      // placeholder, so the row keeps its height and nothing is invented.
      const preview = item.lastMessagePreview ?? '';
      const isUnread = item.unreadCount > 0;

      return (
        <Pressable
          accessibilityRole="button"
          onPress={() => {
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
              params: { conversationId: item.id, name },
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
          </View>

          <View style={styles.meta}>
            <Text style={[theme.typography.label, { color: theme.colors.gray600 }]}>
              {formatRelativeTime(item.lastMessageAt)}
            </Text>
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

      <FlatList
        contentContainerStyle={items.length === 0 ? styles.emptyContent : undefined}
        data={items}
        keyExtractor={(item) => item.id}
        ListEmptyComponent={
          isLoading ? null : (
            <StateCard
              message="Open a collector's profile and say hello to start a conversation."
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
  copy: {
    flex: 1,
    gap: 2,
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
