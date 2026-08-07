import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Avatar, StateCard, Text, useSpotlightTheme } from '@spotlight/design-system';

import { ChromeBackButton } from '@/components/chrome-back-button';
import {
  fetchNotifications,
  markAllNotificationsRead,
  type AppNotification,
} from '@/features/social/social-service';

/**
 * Notification list. Reached from the bell on the Collection header.
 *
 * Marks everything read on open rather than per-row: the badge exists to say
 * "something happened since you last looked", and opening the list answers that.
 * Per-row read state would need a tap target on every row for no added meaning.
 *
 * The mark-read call is fire-and-forget and runs AFTER the rows are in state, so
 * a failed update can't stop the list rendering — worst case the badge is stale
 * until the next poll. `readAt` is captured from the fetched rows before the
 * update lands, so the unread highlight still shows what was new this visit.
 */
export function NotificationsScreen({ testID = 'notifications' }: { testID?: string }) {
  const theme = useSpotlightTheme();
  const router = useRouter();

  const [items, setItems] = useState<AppNotification[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const load = useCallback(async () => {
    const rows = await fetchNotifications();
    setItems(rows);
    setIsLoading(false);
    void markAllNotificationsRead();
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleRefresh = useCallback(() => {
    setIsRefreshing(true);
    void load().finally(() => setIsRefreshing(false));
  }, [load]);

  /**
   * Where a row leads, or null when it leads nowhere.
   *
   * Only follows are navigable today. A like/comment notification wants to open
   * the post it refers to, and THERE IS NO PER-POST ROUTE — `/feed` renders the
   * following feed with no way to target a post id. Rather than push a route
   * that doesn't exist or dump the user in a generic feed, those rows render
   * non-interactive until a `/post/[postId]` screen exists; `openTarget` is what
   * to wire up when it does.
   */
  const openTarget = useCallback(
    (item: AppNotification): (() => void) | null => {
      if (item.type === 'follow') {
        // A handle-less actor has no public profile URL, so there is nothing to
        // open — treat it the same as no destination.
        const handle = item.actor?.handle;
        return handle ? () => router.push(`/u/${handle}` as never) : null;
      }
      return null;
    },
    [router],
  );

  const renderItem = useCallback(
    ({ item }: { item: AppNotification }) => {
      const name = item.actor?.displayName ?? item.actor?.handle ?? 'Someone';
      const action =
        item.type === 'follow'
          ? 'started following you'
          : item.type === 'like'
            ? item.commentId
              ? 'liked your comment'
              : 'liked your post'
            : item.commentId
              ? 'replied to you'
              : 'commented on your post';

      const onPress = openTarget(item);
      const baseStyle = [
        styles.row,
        {
          backgroundColor: item.readAt ? theme.colors.gray0 : theme.colors.purple50,
          borderBottomColor: theme.colors.gray200,
        },
      ];

      // A row with no destination renders as a plain View, not a dead Pressable:
      // no button role for screen readers, no press feedback promising something
      // will happen. See `openTarget` for why post rows have no destination yet.
      const Row = ({ children }: { children: React.ReactNode }) =>
        onPress ? (
          <Pressable
            accessibilityRole="button"
            onPress={onPress}
            style={({ pressed }) => [
              ...baseStyle,
              pressed ? { backgroundColor: theme.colors.gray50 } : null,
            ]}
            testID={`${testID}-row-${item.id}`}
          >
            {children}
          </Pressable>
        ) : (
          <View style={baseStyle} testID={`${testID}-row-${item.id}`}>
            {children}
          </View>
        );

      return (
        <Row>
          <Avatar
            initials={(name[0] ?? '?').toUpperCase()}
            size={40}
            uri={item.actor?.avatarUrl ?? undefined}
          />
          <View style={styles.copy}>
            <Text style={[theme.typography.bodyMedium, { color: theme.colors.gray900 }]}>
              {name} <Text style={{ color: theme.colors.gray700 }}>{action}</Text>
            </Text>
            <Text style={[theme.typography.label, { color: theme.colors.gray600 }]}>
              {formatRelativeTime(item.createdAt)}
            </Text>
          </View>
        </Row>
      );
    },
    [openTarget, testID, theme],
  );

  return (
    <SafeAreaView
      edges={['top', 'left', 'right']}
      style={[styles.safeArea, { backgroundColor: theme.colors.gray0 }]}
      testID={testID}
    >
      <View style={styles.header}>
        <ChromeBackButton onPress={() => router.back()} testID={`${testID}-back`} />
        <Text style={[theme.typography.titleXsmall, styles.title]}>Notifications</Text>
        <View style={styles.headerSpacer} />
      </View>

      <FlatList
        contentContainerStyle={items.length === 0 ? styles.emptyContent : undefined}
        data={items}
        keyExtractor={(item) => item.id}
        ListEmptyComponent={
          isLoading ? null : (
            <StateCard
              message="Likes, comments, and new followers will show up here."
              testID={`${testID}-empty`}
              title="Nothing yet"
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

/** Compact relative time — "now", "3m", "5h", "2d", then a date. */
function formatRelativeTime(iso: string): string {
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
});
