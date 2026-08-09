import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Image as ExpoImage } from 'expo-image';

import { Avatar, StateCard, Text, useSpotlightTheme } from '@spotlight/design-system';

import { ChromeBackButton } from '@/components/chrome-back-button';
import { resolveRepositoryBaseUrl } from '@/providers/app-providers';
import { useAuth } from '@/providers/auth-provider';
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
  const { accessToken, currentUser } = useAuth();
  const apiBaseUrl = resolveRepositoryBaseUrl();
  // Your handle is what a reply @mentions — see the body renderer.
  const myHandle = currentUser?.handle ?? null;

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
   * Every kind is navigable now. Likes and comments used to be inert because
   * there was no per-post route to send them to; `/post/[postId]` exists, so a
   * like opens the post and anything about a comment opens the post with its
   * thread already up (`?comments=1`).
   *
   * A row still goes nowhere when it has nothing to point AT: a follow from
   * someone with no handle has no public profile URL, and a like on a post that
   * has since been deleted arrives with no `postId`.
   */
  const openTarget = useCallback(
    (item: AppNotification): (() => void) | null => {
      if (item.type === 'follow') {
        const handle = item.actor?.handle;
        return handle ? () => router.push(`/u/${handle}` as never) : null;
      }
      if (!item.postId) {
        return null;
      }
      const postId = item.postId;
      const comments = item.commentId ? '1' : '0';
      return () =>
        router.push({ pathname: '/post/[postId]', params: { postId, comments } } as never);
    },
    [router],
  );

  const renderItem = useCallback(
    ({ item }: { item: AppNotification }) => {
      const name = personLabel(item.actor) ?? 'Someone';
      /*
        Say WHERE it happened, not just what. A reply arrives on someone else's
        post as often as on your own, and "replied to you" left you opening the
        thread to find out whose conversation you were in.

        `postAuthor` is null for your own post (the service only resolves a name
        when the owner isn't you), which is what makes the two phrasings fall out
        of one expression instead of a flag.
      */
      const postWhere = personLabel(item.postAuthor)
        ? `${personLabel(item.postAuthor)}'s post`
        : 'your post';

      const action =
        item.type === 'follow'
          ? 'started following you'
          : item.type === 'like'
            ? // A like notification is always about something of YOURS — you are
              // the recipient — so it never needs the owner's name.
              item.commentId
              ? 'liked your comment'
              : 'liked your post'
            : item.isReply
              ? `replied to your comment on ${postWhere}:`
              : `commented on ${postWhere}:`;

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
            {/*
              ONE wrapping paragraph — name, what they did, what they said, when.
              Not a stack of Texts.

              Stacked blocks put a hard line break after "…'s post:" and another
              before the date, which reads as three separate facts and wastes two
              rows of height per notification. As one paragraph it wraps
              naturally and the whole thing scans as a sentence, which is what
              the reference design does.
            */}
            <Text
              // Four lines caps a long comment so one notification cannot push
              // every other one off the screen. Everything before the body is
              // short, so this is effectively "about two lines of comment".
              numberOfLines={4}
              style={[theme.typography.bodyMedium, { color: theme.colors.gray900 }]}
            >
              {name}
              <Text style={{ color: theme.colors.gray700 }}>{` ${action}`}</Text>
              {item.commentBody ? (
                <Text testID={`${testID}-row-${item.id}-body`}>
                  {/*
                    A reply is addressed to YOU, and the thread renders that as a
                    blue @mention of the parent's author. Reproduce it here from
                    your own handle rather than reading it out of the body —
                    bodies do not contain the mention, the thread composes it.
                  */}
                  {item.isReply && myHandle ? (
                    <Text style={{ color: theme.colors.blue400 }}>{` @${myHandle}`}</Text>
                  ) : null}
                  <Text style={{ color: theme.colors.gray900 }}>{` ${item.commentBody}`}</Text>
                </Text>
              ) : null}
              <Text style={{ color: theme.colors.gray500 }}>
                {` ${formatNotificationDate(item.createdAt)}`}
              </Text>
            </Text>
          </View>

          {/*
            The post it happened on, so a row is identifiable at a glance when
            several land on different posts. Same authenticated proxy the feed
            uses — post images are private until moderation approves them, so
            there is no public URL to point at.
          */}
          {item.postMediaId && apiBaseUrl && accessToken ? (
            <ExpoImage
              accessibilityIgnoresInvertColors
              cachePolicy="memory-disk"
              contentFit="cover"
              source={{
                uri: `${apiBaseUrl.replace(/\/+$/, '')}/api/v1/post-media/${item.postMediaId}`,
                headers: { Authorization: `Bearer ${accessToken}` },
              }}
              style={[styles.thumbnail, { backgroundColor: theme.colors.gray100 }]}
              testID={`${testID}-row-${item.id}-thumbnail`}
            />
          ) : null}
        </Row>
      );
    },
    [accessToken, apiBaseUrl, myHandle, openTarget, testID, theme],
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

/**
 * How a person is named in a notification sentence: their HANDLE when they have
 * one, their display name otherwise, and null when they have neither.
 *
 * Handle first, not display name first. A handle is the identity people
 * recognise and it is unique; display names are free text, so two collectors can
 * share one and "Steve replied to your comment on Steve's post" is unreadable.
 *
 * No leading `@` — that belongs to a MENTION, which is a different thing and is
 * why the comment body below still renders one. Here the name is the subject of
 * a sentence, and Instagram's own rows read "sarahkim_ replied…", not "@sarahkim_
 * replied…".
 */
function personLabel(person: AppNotification['actor']): string | null {
  return person?.handle?.trim() || person?.displayName?.trim() || null;
}

/**
 * Calendar date only — "Aug 8".
 *
 * Not the "3m / 5h / 2d" relative clock this used to show. Notifications are
 * read in a batch days apart, and a column of "2d, 3d, 6d" makes you do the
 * arithmetic to place any of them; a date is the same length and just says
 * when. It also sits INLINE at the end of the line here rather than on its own
 * row, which is only legible because it is short and fixed-width-ish.
 *
 * No year: the list is capped at the most recent 50 notifications, so a row old
 * enough for the year to matter is not reachable in practice.
 */
function formatNotificationDate(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return '';
  }
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
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
    // `flex-start`, not `center`: a row can now be three lines tall (action,
    // comment body, timestamp), and centring floated the avatar and thumbnail
    // into the middle of that block instead of aligning them to the first line.
    alignItems: 'flex-start',
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  thumbnail: {
    borderRadius: 6,
    height: 44,
    width: 44,
  },
  safeArea: {
    flex: 1,
  },
  title: {
    flex: 1,
    textAlign: 'center',
  },
});
