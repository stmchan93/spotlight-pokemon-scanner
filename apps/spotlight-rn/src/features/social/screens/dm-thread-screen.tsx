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

import { Avatar, Text, TextField, useSpotlightTheme } from '@spotlight/design-system';

import { ChromeBackButton } from '@/components/chrome-back-button';
import { profileRouteSlug } from '@/features/social/profile-link';
import { MessageBodyText } from '@/features/social/components/message-body-text';
import { SharedPostBubble } from '@/features/social/components/shared-post-bubble';
import { SharedProfileBubble } from '@/features/social/components/shared-profile-bubble';
import {
  DEFAULT_MESSAGE_LIMIT,
  type DmMessage,
  fetchConversationBlocked,
  fetchConversationReadState,
  fetchMessages,
  markConversationRead,
  sendMessage,
} from '@/features/social/dm-service';
import { supabase } from '@/lib/supabase';
import { resolveRepositoryBaseUrl, useAppServices } from '@/providers/app-providers';
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

/**
 * The read-receipt avatar under your newest seen message.
 *
 * 16 rather than 14: at 14 it read as a smudge beside a 240pt card rather than
 * as a face, and the point of an avatar receipt over the word "Seen" is that you
 * recognise WHO without reading. Still well under the 28pt sender avatars beside
 * incoming messages, so it stays a footnote rather than competing with them.
 */
const SEEN_RECEIPT_SIZE = 16;
/**
 * Breathing room between a message and its receipt. Shared by the receipt and
 * the sent-time text so the two swap without the thread twitching.
 */
const SEEN_ROW_GAP = 4;

/**
 * Monotonic suffix for realtime channel topics — see the long note at the
 * subscription. A module-level counter rather than a random id so the topic is
 * deterministic and reproducible in tests.
 */
let dmChannelSequence = 0;

/**
 * "Sent 2h ago" for the delivery footer. The thread deliberately renders no
 * per-message timestamps, so this is the only clock in the screen — phrased as
 * prose ("just now", "2h ago") because it reads as a status, not a log line.
 * No ticking timer: the label refreshes on any re-render, which this screen
 * does on every send, refresh, and realtime event.
 */
/**
 * How long a silence has to be before the thread stamps the time on top of the
 * next message. One hour, which is roughly what Messenger does.
 *
 * The point is to date a CONVERSATION, not a message: stamping every bubble
 * turns a thread into a log, and stamping none leaves you scrolling back
 * wondering whether "tomorrow?" was asked today or last week. A gap is the
 * signal — it is exactly where the reader's sense of time breaks.
 */
const TIME_SEPARATOR_GAP_MS = 60 * 60 * 1000;

/**
 * The separator's copy: the time alone when it is today, the weekday when it is
 * this week, and a date once it is older.
 *
 * ALWAYS THE READER'S OWN CLOCK, never the sender's and never UTC. `created_at`
 * is stored as an absolute instant, `Date.parse` turns it back into one, and
 * every read below — `toLocaleTimeString`, `getDate`, `toDateString` — resolves
 * it in the device's timezone. So a message sent at 09:00 in London shows as
 * 04:00 to someone reading in New York, which is the only stamp that helps them
 * place it against their own day.
 *
 * That also means "today" and the day-change rule are the READER's day. Two
 * messages either side of the sender's midnight may sit in one block for you,
 * and that is correct — the separator exists to orient the person looking at it.
 *
 * Locale-formatted rather than hand-built, so 24-hour locales get 13:58 instead
 * of a hard-coded 1:58 PM.
 */
function formatTimeSeparator(iso: string, now: number = Date.now()): string {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) {
    return '';
  }
  const then = new Date(timestamp);
  const time = then.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const today = new Date(now);

  const sameDay =
    then.getFullYear() === today.getFullYear()
    && then.getMonth() === today.getMonth()
    && then.getDate() === today.getDate();
  if (sameDay) {
    return time;
  }

  const days = Math.floor((now - timestamp) / (24 * 60 * 60 * 1000));
  if (days < 7) {
    return `${then.toLocaleDateString([], { weekday: 'short' })} ${time}`;
  }
  return `${then.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${time}`;
}

