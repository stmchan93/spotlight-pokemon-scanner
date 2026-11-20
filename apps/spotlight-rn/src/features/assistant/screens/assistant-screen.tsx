import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { ClockRotateRight, NavArrowLeft, Xmark } from 'iconoir-react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import Animated from 'react-native-reanimated';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import type {
  AssistantContextSource,
  AssistantFeedbackInput,
  AssistantMessage,
  AssistantProposedAction,
  AssistantThreadSummary,
} from '@spotlight/api-client';
import {
  Button,
  GlassNavBubble,
  GlassNavPill,
  InlineLoader,
  StateCard,
  Text,
  Toast,
  glassNavBubbleGlyphSize,
  glassNavBubbleGlyphStrokeWidth,
  layout,
  spacing,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { EkalightMark } from '@/components/ekalight-mark';
import {
  refreshAfterExecutedAdd,
  runAssistantAction,
  undoExecutedAdd,
} from '@/features/assistant/assistant-action-runner';
import {
  assistantCardContextLine,
  assistantGreeting,
  assistantRemainingCaption,
  assistantStarterPrompts,
} from '@/features/assistant/assistant-prompts';
import type { AssistantActionUiState } from '@/features/assistant/components/assistant-action-card';
import { AssistantComposer } from '@/features/assistant/components/assistant-composer';
import {
  AssistantMessageBubble,
  UserBubble,
  assistantRowEntering,
} from '@/features/assistant/components/assistant-message-bubble';
import { AssistantPromptChips } from '@/features/assistant/components/assistant-prompt-chips';
import { AssistantThinkingIndicator } from '@/features/assistant/components/assistant-thinking-indicator';
import { AssistantThreadList } from '@/features/assistant/components/assistant-thread-list';
import {
  assistantErrorCopy,
  useAssistantChat,
  type AssistantPendingQuestion,
} from '@/features/assistant/use-assistant-chat';
import { useGuestGate } from '@/features/auth/use-guest-gate';
import { AnalyticsEvent } from '@/lib/observability/analytics-events';
import { capturePostHogEvent } from '@/lib/observability/posthog';
import { useKeyboardVisible } from '@/lib/use-keyboard-visible';
import { useAppServices } from '@/providers/app-providers';
import { useAuth } from '@/providers/auth-provider';

const MAX_QUESTION_LENGTH = 1000;
// The purple Ekalight mark on a new chat (Figma 6502:16508: 52x48, Color/purple/500).
const INTRO_MARK_WIDTH = 52;
const INTRO_MARK_HEIGHT = 48;
const COPIED_TOAST_MS = 1500;
const REVEAL_FALLBACK_MS = 400;

export type AssistantScreenProps = {
  source: AssistantContextSource;
  /** Scanner tray card ids, sent as context with the first question. */
  cardIds?: string[];
  initialThreadId?: string | null;
  onBack: () => void;
  onOpenCard: (cardId: string) => void;
  /** "View all N" under a Watchlist preview. */
  onOpenWatchlist?: () => void;
};

type ChatRow =
  | { kind: 'message'; key: string; message: AssistantMessage }
  | { kind: 'pending'; key: string; pending: AssistantPendingQuestion };

/** What the next content-size change should do with the scroll position. */
type ScrollIntent = 'none' | 'end' | 'jump' | 'reply';

function resetTimeLabel(resetsAt: string | null): string {
  const date = resetsAt ? new Date(resetsAt) : null;
  if (!date || Number.isNaN(date.getTime())) {
    return 'tomorrow';
  }
  return `at ${date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
}

export function AssistantScreen({
  source,
  cardIds = [],
  initialThreadId = null,
  onBack,
  onOpenCard,
  onOpenWatchlist,
}: AssistantScreenProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardVisible();
  const services = useAppServices();
  const { spotlightRepository: repository } = services;
  const { ensureGuestSession, isGuest, openLogin } = useGuestGate();
  const { currentUser, getAccessToken } = useAuth();

  const context = useMemo(
    () => ({ source, ...(cardIds.length > 0 ? { cardIds } : {}) }),
    // cardIds is a fresh array per render from the route; key on its contents.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- content-keyed
    [source, cardIds.join(',')],
  );
  const ensureIdentity = useCallback(async () => {
    // A guest has no user until the first authed action; asking IS that action.
    if (isGuest) {
      return (await ensureGuestSession()) != null;
    }
    return true;
  }, [ensureGuestSession, isGuest]);

  const chat = useAssistantChat({
    repository,
    context,
    initialThreadId,
    ensureIdentity,
    // Don't read usage for a not-yet-minted guest: there is no identity yet.
    canReadOnOpen: !isGuest || Boolean(getAccessToken()),
  });

  const [draft, setDraft] = useState('');
  const [view, setView] = useState<'chat' | 'history'>('chat');
  const [threads, setThreads] = useState<AssistantThreadSummary[]>([]);
  const [threadsStatus, setThreadsStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [actionStates, setActionStates] = useState<Record<string, AssistantActionUiState>>({});
  const [copiedVisible, setCopiedVisible] = useState(false);
  // A loaded history is hidden for the frame between its first paint (at the
  // top) and the jump to its end, so opening a chat never visibly scrolls.
  const [awaitingJump, setAwaitingJump] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const limitReportedRef = useRef(false);
  const scrollIntentRef = useRef<ScrollIntent>('none');
  const viewportHeightRef = useRef(0);
  const rowOffsetsRef = useRef(new Map<string, { y: number; height: number }>());

  useEffect(() => {
    capturePostHogEvent(AnalyticsEvent.assistantOpened, { source });
  }, [source]);

  const isGuestLimited = chat.isLimitReached && (chat.usage?.isGuest ?? isGuest);
  useEffect(() => {
    if (chat.isLimitReached && !limitReportedRef.current) {
      limitReportedRef.current = true;
      capturePostHogEvent(AnalyticsEvent.assistantLimitHit, { is_guest: chat.usage?.isGuest ?? isGuest });
    }
  }, [chat.isLimitReached, chat.usage, isGuest]);

  // ---- Scroll: the newest exchange stays in view without fighting the reader.
  useEffect(() => {
    // A loaded history lands at its end with no visible scroll.
    if (!chat.isLoadingThread && chat.messages.length > 0 && chat.lastReplyId == null) {
      scrollIntentRef.current = 'jump';
      setAwaitingJump(true);
    }
    // Only a load completing (not every new message) should jump.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.isLoadingThread]);

  useEffect(() => {
    if (chat.lastReplyId) {
      scrollIntentRef.current = 'reply';
    }
  }, [chat.lastReplyId]);

  useEffect(() => {
    if (chat.pending) {
      scrollIntentRef.current = 'end';
    }
  }, [chat.pending]);

  const scrollToEnd = useCallback((animated: boolean) => {
    scrollRef.current?.scrollToEnd({ animated });
  }, []);

  useEffect(() => {
    if (keyboardVisible) {
      // The keyboard shortens the list without changing its content.
      requestAnimationFrame(() => scrollToEnd(true));
    }
  }, [keyboardVisible, scrollToEnd]);

  /**
   * Runs the pending scroll intent once the layout it needs exists. Called from
   * both the content-size change and the reply row's own layout, because either
   * can land first; a 'reply' intent waits until the reply has been measured.
   */
  const applyScrollIntent = useCallback(() => {
    const intent = scrollIntentRef.current;
    if (intent === 'none') {
      return;
    }
    if (intent === 'reply' && chat.lastReplyId) {
      const reply = rowOffsetsRef.current.get(chat.lastReplyId);
      if (!reply) {
        return;
      }
      scrollIntentRef.current = 'none';
      // A reply taller than the screen is read from its top, like Claude/ChatGPT:
      // park the question at the top instead of dropping the reader at the end.
      const viewport = viewportHeightRef.current;
      if (viewport > 0 && reply.height > viewport - spacing.xxxl) {
        const question = chat.messages[chat.messages.length - 2];
        const questionRow = question ? rowOffsetsRef.current.get(question.id) : undefined;
        const top = Math.max(0, (questionRow?.y ?? reply.y) - spacing.sm);
        scrollRef.current?.scrollTo({ animated: true, y: top });
        return;
      }
      scrollToEnd(true);
      return;
    }
    scrollIntentRef.current = 'none';
    scrollToEnd(intent !== 'jump');
    if (intent === 'jump') {
      requestAnimationFrame(() => setAwaitingJump(false));
    }
  }, [chat.lastReplyId, chat.messages, scrollToEnd]);

  useEffect(() => {
    if (!awaitingJump) {
      return undefined;
    }
    // Never leave a chat invisible if no content-size change arrives.
    const timer = setTimeout(() => setAwaitingJump(false), REVEAL_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [awaitingJump]);

  const recordRowLayout = useCallback((key: string, event: LayoutChangeEvent) => {
    const { y, height } = event.nativeEvent.layout;
    rowOffsetsRef.current.set(key, { y, height });
    if (key === chat.lastReplyId) {
      applyScrollIntent();
    }
  }, [applyScrollIntent, chat.lastReplyId]);

  const handleSend = useCallback(async (text: string) => {
    const question = text.trim();
    if (!question || chat.pending?.status === 'sending' || chat.isLimitReached) {
      return;
    }
    setDraft('');
    capturePostHogEvent(AnalyticsEvent.assistantQuestionSent, { source });
    const outcome = await chat.send(question.slice(0, MAX_QUESTION_LENGTH));
    if (outcome === 'limit') {
      // Not answered and not charged: give the words back.
      setDraft(question);
    }
  }, [chat, source]);

  const handleCopy = useCallback((text: string) => {
    void Clipboard.setStringAsync(text)
      .then(() => {
        void Haptics.selectionAsync().catch(() => undefined);
        setCopiedVisible(true);
      })
      .catch(() => undefined);
  }, []);

  const loadThreads = useCallback(async () => {
    setThreadsStatus('loading');
    try {
      const page = await repository.listAssistantThreads({ limit: 50 });
      setThreads(page.threads);
      setThreadsStatus('ready');
    } catch {
      setThreadsStatus('error');
    }
  }, [repository]);

  // Reopening the chat continues the latest conversation instead of a blank one.
  // A scanner open with tray cards is a fresh question about those cards.
  const canReadOnOpen = !isGuest || Boolean(getAccessToken());
  const resumeLatest = !initialThreadId && !(source === 'scanner' && cardIds.length > 0);
  useEffect(() => {
    if (!canReadOnOpen) {
      return;
    }
    let cancelled = false;
    void (async () => {
      setThreadsStatus('loading');
      try {
        const page = await repository.listAssistantThreads({ limit: 50 });
        if (cancelled) {
          return;
        }
        setThreads(page.threads);
        setThreadsStatus('ready');
        const latest = page.threads[0];
        if (resumeLatest && latest) {
          void chat.openThread(latest.id);
        }
      } catch {
        if (!cancelled) {
          setThreadsStatus('error');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // Mount only: later thread switches go through openThread.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openHistory = useCallback(() => {
    setView('history');
    void loadThreads();
  }, [loadThreads]);

  const startNewChat = useCallback(() => {
    setView('chat');
    setActionStates({});
    void chat.openThread(null);
  }, [chat]);

  const openSavedThread = useCallback((threadId: string) => {
    setView('chat');
    setActionStates({});
    void chat.openThread(threadId);
  }, [chat]);

  const removeThread = useCallback(async (threadId: string) => {
    const previous = threads;
    setThreads((current) => current.filter((thread) => thread.id !== threadId));
    try {
      await repository.deleteAssistantThread(threadId);
      if (threadId === chat.threadId) {
        void chat.openThread(null);
      }
    } catch {
      setThreads(previous);
      Alert.alert("Couldn't delete that chat", 'Try again in a moment.');
    }
  }, [chat, repository, threads]);

  const deleteThread = useCallback((threadId: string) => {
    Alert.alert('Delete this chat?', "It's removed from your history.", [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => void removeThread(threadId) },
    ]);
  }, [removeThread]);

  const clearAll = useCallback(() => {
    Alert.alert('Clear all chats?', 'This deletes every saved chat with Ekalight.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear all',
        style: 'destructive',
        onPress: () => {
          void repository.deleteAllAssistantThreads()
            .then(() => {
              setThreads([]);
              void chat.openThread(null);
            })
            .catch(() => Alert.alert("Couldn't clear your chats", 'Try again in a moment.'));
        },
      },
    ]);
  }, [chat, repository]);

  const setActionState = useCallback((actionId: string, state: AssistantActionUiState) => {
    setActionStates((current) => ({ ...current, [actionId]: state }));
  }, []);

  const handleConfirmAction = useCallback(async (action: AssistantProposedAction, message: AssistantMessage) => {
    // Guests can't write to a collection anywhere in the app; same gate here.
    if (isGuest) {
      openLogin();
      return;
    }
    setActionState(action.id, { status: 'running' });
    const outcome = await runAssistantAction(action, {
      repository,
      activeCollectionID: services.activeCollectionID,
      inventoryEntriesCache: services.inventoryEntriesCache,
      prependOptimisticInventoryEntry: services.prependOptimisticInventoryEntry,
      removeOptimisticInventoryEntries: services.removeOptimisticInventoryEntries,
      refreshData: services.refreshData,
      watchlistStore: services.watchlistStore,
      cards: message.cards,
    });
    if (outcome.status === 'failed') {
      setActionState(action.id, { status: 'failed', message: outcome.message });
      return;
    }
    setActionState(action.id, { status: 'done' });
    capturePostHogEvent(AnalyticsEvent.assistantActionConfirmed, { type: action.type });
    // Bookkeeping only — the real write already landed, so a failed record
    // must not read as a failed action.
    void repository.setAssistantActionState(action.id, 'confirmed')
      .then(chat.replaceAction)
      .catch(() => undefined);
  }, [chat.replaceAction, isGuest, openLogin, repository, services, setActionState]);

  // A direct add was written server-side before the reply arrived: refresh the
  // same caches the Confirm path refreshes, once per action.
  const refreshedActionIdsRef = useRef(new Set<string>());
  const refreshData = services.refreshData;
  useEffect(() => {
    const reply = chat.messages.find((message) => message.id === chat.lastReplyId);
    for (const action of reply?.actions ?? []) {
      if (action.state === 'done' && !refreshedActionIdsRef.current.has(action.id)) {
        refreshedActionIdsRef.current.add(action.id);
        refreshAfterExecutedAdd(action, { refreshData });
        capturePostHogEvent(AnalyticsEvent.assistantActionConfirmed, { type: action.type, direct: true });
      }
    }
  }, [chat.lastReplyId, chat.messages, refreshData]);

  const replaceChatAction = chat.replaceAction;
  const handleUndoAction = useCallback(async (action: AssistantProposedAction) => {
    setActionState(action.id, { status: 'undoing' });
    const outcome = await undoExecutedAdd(action, { repository, refreshData });
    if (outcome.status === 'failed') {
      setActionState(action.id, { status: 'failed', message: outcome.message });
      return;
    }
    setActionState(action.id, { status: 'undone' });
    replaceChatAction(outcome.action);
    capturePostHogEvent(AnalyticsEvent.assistantActionUndone, { type: action.type });
  }, [refreshData, replaceChatAction, repository, setActionState]);

  const handleDismissAction = useCallback((action: AssistantProposedAction) => {
    setActionState(action.id, { status: 'dismissed' });
    capturePostHogEvent(AnalyticsEvent.assistantActionDismissed, { type: action.type });
    void repository.setAssistantActionState(action.id, 'dismissed')
      .then(chat.replaceAction)
      .catch(() => undefined);
  }, [chat.replaceAction, repository, setActionState]);

  const setChatFeedback = chat.setFeedback;
  const handleFeedback = useCallback((message: AssistantMessage, input: AssistantFeedbackInput) => {
    capturePostHogEvent(AnalyticsEvent.assistantFeedbackTapped, {
      rating: input.rating ?? 'cleared',
      reason: input.reason ?? null,
    });
    void setChatFeedback(message.id, input);
  }, [setChatFeedback]);

  const rows = useMemo<ChatRow[]>(() => {
    const messageRows: ChatRow[] = chat.messages.map((message) => ({ kind: 'message', key: message.id, message }));
    return chat.pending
      ? [...messageRows, { kind: 'pending', key: `pending-${chat.pending.clientMessageId}`, pending: chat.pending }]
      : messageRows;
  }, [chat.messages, chat.pending]);

  // Follow-ups belong to the conversation's newest reply only, and only while
  // the user can still ask.
  const latestMessage = chat.messages[chat.messages.length - 1];
  const followUps = !chat.pending && !chat.isLimitReached && latestMessage?.role === 'assistant'
    ? latestMessage.suggestions ?? []
    : [];

  const renderRow = (item: ChatRow) => {
    if (item.kind === 'message') {
      const isLatestReply = item.message.id === latestMessage?.id && followUps.length > 0;
      return (
        <AssistantMessageBubble
          actionStates={actionStates}
          animateEntrance={item.message.id === chat.lastReplyId}
          footer={isLatestReply ? (
            <AssistantPromptChips
              onSelect={(prompt) => void handleSend(prompt)}
              prompts={followUps}
              style={styles.followUps}
              testID="assistant-followups"
              testIDPrefix="assistant-followup"
            />
          ) : null}
          message={item.message}
          onConfirmAction={handleConfirmAction}
          onCopy={handleCopy}
          onDismissAction={handleDismissAction}
          onUndoAction={handleUndoAction}
          onFeedback={handleFeedback}
          onOpenCard={onOpenCard}
          onOpenWatchlist={onOpenWatchlist}
        />
      );
    }
    const { pending } = item;
    if (pending.status === 'sending') {
      return (
        <View style={styles.pendingGroup}>
          <UserBubble animateEntrance testID="assistant-pending-question" text={pending.text} />
          <Animated.View entering={assistantRowEntering}>
            <AssistantThinkingIndicator
              label={source === 'scanner' && cardIds.length > 0 ? 'Looking at your cards…' : 'Thinking…'}
              testID="assistant-sending"
            />
          </Animated.View>
        </View>
      );
    }
    return (
      <UserBubble
        dimmed
        footer={
          <View style={styles.failedRow} testID="assistant-send-failed">
            <Text style={[theme.typography.caption, styles.failedText, { color: theme.colors.dangerStrong }]}>
              {assistantErrorCopy(pending.errorCode)}
            </Text>
            <Button
              label="Retry"
              labelStyleVariant="control"
              onPress={() => void chat.retry()}
              size="xs"
              testID="assistant-retry"
              variant="outline"
            />
          </View>
        }
        testID="assistant-pending-question"
        text={pending.text}
      />
    );
  };

  const headerGlyph = {
    color: theme.colors.gray900,
    height: glassNavBubbleGlyphSize,
    strokeWidth: glassNavBubbleGlyphStrokeWidth,
    width: glassNavBubbleGlyphSize,
  };
  const remainingCaption = assistantRemainingCaption(chat.usage);
  const starterPrompts = assistantStarterPrompts(cardIds.length, source);
  const greeting = assistantGreeting(currentUser?.displayName, isGuest);
  const cardContextLine = assistantCardContextLine(cardIds.length);
  const isSending = chat.pending?.status === 'sending';
  const hasConversation = rows.length > 0;

  // Opening resumes the latest chat: until we know whether there is one, draw
  // nothing rather than flashing the greeting, then a spinner, then the chat
  // (owner, 2026-11-20: "it flickers after I open it").
  const resolvingOpen =
    resumeLatest && canReadOnOpen && !hasConversation && (threadsStatus === 'loading' || chat.isLoadingThread);

  const emptyState = resolvingOpen ? (
    <View testID="assistant-opening" />
  ) : chat.isLoadingThread ? (
    <InlineLoader testID="assistant-thread-loading" />
  ) : chat.threadError ? (
    <StateCard
      actionLabel="Try again"
      actionTestID="assistant-thread-retry"
      message="Check your connection and try again."
      onActionPress={() => void chat.openThread(chat.threadId)}
      testID="assistant-thread-error"
      title="Couldn't load this chat"
    />
  ) : (
    <View style={styles.intro} testID="assistant-intro">
      <View style={styles.introHead}>
        <EkalightMark
          color={theme.colors.purple500}
          height={INTRO_MARK_HEIGHT}
          testID="assistant-intro-mark"
          width={INTRO_MARK_WIDTH}
        />
        <Text style={[theme.typography.titleSmall, styles.centerText]} testID="assistant-greeting">
          {greeting}
        </Text>
        {cardContextLine ? (
          <Text style={[theme.typography.caption, styles.centerText, { color: theme.colors.gray600 }]}>
            {cardContextLine}
          </Text>
        ) : null}
      </View>
      {chat.isLimitReached ? null : (
        <AssistantPromptChips
          layout="stack"
          onSelect={(prompt) => void handleSend(prompt)}
          prompts={starterPrompts}
          testID="assistant-suggestions"
          testIDPrefix="assistant-suggestion"
        />
      )}
    </View>
  );

  const limitBlock = isGuestLimited ? (
    <StateCard
      actionLabel="Sign in"
      actionTestID="assistant-sign-in"
      message="You've used today's free question. Sign in to keep asking."
      onActionPress={openLogin}
      testID="assistant-limit-guest"
      title="Sign in to keep asking"
      variant="muted"
    />
  ) : (
    <StateCard
      message={`You've used today's ${chat.usage?.limit ?? 0} ${chat.usage?.limit === 1 ? 'question' : 'questions'}. More ${resetTimeLabel(chat.usage?.resetsAt ?? null)}.`}
      testID="assistant-limit"
      title="That's all for today"
      variant="muted"
    />
  );

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={[styles.flex, { backgroundColor: theme.colors.gray0 }]}>
      {view === 'history' ? (
        // Figma 6530:16826: back, centred HISTORY, CLEAR ALL.
        <View style={styles.header} testID="assistant-history-header">
          <GlassNavBubble
            accessibilityLabel="Back to chat"
            material="frost"
            onPress={() => setView('chat')}
            size="compact"
            testID="assistant-back"
          >
            <NavArrowLeft {...headerGlyph} />
          </GlassNavBubble>
          <View pointerEvents="none" style={styles.headerTitle}>
            <Text accessibilityRole="header" style={[theme.typography.titleXsmall, { color: theme.colors.gray900 }]}>
              HISTORY
            </Text>
          </View>
          <GlassNavPill
            accessibilityLabel="Clear all chats"
            disabled={threads.length === 0}
            label="CLEAR ALL"
            onPress={clearAll}
            testID="assistant-threads-clear-all"
          />
        </View>
      ) : (
        // Figma 6502:16506: close left; history + NEW CHAT right. No title, no usage badge.
        <View style={styles.header} testID="assistant-chat-header">
          <GlassNavBubble
            accessibilityLabel="Close"
            material="frost"
            onPress={onBack}
            size="compact"
            testID="assistant-back"
          >
            <Xmark {...headerGlyph} />
          </GlassNavBubble>
          <View style={styles.headerActions}>
            <GlassNavBubble
              accessibilityLabel="Chat history"
              material="frost"
              onPress={openHistory}
              size="compact"
              testID="assistant-open-history"
            >
              <ClockRotateRight {...headerGlyph} />
            </GlassNavBubble>
            <GlassNavPill
              accessibilityLabel="New chat"
              label="NEW CHAT"
              onPress={startNewChat}
              testID="assistant-new-chat"
            />
          </View>
        </View>
      )}

      {view === 'history' ? (
        <AssistantThreadList
          bottomInset={insets.bottom}
          onDeleteThread={deleteThread}
          onOpenThread={openSavedThread}
          onRetry={() => void loadThreads()}
          status={threadsStatus}
          threads={threads}
        />
      ) : (
        <KeyboardAvoidingView
          // Full-screen push, as in the DM thread: iOS needs `padding`, Android
          // resizes the window, which `height` matches.
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.flex}
        >
          <ScrollView
            contentContainerStyle={[styles.listContent, hasConversation ? null : styles.listContentEmpty]}
            keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
            keyboardShouldPersistTaps="handled"
            onContentSizeChange={applyScrollIntent}
            onLayout={(event) => {
              viewportHeightRef.current = event.nativeEvent.layout.height;
            }}
            ref={scrollRef}
            style={awaitingJump ? styles.hidden : null}
            testID="assistant-messages"
          >
            {hasConversation
              ? rows.map((row) => (
                  <View key={row.key} onLayout={(event) => recordRowLayout(row.key, event)}>
                    {renderRow(row)}
                  </View>
                ))
              : emptyState}
          </ScrollView>
          <Toast
            durationMs={COPIED_TOAST_MS}
            message="Copied"
            onDismiss={() => setCopiedVisible(false)}
            showDismiss={false}
            style={styles.toast}
            testID="assistant-copied"
            tone="dark"
            visible={copiedVisible}
          />
          <View
            style={[
              styles.composer,
              // Safe-area bottom only while the keyboard is down; over the
              // keyboard the home-indicator inset would be a dead gap.
              { paddingBottom: keyboardVisible ? spacing.xxs : Math.max(insets.bottom, spacing.xxs) },
            ]}
          >
            {chat.isLimitReached ? (
              limitBlock
            ) : (
              <>
                {remainingCaption ? (
                  <Text
                    style={[theme.typography.caption, styles.remaining, { color: theme.colors.gray600 }]}
                    testID="assistant-remaining"
                  >
                    {remainingCaption}
                  </Text>
                ) : null}
                <AssistantComposer
                  isSending={isSending}
                  maxLength={MAX_QUESTION_LENGTH}
                  onChangeText={setDraft}
                  onSend={() => void handleSend(draft)}
                  value={draft}
                />
              </>
            )}
          </View>
        </KeyboardAvoidingView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  hidden: {
    opacity: 0,
  },
  // Figma toolbar 6530:17088: 16pt sides, 8pt above and below the 40pt controls.
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: layout.pageGutter,
    paddingVertical: spacing.xxs,
  },
  headerActions: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
  },
  // Centred on the screen, not between the unequal side controls.
  headerTitle: {
    alignItems: 'center',
    bottom: 0,
    justifyContent: 'center',
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  // 16pt under the toolbar, 32pt between turns (Figma 6502:16657).
  listContent: {
    flexGrow: 1,
    gap: spacing.xxl,
    paddingHorizontal: layout.pageGutter,
    paddingVertical: spacing.sm,
  },
  listContentEmpty: {
    justifyContent: 'center',
  },
  // Mark + greeting 16pt apart; the prompts 32pt below (Figma 6530:17376).
  intro: {
    alignItems: 'center',
    gap: spacing.xxl,
    paddingVertical: spacing.lg,
  },
  introHead: {
    alignItems: 'center',
    gap: spacing.sm,
  },
  centerText: {
    textAlign: 'center',
  },
  followUps: {
    paddingTop: spacing.xxxs,
  },
  pendingGroup: {
    gap: spacing.sm,
  },
  failedRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xxs,
    justifyContent: 'flex-end',
  },
  failedText: {
    flexShrink: 1,
  },
  // Top of the thread: never under the composer or the keyboard.
  toast: {
    alignSelf: 'center',
    position: 'absolute',
    top: spacing.sm,
  },
  composer: {
    paddingHorizontal: layout.pageGutter,
    paddingTop: spacing.xxs,
  },
  remaining: {
    paddingBottom: spacing.xxs,
    textAlign: 'center',
  },
});
