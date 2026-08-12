import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Dimensions,
  Easing,
  FlatList,
  Keyboard,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar, SearchField, Text, useSpotlightTheme } from '@spotlight/design-system';

import { searchUsers } from '@/features/profile/profile-service';
import type { UserProfile } from '@/features/auth/auth-models';
import {
  type DmConversation,
  fetchConversations,
  findOrCreateDm,
  sendMessage,
} from '@/features/social/dm-service';
import { capturePostHogEvent } from '@/lib/observability/posthog';
import { keyboardLift } from '@/lib/keyboard-insets';

/** One tappable recipient, from either source. */
type Recipient = {
  key: string;
  userId: string;
  displayName: string;
  handle: string | null;
  avatarUrl: string | null;
  /** Already have a thread with them — saves a `findOrCreateDm` round trip. */
  conversationId: string | null;
};

function recipientFromConversation(conversation: DmConversation): Recipient | null {
  const other = conversation.otherUser;
  if (!conversation.otherUserId || !other) {
    // Group threads and participants who are no longer publicly visible
    // (blocked, suspended) have nobody to name, so they are not offerable.
    return null;
  }
  return {
    key: `conv:${conversation.id}`,
    userId: conversation.otherUserId,
    displayName: other.displayName ?? 'Collector',
    handle: other.handle ?? null,
    avatarUrl: other.avatarUrl ?? null,
    conversationId: conversation.id,
  };
}

function recipientFromProfile(profile: UserProfile): Recipient {
  return {
    key: `user:${profile.userID}`,
    userId: profile.userID,
    displayName: profile.displayName ?? profile.handle ?? 'Collector',
    handle: profile.handle ?? null,
    avatarUrl: profile.avatarURL ?? null,
    conversationId: null,
  };
}

const SCREEN_HEIGHT = Dimensions.get('window').height;

/**
 * What a send actually puts in the thread.
 *
 * A post travels as an ID so the preview stays live (delete the post and the
 * bubble goes with it). Everything else travels as message TEXT — notably the
 * `spotlight://` profile/wishlist links, which deliberately need no schema of
 * their own: `messages.body` has existed since social_02, so a text send works
 * on every project the app talks to, including ones behind on migrations.
 */
export type ShareSheetPayload =
  | { kind: 'post'; postId: string }
  /**
   * A collection or wishlist, as a REFERENCE (social_24) — the recipient gets a
   * tappable preview card rather than a URL in the body. Needs the migration
   * applied; `text` remains the form that works against a project behind on
   * migrations.
   */
  | {
      kind: 'profile';
      userId: string;
      tab: 'collection' | 'wishlist';
      /** Sent instead if the project has not applied social_24. */
      fallbackBody: string;
    }
  | { kind: 'text'; body: string };

/**
 * "Send this post to…" — the in-app half of sharing a post.
 *
 * Deliberately NOT a repost. The post is sent to someone, not republished, so
 * nothing here can outlive the original: the message carries only an id, and the
 * preview is hydrated from `posts` on every read (social_22).
 *
 * THE SHEET STAYS OPEN AFTER A SEND, and the row you tapped flips to "Sent".
 * Sharing is plural in practice — you send the same pull to the two people who
 * would care — and closing on the first tap would make the second send a second
 * trip through the ⋯ menu. It is also the only confirmation there is: with the
 * sheet gone, a send and a silently-failed send look identical.
 *
 * Rendered IN-TREE like `OptionsSheet`, with the same scrim, slide and handle,
 * so the caller's own Modal is the only native modal — presenting a second over
 * a presented one is unreliable on iOS and reads as the button doing nothing.
 * (That shell is written out a third time here rather than extracted: the three
 * sheets differ in what they hold, and `ConfirmDeleteSheet`/`OptionsSheet` are
 * both live in other sessions' hands. Worth folding together later.)
 */