function formatSentAgo(iso: string): string {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) {
    return 'Sent';
  }
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) {
    return 'Sent just now';
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `Sent ${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `Sent ${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return `Sent ${days}d ago`;
  }
  return `Sent ${new Date(timestamp).toLocaleDateString()}`;
}

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
  otherUser,
  testID = 'dm-thread',
  title,
}: {
  conversationId: string;
  /**
   * Who you are talking to, handed over by the inbox alongside `title` and for
   * the same reason. Every field is optional and independently degradable: no
   * avatar falls back to initials, and no handle OR id simply makes the header
   * and the message avatars non-navigable instead of dead links.
   */
  otherUser?: {
    avatarUrl?: string | null;
    displayName?: string | null;
    handle?: string | null;
    userId?: string | null;
  };
  testID?: string;
  title?: string;
}) {
  const theme = useSpotlightTheme();
  const router = useRouter();
  const { currentUser, accessToken } = useAuth();
  const { spotlightRepository } = useAppServices();
  // A shared post's photo streams from the authenticated media proxy, same as
  // in the feed — the bytes are private until moderation approves them.
  const apiBaseUrl = resolveRepositoryBaseUrl();

  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [draft, setDraft] = useState('');
  // Needed to clear the NATIVE text, not just React state — see handleSend.
  const composerRef = useRef<RNTextInput>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  /**
   * The thread is frozen by a block, in a direction this screen deliberately
   * cannot see — see `fetchConversationBlocked`.
   *
   * Mirrored into a ref because the state alone is one render too slow for the
   * guards that matter: a block discovered by a failed send has to stop the
   * NEXT delivery attempt synchronously, including one already queued behind a
   * retry tap.
   */
  const [isBlocked, setIsBlocked] = useState(false);
  const isBlockedRef = useRef(false);
  const applyBlocked = useCallback((blocked: boolean | null) => {
    // Null is "no answer", not "not blocked". Ignoring it is what keeps a
    // dropped request from unlocking a composer the server will keep rejecting.
    if (blocked === null) {
      return;
    }
    isBlockedRef.current = blocked;
    setIsBlocked(blocked);
  }, []);

  const listRef = useRef<FlatList<ThreadMessage>>(null);
  /**
   * Pin the view to the newest message.
   *
   * `onContentSizeChange` already does this when the content HEIGHT changes, but
   * that misses the two cases people actually notice: opening the keyboard (the
   * list gets shorter, the content does not change) and sending while scrolled
   * up. Guarded on a non-empty list because scrollToEnd on an empty FlatList
   * warns.
   */
  const hasMessagesRef = useRef(false);
  /**
   * The last content height the list reported, so a pin can target the TRUE
   * bottom rather than an estimate.
   *
   * `scrollToEnd` derives its offset from what the list currently believes the
   * content measures, and with variable-height rows — one-word bubbles next to
   * wrapped ones — that belief can be stale by exactly the row just added. The
   * result is a scroll that stops a bubble short, which is what "I sent a
   * message and it's still under the keyboard" looks like. The height handed to
   * `onContentSizeChange` is measured, not estimated; over-scrolling is clamped
   * by the scroll view, so aiming at it can only be right.
   */
  const contentHeightRef = useRef(0);
  /**
   * Has the thread been pinned to the bottom at least once?
   *
   * ─────────────────────────────────────────────────────────────────────────
   * WHY THE LIST IS HIDDEN UNTIL IT HAS
   * ─────────────────────────────────────────────────────────────────────────
   * This list is TOP-ANCHORED and scrolled to the bottom after the fact — the
   * pin happens in `onLayout` / `onContentSizeChange`, both of which run after a
   * frame has already been drawn. So opening a thread rendered the OLDEST
   * messages, then snapped to the newest: reported as "a weird flicker when
   * opening my messages", and visible on every thread long enough to scroll.
   *
   * The proper fix is an `inverted` list, where the bottom IS the origin and no
   * corrective scroll exists to be seen — but that reverses every scroll
   * offset, gesture direction and pin in this screen, which is a lot of
   * carefully-worked machinery to turn upside down for a visual bug. Hiding the
   * intermediate frames costs one boolean and leaves that machinery untouched.
   */
  /*
    ───────────────────────────────────────────────────────────────────────────
    READ RECEIPTS, WITH NO SCHEMA AND NO SUBSCRIPTION.
    ───────────────────────────────────────────────────────────────────────────
    `conversation_participants.last_read_at` has been written on every thread
    open since social_02, and the RLS lets a participant read their
    counterpart's row — so "seen" is just a comparison, not a feature.

    It refreshes on open, on pull-to-refresh, and whenever a realtime message
    arrives. It deliberately does NOT update live while you both sit in the
    thread: that would mean re-firing `markConversationRead` per incoming
    message and publishing this table to realtime, which roughly doubles the
    realtime traffic of an active chat. The moment they reply — which is the
    moment you care — a message arrives and this refreshes with it.
  */
  const [otherLastReadAt, setOtherLastReadAt] = useState<string | null>(null);
  const [isPinned, setIsPinned] = useState(false);
  const [hasRevealed, setHasRevealed] = useState(false);
  /*
    `!isLoading &&` is load-bearing. Without it the empty-list exception is true
    on the FIRST render — before anything has been fetched — so the latch closed
    immediately and the gate never gated anything. An empty thread only counts as
    empty once the fetch has actually come back saying so.

    NOTE what this DOES NOT wait for: the attachment cards. It did briefly, so
    the conversation could appear as one piece, and that is what turned a thread
    that visibly loaded into one that sat blank for up to 1.5s and then snapped
    in. Worse, the wait was uneven — it counted only shared PROFILES, and a
    profile card reports ready instantly once its cache is warm, so on a second
    open the gate lifted while the shared POST card was still a grey box, which
    then grew ~155pt underneath the reader.

    Waiting is the wrong tool anyway. Each attachment card now reserves its final
    height while it loads (see `shared-post-bubble`), so nothing changes size and
    there is nothing to hide. The gate is back to its original, narrow job: hide
    the corrective scroll, nothing else.
  */
  const isReadyToReveal = (!isLoading && messages.length === 0) || isPinned;
  useEffect(() => {
    if (isReadyToReveal) {
      setHasRevealed(true);
    }
  }, [isReadyToReveal]);
  const scrollToLatest = useCallback((animated: boolean) => {
    if (!hasMessagesRef.current) {
      return;
    }
    const list = listRef.current;
    if (!list) {
      return;
    }
    if (contentHeightRef.current > 0) {
      list.scrollToOffset({ animated, offset: contentHeightRef.current });
    } else {
      list.scrollToEnd({ animated });
    }
    // Idempotent by React's own bail-out once true, so this costs one render.
    setIsPinned(true);
  }, []);
  /**
   * Set by a send, cleared by the layout that honours it.
   *
   * Sending used to scroll inside a single `requestAnimationFrame`, which is one
   * frame too early: the row is in state and React has re-rendered, but the list
   * has not MEASURED it yet, so `scrollToEnd` computes from the old content
   * height and stops just short — leaving the message you just sent below the
   * fold. This defers the scroll to `onContentSizeChange`, which by definition
   * cannot fire until the new row has been measured.
   */
  const pinAfterSendRef = useRef(false);
  const localIdRef = useRef(0);

  // Mirrored into a ref so `scrollToLatest` stays identity-stable — it is passed
  // to onFocus and used inside handleSend, both of which would otherwise churn.
  hasMessagesRef.current = messages.length > 0;

  const myUserId = currentUser?.id ?? null;
  const canSend = !isBlocked && draft.trim().length > 0 && conversationId.length > 0;

  /**
   * Messages AND block state, in parallel, on every load.
   *
   * Both because they answer different halves of the same screen, and in
   * parallel because the block check must never delay the thread rendering —
   * reading a blocked thread is the whole reason its history stays selectable
   * under RLS (so it can be reported), and a slow RPC must not get in the way of
   * that. Riding on `load` also means pull-to-refresh re-asks, which is how a
   * block placed while the thread is open gets picked up without a second
   * subscription.
   */
  const load = useCallback(async () => {
    const [rows, blocked, readState] = await Promise.all([
      fetchMessages(conversationId),
      fetchConversationBlocked(conversationId),
      fetchConversationReadState(conversationId),
    ]);
    applyBlocked(blocked);
    setMessages((current) => mergeMessages(current, rows));
    // Null for a group, or when the read failed — both mean "say nothing".
    setOtherLastReadAt(readState?.otherLastReadAt ?? null);
    setIsLoading(false);
  }, [applyBlocked, conversationId]);

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

    /*
      UNIQUE TOPIC PER SUBSCRIPTION, and it has to be.

      `RealtimeClient.channel(topic)` does NOT always hand back a fresh channel:

        const exists = this.getChannels().find((c) => c.topic === realtimeTopic)
        if (!exists) { ...new RealtimeChannel... } else { return exists }

      and `removeChannel()` is async — the cleanup below can only fire it, not
      await it. So re-entering the same thread before the previous unsubscribe
      lands returns the OLD, already-subscribed channel, and `.on(
      'postgres_changes', ...)` on a joined channel THROWS:

        cannot add `postgres_changes` callbacks for realtime:dm:<id>
        after `subscribe()`

      which is an uncaught render-time throw straight into the error boundary —
      "the app hit an unexpected error". Seen in the wild opening a DM twice.

      A per-subscription suffix means the lookup above can never match a live
      channel, so this always gets a clean one. Two channels briefly overlapping
      on the same conversation is harmless: the filter is server-side and
      `mergeMessages` dedupes by id.
    */
    dmChannelSequence += 1;
    const channel = client
      .channel(`dm:${conversationId}:${dmChannelSequence}`)
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
            // Realtime carries the reference; the PREVIEW is hydrated from
            // `posts` when the bubble renders, so a post that has since been
            // removed or blocked never resolves even though the row arrived.
            sharedPostId:
              typeof row.shared_post_id === 'string' ? row.shared_post_id : null,
            sharedProfileUserId:
              typeof row.shared_profile_user_id === 'string' ? row.shared_profile_user_id : null,
            // Same narrowing the fetch path applies: an unrecognised tab has no
            // page to open, so it is dropped rather than passed through.
            sharedProfileTab:
              row.shared_profile_tab === 'collection' || row.shared_profile_tab === 'wishlist'
                ? row.shared_profile_tab
                : null,
          };
          setMessages((current) => mergeMessages(current, [incoming]));
          /*
            Their reply is the moment "Seen" matters, and it is free here: they
            cannot have replied without opening the thread, so their read cursor
            has just moved. Refreshing on this edge is what makes the $0 variant
            feel live without publishing `conversation_participants` to realtime
            or re-firing `markConversationRead` per message.
          */
          void fetchConversationReadState(conversationId).then((readState) => {
            if (readState) {
              setOtherLastReadAt(readState.otherLastReadAt);
            }
          });
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
  const markFailed = useCallback((localId: string) => {
    setMessages((current) =>
      current.map((message) =>
        message.id === localId ? { ...message, failed: true, pending: false } : message,
      ),
    );
  }, []);

  const deliver = useCallback(
    async (localId: string, text: string) => {
      // The ref, not the state: a send already queued when the block was
      // discovered would otherwise read the pre-render value and go out anyway.
      // The server would reject it regardless — this just stops the round trip
      // and the pending bubble that goes with it.
      if (isBlockedRef.current) {
        markFailed(localId);
        return;
      }
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
      markFailed(localId);
      // A send can fail because the thread was blocked WHILE it was open — the
      // other side blocking is invisible until something is attempted, and
      // `sendMessage` cannot tell an RLS rejection from a dropped connection.
      // Re-ask the server directly: if the answer is yes, the composer closes
      // and the retry affordance goes with it, instead of offering a tap that
      // can never succeed. A null answer changes nothing, so an ordinary network
      // failure keeps its retry.
      applyBlocked(await fetchConversationBlocked(conversationId));
    },
    [applyBlocked, conversationId, markFailed],
  );

  /*
    ─────────────────────────────────────────────────────────────────────────
    SEND FIRES ON TOUCH-DOWN, AND THIS IS WHY.
    ─────────────────────────────────────────────────────────────────────────
    Reported: with a word underlined for autocorrect, tapping Send only
    ACCEPTED the correction — you had to tap again to actually send. On iOS a
    pending autocorrection consumes the first touch outside the field, so the
    press never reached the button.

    `onPressIn` runs before that handling, so one tap sends. It also sends what
    was actually typed rather than what iOS was about to substitute, which is
    the behaviour asked for.

    `onPress` stays for accessibility — VoiceOver activation raises `onPress`
    and never `onPressIn`, so dropping it would leave screen-reader users unable
    to send at all. This latch is what stops the two paths double-sending: a
    same-tick second call would still read the pre-clear `draft`, since the
    clear is a state update that has not flushed yet.
  */
  const sentOnTouchDownRef = useRef(false);

  const handleSend = useCallback(() => {
    const text = draft.trim();
    // `isBlockedRef` covers the paths a disabled button does not: `returnKeyType`
    // submit from a field that is mid-teardown, and any send racing the moment
    // the block was discovered.
    if (text.length === 0 || conversationId.length === 0 || isBlockedRef.current) {
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
          // Optimistic rows are always plain text — the share flow sends from
          // the post card or the share sheet, not from this composer.
          sharedPostId: null,
          sharedProfileTab: null,
          sharedProfileUserId: null,
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
    // Sending while scrolled up left the new bubble off-screen: the content grew
    // but the viewport stayed where it was. Armed rather than scrolled here —
    // see `pinAfterSendRef` for why one frame is not enough.
    pinAfterSendRef.current = true;
    void deliver(localId, text);
  }, [conversationId, deliver, draft, myUserId]);

  /** Re-send a failed entry in place — same local id, so it reconciles normally. */
  const handleRetry = useCallback(
    (message: ThreadMessage) => {
      // Nothing can be retried into a blocked thread, so a retry must not even
      // flip the bubble back to `pending` — that would read as progress toward
      // an outcome that cannot happen.
      if (!message.failed || isBlockedRef.current) {
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

  const headerName = otherUser?.displayName?.trim() || title?.trim() || 'Message';
  /**
   * Where the counterparty's photo and name lead, or null when neither a handle
   * nor an id came through — in which case nothing is made to look tappable.
   */
  const openProfile = useMemo(() => {
    const slug = profileRouteSlug(otherUser?.handle, otherUser?.userId);
    if (!slug) {
      return null;
    }
    return () => {
      router.push({
        pathname: '/u/[handle]',
        params: { handle: slug, userId: otherUser?.userId ?? '' },
      } as never);
    };
  }, [otherUser?.handle, otherUser?.userId, router]);

  /*
    ONE status line, under your NEWEST outgoing message — the Messenger shape.
    Delivered-but-unread shows "Sent 2h ago"; once their cursor passes it, the
    text is replaced by a tiny avatar of the reader.

    Per-bubble receipts turn a thread into a column of status text, and they say
    nothing extra: read state is a CURSOR, so if your last message is seen,
    every earlier one is too. Anchoring to the newest also means the line moves
    down as you send rather than accumulating.

    `pending`/`failed` rows are excluded: an unsent message cannot have been
    read, and a delivery footer next to "Not sent" is a contradiction.

    `seen` is false — not absent — when the read state is unavailable (groups,
    half-created threads): delivery is still a fact worth confirming even where
    "seen" has no single answer.
  */
  const deliveryStatus = useMemo(() => {
    if (myUserId === null) {
      return null;
    }
    const readAt = otherLastReadAt === null ? Number.NaN : Date.parse(otherLastReadAt);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.senderId !== myUserId || message.pending || message.failed) {
        continue;
      }
      const sentAt = Date.parse(message.createdAt);
      return {
        messageId: message.id,
        seen: !Number.isNaN(readAt) && !Number.isNaN(sentAt) && readAt >= sentAt,
      };
    }
    return null;
  }, [messages, myUserId, otherLastReadAt]);

  /*
    Which messages open a new time block. Computed over the whole thread once
    rather than per row, so `renderItem` stays a pure lookup and does not need
    the message list in its dependencies.

    A day change always stamps, even when the gap is short: two messages twenty
    minutes apart across midnight are a different day to a reader, and the
    hour threshold alone would say nothing.
  */
  const timeSeparatorIds = useMemo(() => {
    const ids = new Set<string>();
    let previousAt: number | null = null;
    for (const message of messages) {
      const at = Date.parse(message.createdAt);
      if (Number.isNaN(at)) {
        continue;
      }
      const startsBlock =
        previousAt === null
        || at - previousAt >= TIME_SEPARATOR_GAP_MS
        || new Date(at).toDateString() !== new Date(previousAt).toDateString();
      if (startsBlock) {
        ids.add(message.id);
      }
      previousAt = at;
    }
    return ids;
  }, [messages]);

  const renderItem = useCallback(
    ({ item }: { item: ThreadMessage }) => {
      // A locally-created entry is always mine, which keeps the optimistic bubble
      // on the right even before auth has resolved a user id.
      const isMine = item.id.startsWith(LOCAL_ID_PREFIX) || (myUserId !== null && item.senderId === myUserId);
      // A blocked thread takes the retry away rather than leaving a permanent
      // "tap to try again" on a send that can never land. The bubble itself
      // stays — the words someone typed are still theirs to see.
      const canRetry = item.failed === true && !isBlocked;
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
      /*
        Either attachment card draws its own neutral surface, so any body text
        below it is a caption on white — not on the sender's purple tint. Both
        the text colour AND the link colour follow the SURFACE, which is the
        distinction that made a shared link invisible on an own-message bubble.
      */
      const hasAttachment = Boolean(item.sharedPostId || item.sharedProfileUserId);

      return (
        /*
          Column wrapper so the delivery footer sits UNDER the bubble rather
          than beside it — the row inside is horizontal for the avatar, so a
          footer sibling there would land at the bubble's right edge.
        */
        <>
          {/*
            The time this block of conversation started, centred over it —
            Messenger's shape. It sits OUTSIDE the block wrapper so it spans the
            thread rather than aligning to whichever side sent the message.
          */}
          {timeSeparatorIds.has(item.id) ? (
            <Text
              style={[theme.typography.micro, styles.timeSeparator, { color: theme.colors.gray600 }]}
              testID={`${testID}-time-${item.id}`}
            >
              {formatTimeSeparator(item.createdAt)}
            </Text>
          ) : null}
          <View
            style={[styles.block, isMine ? styles.blockMine : styles.blockTheirs]}
            testID={`${testID}-row-${item.id}`}
          >
          <View style={styles.row}>
            {/*
              THEIR photo, on the left of THEIR bubble, and a second way through to
              their profile. Only on incoming messages: your own face beside every
              line you sent is noise, and there is nowhere useful for it to lead.
            */}
            {isMine ? null : (
              <Pressable
                accessibilityLabel={openProfile ? `View ${headerName}'s profile` : undefined}
                accessibilityRole={openProfile ? 'button' : undefined}
                disabled={!openProfile}
                onPress={openProfile ?? undefined}
                testID={`${testID}-row-${item.id}-avatar`}
              >
                <Avatar
                  initials={(headerName[0] ?? '?').toUpperCase()}
                  size={28}
                  uri={otherUser?.avatarUrl ?? undefined}
                />
              </Pressable>
            )}
            <Pressable
              accessibilityLabel={canRetry ? 'Retry sending' : undefined}
              accessibilityRole={canRetry ? 'button' : undefined}
              disabled={!canRetry}
              onPress={() => handleRetry(item)}
              testID={`${testID}-bubble-${item.id}`}
              style={[
                /*
                  NO BUBBLE CHROME AROUND EITHER ATTACHMENT. The card draws its own
                  surface, and wrapping it in the sender tint painted a solid
                  purple slab around someone else's photo — it read as a
                  strangely-shaped message rather than as a post. A shared post or
                  list is not a thing you said, it is a thing you pointed at, so it
                  looks the same on both sides of the thread. Text that came WITH
                  the attachment still gets its bubble, below the card.
  
                  This tested `item.sharedPostId` alone, so the shared-PROFILE card
                  shipped with a thick purple frame around it — the same mistake in
                  a second place, one layer out from the invisible-link one.
                */
                hasAttachment
                  ? styles.attachment
                  : [styles.bubble, { backgroundColor: bubbleColor, borderRadius: theme.radii.lg }],
                {
                  // A pending bubble is dimmed rather than replaced by a spinner:
                  // the text stays readable and the row doesn't reflow when it lands.
                  opacity: item.pending ? 0.6 : 1,
                },
              ]}
            >
              {/*
                A shared post renders as a preview instead of text. The message
                stores only an id — the preview is hydrated on every render, so a
                post removed, deleted or blocked since it was sent stops
                resolving on its own (social_22).
              */}
              {item.sharedProfileUserId && item.sharedProfileTab ? (
                <SharedProfileBubble
                  onOpen={(ownerId, sharedTab) =>
                    router.push(
                      `/u/${ownerId}${sharedTab === 'wishlist' ? '?tab=wishlist' : ''}` as never,
                    )
                  }
                  repository={spotlightRepository}
                  tab={item.sharedProfileTab}
                  testID={`dm-thread-shared-profile-${item.id}`}
                  userId={item.sharedProfileUserId}
                />
              ) : null}
              {item.sharedPostId ? (
                <SharedPostBubble
                  accessToken={accessToken}
                  apiBaseUrl={apiBaseUrl}
                  onOpen={(postId) => router.push(`/post/${postId}` as never)}
                  postId={item.sharedPostId}
                  testID={`dm-thread-shared-${item.id}`}
                  viewerUserId={myUserId}
                />
              ) : null}
              {item.body ? (
                // Shared profile/wishlist links in the body are tappable — that is
                // the whole point of sending one to a DM.
                <MessageBodyText
                  body={item.body}
                  /*
                    Follows the SURFACE, not the sender. Your own bubble is
                    `purple500`, so a purple link on it is invisible — which is
                    exactly how "sharing a wishlist just sends text" was reported.
                    With a shared-post card above, the caption sits on a neutral
                    surface again and purple is right.
                  */
                  linkColor={!hasAttachment && isMine ? theme.colors.gray0 : theme.colors.purple500}
                  style={[
                    theme.typography.body,
                    // With a card above it the text is a caption on a neutral
                    // surface, so it must not use the bubble's on-tint color.
                    { color: hasAttachment ? theme.colors.gray900 : bodyColor },
                    hasAttachment ? styles.attachmentCaption : null,
                  ]}
                  testID={`dm-thread-body-${item.id}`}
                />
              ) : null}
              {item.failed ? (
                <Text
                  style={[
                    theme.typography.micro,
                    styles.failedNote,
                    { color: theme.colors.dangerStrong },
                  ]}
                  testID={`${testID}-failed-${item.id}`}
                >
                  {canRetry ? 'Not sent — tap to try again' : 'Not sent'}
                </Text>
              ) : null}
            </Pressable>
          </View>
          {deliveryStatus && item.id === deliveryStatus.messageId ? (
            deliveryStatus.seen ? (
              /*
                Their face, tiny, where the "Seen" text used to be — the
                Messenger read receipt. The avatar answers WHO saw it without a
                word, and the accessibility label restores the word for readers.
              */
              <View
                accessibilityLabel={`Seen by ${headerName}`}
                style={styles.seenReceipt}
                testID={`${testID}-seen-${item.id}`}
              >
                <Avatar
                  initials={(headerName[0] ?? '?').toUpperCase()}
                  size={SEEN_RECEIPT_SIZE}
                  uri={otherUser?.avatarUrl ?? undefined}
                />
              </View>
            ) : (
              <Text
                style={[theme.typography.micro, styles.seenNote, { color: theme.colors.gray600 }]}
                testID={`${testID}-sent-${item.id}`}
              >
                {formatSentAgo(item.createdAt)}
              </Text>
              )
            ) : null}
          </View>
        </>
      );
    },
    [
      accessToken,
      apiBaseUrl,
      deliveryStatus,
      handleRetry,
      headerName,
      isBlocked,
      myUserId,
      openProfile,
      otherUser?.avatarUrl,
      timeSeparatorIds,
      router,
      testID,
      theme,
    ],
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
        {/*
          WHO YOU ARE TALKING TO, and a way through to them. The header was a
          bare name string, which made the thread the one social surface in the
          app where a person's name was dead text.

          The whole block is one target — photo and name together — because they
          name the same person; splitting them into two adjacent taps that go to
          the same place only makes each one smaller.
        */}
        <Pressable
          accessibilityLabel={openProfile ? `View ${headerName}'s profile` : undefined}
          accessibilityRole={openProfile ? 'button' : undefined}
          disabled={!openProfile}
          onPress={openProfile ?? undefined}
          style={({ pressed }) => [styles.headerIdentity, { opacity: pressed ? 0.7 : 1 }]}
          testID={`${testID}-header-identity`}
        >
          <Avatar
            initials={(headerName[0] ?? '?').toUpperCase()}
            size={32}
            testID={`${testID}-header-avatar`}
            uri={otherUser?.avatarUrl ?? undefined}
          />
          <View style={styles.headerCopy}>
            <Text numberOfLines={1} style={theme.typography.titleXsmall}>
              {headerName}
            </Text>
            {otherUser?.handle ? (
              <Text
                numberOfLines={1}
                style={[theme.typography.caption, { color: theme.colors.gray500 }]}
              >
                @{otherUser.handle}
              </Text>
            ) : null}
          </View>
        </Pressable>
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
          /*
            ─────────────────────────────────────────────────────────────────
            THE WHOLE PAGE IN THE FIRST PASS. THIS IS NOT A PERF TWEAK.
            ─────────────────────────────────────────────────────────────────
            Reported as "it loads the text messages first, and then all of a
            sudden the shared ones appear".

            That is virtualization, not loading. This list is TOP-ANCHORED and
            corrected by a scroll, and RN's default `initialNumToRender` is 10 —
            so the first pass rendered the ten OLDEST rows, `onContentSizeChange`
            measured a height that only counted those ten, and the pin aimed at
            it. FlatList then rendered the remaining batches, each one growing
            the content height and firing another pin. The newest messages —
            which is where a shared card usually is — are in those later batches.

            With text-only rows the batches are short and it settles invisibly.
            A shared card is ~390pt, so each one arriving moved the thread under
            the reader. Rendering the full page up front makes the first
            measurement final: one pin, no later growth, nothing to watch.

            Affordable precisely because a thread is BOUNDED — `fetchMessages`
            takes the newest `DEFAULT_MESSAGE_LIMIT` and this screen does not
            paginate, so "the whole page" is at most 50 rows and never grows.
            If older-message pagination is ever added, this stops being safe.
          */
          initialNumToRender={DEFAULT_MESSAGE_LIMIT}
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
          // load, a sent message, a refresh) has to pin the view there. This is
          // also the earliest moment a just-sent row can be scrolled to, because
          // it is the first point at which the list has measured it.
          onContentSizeChange={(_width, height) => {
            // Record BEFORE pinning: this is the measurement the pin aims at.
            contentHeightRef.current = height;
            const animated = pinAfterSendRef.current;
            pinAfterSendRef.current = false;
            // Animated only for your OWN send, where the motion reads as "your
            // message went there". Everything else (first load, a refresh, an
            // incoming message) jumps, so the thread never appears to drift on
            // its own.
            scrollToLatest(animated);
          }}
          // The VIEWPORT changing has to re-pin too, and it does not touch
          // content size: the keyboard opening or closing makes the list shorter
          // or taller, which silently moves the bottom out from under the newest
          // message. `onContentSizeChange` cannot see that.
          onLayout={() => scrollToLatest(false)}
          ref={listRef}
          /*
            Hidden until the first pin lands — see `isPinned`. An empty thread is
            shown immediately, because there is nothing to pin and its empty
            state would otherwise never appear.

            Opacity rather than not mounting the list: it still has to lay out
            and measure to BE pinned, and a list that isn't mounted can do
            neither. This hides the corrective scroll, it does not defer it.
          */
          // Latched — see `hasRevealed`. Never recomputed back to hidden.
          style={{ opacity: hasRevealed ? 1 : 0 }}
          refreshControl={<RefreshControl onRefresh={handleRefresh} refreshing={isRefreshing} />}
          renderItem={renderItem}
          testID={`${testID}-list`}
        />

        {isBlocked ? (
          /*
            The composer is REPLACED, not disabled in place. A greyed-out field
            with a dead send button invites tapping it to find out why; one line
            where the field was answers the question before it is asked.

            Plain centred text rather than a StateCard, matching the empty-thread
            prompt above — a card would frame this as a failure to load.

            The wording is direction-blind ON PURPOSE. It reads identically
            whether you blocked them or they blocked you, because the schema
            hides the second case from the client deliberately (`blocks_all` is
            scoped to `blocker_id = auth.uid()`), and a message that let someone
            infer they had been blocked is exactly the retaliation trigger that
            scoping exists to prevent. No explanation of who, and no advice.

            The thread above stays mounted, scrollable and refreshable — reading
            and reporting the history is the reason a block freezes a DM instead
            of hiding it.
          */
          <View
            style={[styles.blockedNotice, { borderTopColor: theme.colors.outlineSubtle }]}
            testID={`${testID}-blocked`}
          >
            <Text
              style={[theme.typography.label, styles.blockedText, { color: theme.colors.gray600 }]}
            >
              You can&apos;t reply to this conversation.
            </Text>
          </View>
        ) : (
          <View style={[styles.composer, { borderTopColor: theme.colors.outlineSubtle }]}>
            <View style={styles.composerField}>
              <TextField
                inputStyle={styles.composerInput}
                /*
                  MULTILINE, AND THE RETURN KEY IS A RETURN KEY.

                  It was `returnKeyType="send"` with `onSubmitEditing`, so the
                  keyboard offered a blue Send where every other chat app offers
                  a newline — and there was no way to write a second line at all.
                  Sending is the button's job; the keyboard's job is typing.

                  With `multiline` the default submit behaviour is already
                  'newline', so nothing has to force it.
                */
                multiline
                onChangeText={setDraft}
                // The keyboard shortens the list without changing its content, so
                // onContentSizeChange never fires and the newest message ends up
                // hidden behind the keyboard.
                onFocus={() => requestAnimationFrame(() => scrollToLatest(true))}
                ref={composerRef}
                placeholder="Message…"
                testID={`${testID}-input`}
                value={draft}
              />
            </View>
            <Pressable
              accessibilityLabel="Send message"
              accessibilityRole="button"
              disabled={!canSend}
              hitSlop={8}
              onPress={() => {
                // Already sent on touch-down; this is the VoiceOver path only.
                if (sentOnTouchDownRef.current) {
                  sentOnTouchDownRef.current = false;
                  return;
                }
                handleSend();
              }}
              onPressIn={() => {
                sentOnTouchDownRef.current = true;
                handleSend();
              }}
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
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  // Stands in for the composer, so it carries the composer's top rule and its
  // horizontal gutter. Vertical padding is larger because there is no 36pt
  // control inside to give the strip its height.
  blockedNotice: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
  blockedText: {
    textAlign: 'center',
  },
  // A shared post carries no bubble: the card is the surface. Only the gap, so
  // a caption sent with it does not touch the card's bottom edge.
  attachment: {
    gap: 4,
  },
  attachmentCaption: {
    paddingHorizontal: 2,
  },
  bubble: {
    gap: 2,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  timeSeparator: {
    // Spans the thread and centres, rather than aligning to whichever side sent
    // the next message — it dates the CONVERSATION, not one person's turn.
    alignSelf: 'stretch',
    /*
      SYMMETRIC AT 16, AND THE TWO NUMBERS DIFFER FOR A REASON.

      The stamp shares a row with the message beneath it, so nothing separates
      the two but this padding — while ABOVE it the list's own `gap: 8` between
      rows is already doing half the work. Equal padding therefore reads
      unequal: at 12/4 it measured 20 above and 4 below, and looked glued to the
      message under it.

      8 + the list's 8 = 16 above, 16 below. Change `listContent.gap` and this
      has to move with it.
    */
    paddingBottom: 16,
    paddingTop: 8,
    textAlign: 'center',
  },
  seenNote: {
    // Under the bubble and on its side of the thread — the block wrapper's
    // `alignItems` puts it on the message's edge without a rule here.
    paddingHorizontal: 2,
    paddingTop: SEEN_ROW_GAP,
  },
  // Same footprint as the text footer it replaces, so seen ⇄ sent swaps
  // without the thread shifting. Both carry `SEEN_ROW_GAP` for that reason —
  // changing one alone makes the thread twitch on every receipt.
  seenReceipt: {
    paddingHorizontal: 2,
    paddingTop: SEEN_ROW_GAP,
  },
  failedNote: {
    paddingHorizontal: 2,
  },
  composer: {
    // Bottom-aligned, not centred: the field grows upward as lines are added and
    // the send button has to stay level with the LAST line, the way every chat
    // app draws it. Centred, the button drifted up the taller the draft got.
    alignItems: 'flex-end',
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  composerField: {
    flex: 1,
  },
  composerInput: {
    /*
      Roughly five lines, then it scrolls internally. Unbounded, a long draft
      pushes the thread off the top of the screen — you end up composing into a
      wall of your own text with no idea what you are replying to.
    */
    maxHeight: 120,
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
    // Bottom is deliberately larger than top: at 12 the newest bubble sat almost
    // flush against the composer's top border once scrolled to the end, which
    // read as the message being part of the input.
    paddingBottom: 20,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  // Message = a column of [avatar+bubble row, delivery footer]. The wrapper
  // owns the side of the thread; `alignItems` keeps the footer hugging the
  // bubble's outer edge, the way Messenger draws its receipt.
  block: {
    // A bubble never spans the full width — the free edge is what makes the
    // left/right split readable at a glance. Lives on the wrapper because a
    // percentage resolves against the list, not a content-sized parent.
    maxWidth: '80%',
  },
  blockMine: {
    alignItems: 'flex-end',
    alignSelf: 'flex-end',
  },
  blockTheirs: {
    alignItems: 'flex-start',
    alignSelf: 'flex-start',
  },
  row: {
    // Bottom-aligned so the avatar sits beside the LAST line of a multi-line
    // bubble, the way every messaging app draws it — top-aligned it floats away
    // from the text it belongs to.
    alignItems: 'flex-end',
    flexDirection: 'row',
    gap: 8,
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
  // Takes the slack between the back button and its mirror spacer, so a long
  // name truncates instead of pushing the row apart.
  headerCopy: {
    flexShrink: 1,
  },
  headerIdentity: {
    alignItems: 'center',
    flex: 1,
    flexDirection: 'row',
    gap: 8,
  },
});
