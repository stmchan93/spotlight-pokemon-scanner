import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  type TextInput as RNTextInput,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { SendDiagonal } from 'iconoir-react-native';

import { Text, TextField, useSpotlightTheme } from '@spotlight/design-system';

import { ChromeBackButton } from '@/components/chrome-back-button';
import {
  type DmMessage,
  fetchMessages,
  markConversationRead,
  sendMessage,
} from '@/features/social/dm-service';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/providers/auth-provider';

/**
 * A message in thread state: a server row, or a local one that hasn't been
 * acknowledged yet.
 *
 * `pending` is in flight. `failed` is a send that came back null — which is a
 * REAL, reachable state, not just a network blip: `sendMessage` also returns null
 * when the moderation prefilter marks the row `removed`, and such a row would not
 * survive the next read. A failed entry stays on screen with its text intact,
 * because silently dropping what someone typed is the worst thing this screen can
 * do.
 */
type ThreadMessage = DmMessage & {
  failed?: boolean;
  pending?: boolean;
};

/**
 * Local ids are prefixed so they can never be mistaken for — or collide with — a
 * server uuid, which is what makes reconciliation a plain id match.
 */
const LOCAL_ID_PREFIX = 'local-';

/** Oldest at top, newest at bottom: the usual chat order. */
function compareMessages(a: ThreadMessage, b: ThreadMessage): number {
  const byTime = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  if (byTime !== 0 && !Number.isNaN(byTime)) {
    return byTime;
  }
  // Stable tie-break so two messages sharing a timestamp don't swap places
  // between renders.
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * THE single place a server message enters thread state, deduped by id.
 *
 * Every source funnels through here — the initial load, pull-to-refresh, the row
 * returned by a successful send, and the realtime subscription — so "a message
 * arrived" has exactly one meaning in this screen. That is also what makes the
 * socket's echo of your own just-sent message collapse onto the row you already
 * have instead of rendering twice.
 *
 * Server rows are spread fresh, which drops any `pending`/`failed` flag the local
 * entry carried; locally-failed entries keep their local ids and so survive.
 */
function mergeMessages(current: ThreadMessage[], incoming: DmMessage[]): ThreadMessage[] {
  const byId = new Map<string, ThreadMessage>();
  for (const message of current) {
    byId.set(message.id, message);
  }
  for (const message of incoming) {
    byId.set(message.id, { ...message });
  }
  return Array.from(byId.values()).sort(compareMessages);
}

/**
 * One DM thread: the message list, and a composer pinned to the bottom.
 *
 * `title` is passed in by the inbox rather than looked up. There is no
 * fetch-one-conversation read in the data layer, and re-running the full inbox
 * query to title a header would cost an unread-count request per thread.
 */
export function DmThreadScreen({
  conversationId,
  testID = 'dm-thread',
  title,
}: {
  conversationId: string;
  testID?: string;
  title?: string;
}) {
  const theme = useSpotlightTheme();
  const router = useRouter();
  const { currentUser } = useAuth();

  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [draft, setDraft] = useState('');
  // Needed to clear the NATIVE text, not just React state — see handleSend.
  const composerRef = useRef<RNTextInput>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const listRef = useRef<FlatList<ThreadMessage>>(null);
  const localIdRef = useRef(0);

  const myUserId = currentUser?.id ?? null;
  const canSend = draft.trim().length > 0 && conversationId.length > 0;

  const load = useCallback(async () => {
    const rows = await fetchMessages(conversationId);
    setMessages((current) => mergeMessages(current, rows));
    setIsLoading(false);
  }, [conversationId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Live delivery. Subscribes to INSERTs on this conversation only — the filter
  // is server-side, so the socket never carries other people's threads, and RLS
  // is applied to the broadcast on top of it.
  //
  // The subscription is scoped to the OPEN THREAD, not the session: it is torn
  // down on unmount, so concurrent realtime connections track "users with a
  // thread open" rather than "users signed in". That is the whole reason the
  // inbox still polls on focus instead of subscribing too.
  //
  // Requires `social_12` (which publishes `messages`). Without it a channel
  // reports SUBSCRIBED and delivers nothing — so if messages only appear on
  // pull-to-refresh, check the publication before debugging this code.
  useEffect(() => {
    // Captured into a local so TypeScript keeps the narrowing through the
    // cleanup closure — `supabase` is a nullable module export.
    const client = supabase;
    if (!client || !conversationId) {
      return;
    }

    const channel = client
      .channel(`dm:${conversationId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload: { new?: Record<string, unknown> }) => {
          const row = payload.new;
          if (!row || typeof row.id !== 'string') {
            return;
          }
          // The moderation prefilter can stamp a row `removed` before insert;
          // it must not render just because it arrived over the socket.
          if (row.content_status !== 'visible' && row.content_status != null) {
            return;
          }
          // Straight through the same merge the fetch path uses, so an echo of
          // your own just-sent message dedupes by id instead of double-rendering.
          const incoming: DmMessage = {
            id: row.id,
            conversationId: String(row.conversation_id ?? conversationId),
            senderId: String(row.sender_id ?? ''),
            body: String(row.body ?? ''),
            createdAt: String(row.created_at ?? new Date().toISOString()),
          };
          setMessages((current) => mergeMessages(current, [incoming]));
        },
      )
      .subscribe();

    return () => {
      void client.removeChannel(channel);
    };
  }, [conversationId]);

  // Opening the thread IS reading it. Fire-and-forget and separate from `load`
  // so a rejected cursor update can never stop the messages rendering — worst
  // case the inbox badge stays stale until the next open.
  useEffect(() => {
    void markConversationRead(conversationId);
  }, [conversationId]);

  const handleRefresh = useCallback(() => {
    setIsRefreshing(true);
    void load().finally(() => setIsRefreshing(false));
  }, [load]);

  /**
   * Attempt delivery of one local entry, then reconcile it.
   *
   * On success the temp entry is REMOVED and the server row merged in its place —
   * matched by the local id — so the bubble keeps its position without ever
   * becoming a duplicate of the row a later refresh would fetch. The server row
   * also carries the authoritative `created_at`; the local clock is not
   * authoritative and would sort wrongly against messages from the other side.
   */
  const deliver = useCallback(
    async (localId: string, text: string) => {
      const saved = await sendMessage(conversationId, text);
      if (saved) {
        setMessages((current) =>
          mergeMessages(
            current.filter((message) => message.id !== localId),
            [saved],
          ),
        );
        return;
      }
      setMessages((current) =>
        current.map((message) =>
          message.id === localId ? { ...message, failed: true, pending: false } : message,
        ),
      );
    },
    [conversationId],
  );

  const handleSend = useCallback(() => {
    const text = draft.trim();
    if (text.length === 0 || conversationId.length === 0) {
      return;
    }

    const localId = `${LOCAL_ID_PREFIX}${++localIdRef.current}`;
    // Append and clear the field synchronously: the bubble is on screen and the
    // composer is empty before the request is even issued.
    setMessages((current) =>
      [
        ...current,
        {
          id: localId,
          conversationId,
          senderId: myUserId ?? '',
          body: text,
          createdAt: new Date().toISOString(),
          pending: true,
        },
      ].sort(compareMessages),
    );
    setDraft('');
    // Clearing state alone is not enough on iOS. While an autocorrect /
    // predictive-text suggestion is still pending, UIKit holds uncommitted
    // "marked text" in the field that React does not own, so setting value=''
    // leaves the sentence visibly sitting there — and the NEXT send appears to
    // be the one that clears it. `clear()` drops the marked text at the native
    // layer, which is the only thing that ends the composition session.
    composerRef.current?.clear();
    void deliver(localId, text);
  }, [conversationId, deliver, draft, myUserId]);

  /** Re-send a failed entry in place — same local id, so it reconciles normally. */
  const handleRetry = useCallback(
    (message: ThreadMessage) => {
      if (!message.failed) {
        return;
      }
      setMessages((current) =>
        current.map((entry) =>
          entry.id === message.id ? { ...entry, failed: false, pending: true } : entry,
        ),
      );
      void deliver(message.id, message.body);
    },
    [deliver],
  );

  const renderItem = useCallback(
    ({ item }: { item: ThreadMessage }) => {
      // A locally-created entry is always mine, which keeps the optimistic bubble
      // on the right even before auth has resolved a user id.
      const isMine = item.id.startsWith(LOCAL_ID_PREFIX) || (myUserId !== null && item.senderId === myUserId);
      const bubbleColor = item.failed
        ? theme.colors.red50
        : isMine
          ? theme.colors.purple500
          : theme.colors.gray100;
      const bodyColor = item.failed
        ? theme.colors.dangerStrong
        : isMine
          ? theme.colors.gray0
          : theme.colors.gray900;

      return (
        <View
          style={[styles.row, isMine ? styles.rowMine : styles.rowTheirs]}
          testID={`${testID}-row-${item.id}`}
        >
          <Pressable
            accessibilityLabel={item.failed ? 'Retry sending' : undefined}
            accessibilityRole={item.failed ? 'button' : undefined}
            disabled={!item.failed}
            onPress={() => handleRetry(item)}
            style={[
              styles.bubble,
              {
                backgroundColor: bubbleColor,
                borderRadius: theme.radii.lg,
                // A pending bubble is dimmed rather than replaced by a spinner:
                // the text stays readable and the row doesn't reflow when it lands.
                opacity: item.pending ? 0.6 : 1,
              },
            ]}
          >
            <Text style={[theme.typography.body, { color: bodyColor }]}>{item.body}</Text>
            {item.failed ? (
              <Text
                style={[theme.typography.micro, { color: theme.colors.dangerStrong }]}
                testID={`${testID}-failed-${item.id}`}
              >
                Not sent — tap to try again
              </Text>
            ) : null}
          </Pressable>
        </View>
      );
    },
    [handleRetry, myUserId, testID, theme],
  );

  const contentStyle = useMemo(
    () => (messages.length === 0 ? styles.emptyContent : styles.listContent),
    [messages.length],
  );

  return (
    <SafeAreaView
      edges={['top', 'bottom', 'left', 'right']}
      style={[styles.safeArea, { backgroundColor: theme.colors.gray0 }]}
      testID={testID}
    >
      <View style={[styles.header, { borderBottomColor: theme.colors.gray200 }]}>
        <ChromeBackButton onPress={() => router.back()} testID={`${testID}-back`} />
        <Text numberOfLines={1} style={[theme.typography.titleXsmall, styles.title]}>
          {title?.trim() || 'Message'}
        </Text>
        <View style={styles.headerSpacer} />
      </View>

      <KeyboardAvoidingView
        // A full-screen push, not a form sheet: iOS does not move this for the
        // keyboard by itself, so `padding` is correct here (unlike the New Post
        // composer, where it would double-count). Android resizes the window,
        // which `height` matches.
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.flex}
      >
        <FlatList
          contentContainerStyle={contentStyle}
          data={messages}
          keyExtractor={(item) => item.id}
          ListEmptyComponent={
            isLoading ? null : (
              // Plain centred line, NOT a StateCard. A card with a "No messages
              // yet" heading frames an empty thread as a failed load — the same
              // treatment this app gives a backend error. An empty thread isn't
              // a problem, it's the normal first moment of every conversation,
              // so it gets one quiet prompt and nothing else.
              <Text
                style={[
                  theme.typography.body,
                  styles.emptyPrompt,
                  { color: theme.colors.gray600 },
                ]}
                testID={`${testID}-empty`}
              >
                Say something to start this conversation
              </Text>
            )
          }
          // Newest sits at the bottom, so every content-height change (first
          // load, a sent message, a refresh) has to pin the view there.
          onContentSizeChange={() => {
            if (messages.length > 0) {
              listRef.current?.scrollToEnd({ animated: false });
            }
          }}
          ref={listRef}
          refreshControl={<RefreshControl onRefresh={handleRefresh} refreshing={isRefreshing} />}
          renderItem={renderItem}
          testID={`${testID}-list`}
        />

        <View style={[styles.composer, { borderTopColor: theme.colors.outlineSubtle }]}>
          <View style={styles.composerField}>
            <TextField
              onChangeText={setDraft}
              ref={composerRef}
              onSubmitEditing={handleSend}
              placeholder="Message…"
              returnKeyType="send"
              testID={`${testID}-input`}
              value={draft}
            />
          </View>
          <Pressable
            accessibilityLabel="Send message"
            accessibilityRole="button"
            disabled={!canSend}
            hitSlop={8}
            onPress={handleSend}
            style={[
              styles.sendButton,
              {
                backgroundColor: canSend ? theme.colors.purple500 : theme.colors.gray200,
                borderRadius: theme.radii.pill,
              },
            ]}
            testID={`${testID}-send`}
          >
            <SendDiagonal color={theme.colors.gray0} height={18} width={18} />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  bubble: {
    gap: 2,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  composer: {
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  composerField: {
    flex: 1,
  },
  emptyContent: {
    // `flexGrow` (not `flex`) so the container fills the list only while empty;
    // once messages exist the content sizes to them and stays bottom-pinned.
    flexGrow: 1,
    justifyContent: 'center',
    padding: 16,
  },
  emptyPrompt: {
    textAlign: 'center',
  },
  flex: {
    flex: 1,
  },
  header: {
    alignItems: 'center',
    // Separates the header from the thread. The screen previously had a single
    // rule at the very bottom (the composer's top edge), so the back button and
    // the name floated against the first message with nothing dividing them.
    borderBottomWidth: StyleSheet.hairlineWidth,
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
  listContent: {
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  row: {
    // A bubble never spans the full width — the free edge is what makes the
    // left/right split readable at a glance.
    maxWidth: '80%',
  },
  rowMine: {
    alignItems: 'flex-end',
    alignSelf: 'flex-end',
  },
  rowTheirs: {
    alignItems: 'flex-start',
    alignSelf: 'flex-start',
  },
  safeArea: {
    flex: 1,
  },
  sendButton: {
    alignItems: 'center',
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  title: {
    flex: 1,
    textAlign: 'center',
  },
});