export function SharePostSheet({
  payload,
  title = 'Send post to',
  visible,
  onClose,
  onSent,
  testID = 'share-post-sheet',
}: {
  payload: ShareSheetPayload;
  /** Sheet heading. Names what tapping a recipient will actually send. */
  title?: string;
  visible: boolean;
  onClose: () => void;
  /** Fired after each successful send, for callers that want to react. */
  onSent?: (recipient: Recipient) => void;
  testID?: string;
}) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();

  const [threads, setThreads] = useState<Recipient[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Recipient[]>([]);
  /** Who is mid-send, so their row can spin. */
  const [sendingTo, setSendingTo] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<Set<string>>(new Set());
  const sendingRef = useRef(false);

  // Stay mounted through the closing slide-down, then unmount — matches
  // `OptionsSheet` so the transition reads identically.
  const [isRendered, setIsRendered] = useState(visible);
  const translateY = useRef(new Animated.Value(SCREEN_HEIGHT)).current;

  useEffect(() => {
    if (visible) {
      setIsRendered(true);
      const animation = Animated.spring(translateY, {
        toValue: 0,
        damping: 34,
        mass: 1,
        stiffness: 320,
        useNativeDriver: false,
      });
      animation.start();
      return () => animation.stop();
    }

    const animation = Animated.timing(translateY, {
      toValue: SCREEN_HEIGHT,
      duration: 200,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: false,
    });
    animation.start(({ finished }) => {
      if (finished) {
        setIsRendered(false);
      }
    });
    return () => animation.stop();
  }, [translateY, visible]);

  // Read off `payload` as primitives so the effect below depends on values, not
  // on an object identity the caller rebuilds every render — otherwise opening
  // the sheet once would report it opened on every parent re-render.
  const payloadKind = payload.kind;
  const payloadTab = payload.kind === 'profile' ? payload.tab : null;

  useEffect(() => {
    if (!visible) {
      return;
    }
    capturePostHogEvent('share_sheet_opened', {
      kind: payloadKind,
      tab: payloadTab,
    });
  }, [payloadKind, payloadTab, visible]);

  /*
    This sheet carries a text field, so it is one of the surfaces that has to
    hold itself clear of the keyboard. The arithmetic is NOT "subtract the
    keyboard height" on both platforms — see `keyboardLift`; under Android's
    edge-to-edge window the reported height excludes the navigation bar this
    sheet's own bottom padding is already paying.
  */
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  useEffect(() => {
    if (!visible) {
      setKeyboardHeight(0);
      return;
    }
    const show = Keyboard.addListener('keyboardDidShow', (event) => {
      setKeyboardHeight(event.endCoordinates?.height ?? 0);
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, [visible]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const rows = await fetchConversations();
      if (cancelled) {
        return;
      }
      setThreads(rows.map(recipientFromConversation).filter((row): row is Recipient => row != null));
      setIsLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Same debounced prefix search the inbox uses, so starting a NEW thread from
  // here does not mean leaving to find the person first.
  const trimmedQuery = query.trim();
  useEffect(() => {
    if (trimmedQuery.length === 0) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void searchUsers(trimmedQuery).then((rows) => {
        if (!cancelled) {
          setResults(rows.map(recipientFromProfile));
        }
      });
    }, 220);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [trimmedQuery]);

  const handleSend = useCallback(
    (recipient: Recipient) => {
      // Synchronous, unlike state — two taps in one tick would both read a
      // stale `null` and send twice.
      if (sendingRef.current || sentTo.has(recipient.userId)) {
        return;
      }
      sendingRef.current = true;
      setSendingTo(recipient.userId);

      void (async () => {
        try {
          const conversationId =
            recipient.conversationId ?? (await findOrCreateDm(recipient.userId));
          if (!conversationId) {
            return;
          }
          // A post sends no caption: `body` is NOT NULL, so that path sends ''
          // and the post id carries the meaning. A text payload is the inverse —
          // the body IS the message and there is no attachment id.
          // Attachments send no caption: `body` is NOT NULL, so those paths send
          // '' and the reference carries the meaning. A text payload is the
          // inverse — the body IS the message and there is no attachment.
          const sent =
            payload.kind === 'post'
              ? await sendMessage(conversationId, '', { sharedPostId: payload.postId })
              : payload.kind === 'profile'
                ? await sendMessage(conversationId, '', {
                    sharedProfileFallbackBody: payload.fallbackBody,
                    sharedProfileTab: payload.tab,
                    sharedProfileUserId: payload.userId,
                  })
                : await sendMessage(conversationId, payload.body);
          if (!sent) {
            return;
          }
          // Opening the sheet is intent; this is the only thing that says
          // sharing actually works. The sheet stays open for repeat sends, so
          // one open can legitimately produce several of these.
          capturePostHogEvent('share_sheet_sent', {
            kind: payloadKind,
            tab: payloadTab,
          });
          setSentTo((current) => new Set(current).add(recipient.userId));
          onSent?.(recipient);
        } finally {
          sendingRef.current = false;
          setSendingTo(null);
        }
      })();
    },
    [onSent, payload, payloadKind, payloadTab, sentTo],
  );

  const data = trimmedQuery.length > 0 ? results : threads;

  const renderRecipient = useCallback(
    ({ item }: { item: Recipient }) => {
      const isSent = sentTo.has(item.userId);
      const isSending = sendingTo === item.userId;
      return (
        <Pressable
          accessibilityLabel={isSent ? `Sent to ${item.displayName}` : `Send to ${item.displayName}`}
          accessibilityRole="button"
          accessibilityState={{ disabled: isSent }}
          disabled={isSent || isSending}
          onPress={() => handleSend(item)}
          style={styles.row}
          testID={`${testID}-recipient-${item.userId}`}
        >
          <Avatar
            initials={item.displayName.slice(0, 1).toUpperCase()}
            size={40}
            uri={item.avatarUrl ?? undefined}
          />
          <View style={styles.rowCopy}>
            <Text
              numberOfLines={1}
              style={[theme.typography.bodyMedium, { color: theme.colors.gray900 }]}
            >
              {item.displayName}
            </Text>
            {item.handle ? (
              <Text
                numberOfLines={1}
                style={[theme.typography.label, { color: theme.colors.gray600 }]}
              >
                {`@${item.handle}`}
              </Text>
            ) : null}
          </View>
          {isSending ? (
            <ActivityIndicator size="small" testID={`${testID}-sending-${item.userId}`} />
          ) : (
            <Text
              style={[
                theme.typography.label,
                { color: isSent ? theme.colors.gray600 : theme.colors.purple500 },
              ]}
              testID={`${testID}-state-${item.userId}`}
            >
              {isSent ? 'Sent' : 'Send'}
            </Text>
          )}
        </Pressable>
      );
    },
    [handleSend, sendingTo, sentTo, testID, theme],
  );

  if (!isRendered) {
    return null;
  }

  const bottomInset = Math.max(insets.bottom, 16) + 8;

  return (
    <View pointerEvents={visible ? 'auto' : 'none'} style={styles.root}>
      <Pressable
        accessibilityLabel="Close"
        accessibilityRole="button"
        onPress={onClose}
        style={styles.backdrop}
        testID={`${testID}-backdrop`}
      />
      <Animated.View
        style={[
          styles.sheet,
          {
            backgroundColor: theme.colors.gray0,
            paddingBottom: bottomInset,
            // The slide and the keyboard lift compose on one axis: the sheet is
            // bottom-anchored, so lifting it is negative translation.
            transform: [{ translateY }, { translateY: -keyboardLift(keyboardHeight, bottomInset) }],
          },
        ]}
        testID={testID}
      >
        <View style={styles.header}>
          <Pressable
            accessibilityLabel="Close"
            accessibilityRole="button"
            hitSlop={16}
            onPress={onClose}
            style={styles.handleHit}
            testID={`${testID}-handle`}
          >
            <View style={[styles.handleBar, { backgroundColor: theme.colors.gray200 }]} />
          </Pressable>
          {/*
            Named, unlike the menu sheets: a list of people is not
            self-explanatory the way "Report post / Block Misty" is, and without
            this line the sheet does not say what tapping a name does.
          */}
          <Text
            style={[theme.typography.bodyMedium, styles.title, { color: theme.colors.gray900 }]}
          >
            {title}
          </Text>
        </View>

        <View style={styles.body}>
          <SearchField
            autoCapitalize="none"
            autoCorrect={false}
            containerTestID={`${testID}-search`}
            onChangeText={setQuery}
            placeholder="Search collectors"
            value={query}
          />
          {isLoading ? (
            <ActivityIndicator style={styles.loading} testID={`${testID}-loading`} />
          ) : (
            <FlatList
              data={data}
              keyboardShouldPersistTaps="handled"
              keyExtractor={(item) => item.key}
              ListEmptyComponent={
                <Text
                  style={[theme.typography.label, styles.empty, { color: theme.colors.gray600 }]}
                  testID={`${testID}-empty`}
                >
                  {trimmedQuery.length > 0
                    ? 'No collectors found.'
                    : 'Search for someone to send this to.'}
                </Text>
              }
              renderItem={renderRecipient}
              style={styles.list}
            />
          )}
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
  },
  body: {
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  empty: {
    paddingVertical: 24,
    textAlign: 'center',
  },
  handleBar: {
    borderRadius: 2,
    height: 4,
    width: 36,
  },
  handleHit: {
    alignItems: 'center',
    paddingBottom: 6,
    paddingTop: 4,
  },
  header: {
    width: '100%',
  },
  list: {
    // Bounded: the sheet must not grow past the screen when you have many
    // threads, and the list scrolls inside it.
    flexGrow: 0,
    maxHeight: 320,
  },
  loading: {
    paddingVertical: 24,
  },
  // Fill the caller's Modal instead of being one. `zIndex` so the overlay paints
  // above its siblings on both platforms rather than relying on child order.
  root: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
    zIndex: 1,
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    paddingVertical: 10,
  },
  rowCopy: {
    flex: 1,
  },
  sheet: {
    paddingTop: 10,
  },
  title: {
    paddingTop: 14,
    textAlign: 'center',
  },
});

export default SharePostSheet;
