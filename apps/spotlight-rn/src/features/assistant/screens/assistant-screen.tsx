import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { ClockRotateRight, Sparks } from 'iconoir-react-native';
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
  AssistantMessage,
  AssistantProposedAction,
  AssistantThreadSummary,
  AssistantUsage,
} from '@spotlight/api-client';
import {
  Badge,
  Button,
  IconButton,
  InlineLoader,
  StateCard,
  Text,
  Toast,
  glassNavBubbleGlyphSize,
  layout,
  spacing,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { ChromeBackButton, chromeBackButtonSize } from '@/components/chrome-back-button';
import { runAssistantAction } from '@/features/assistant/assistant-action-runner';
import { assistantIntroCopy, assistantStarterPrompts } from '@/features/assistant/assistant-prompts';
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
const HEADER_GLYPH_SIZE = 20;
// Two 40pt header buttons + their gap; the left slot matches so the title centres.
const HEADER_SIDE_WIDTH = chromeBackButtonSize * 2 + spacing.xxs;
const INTRO_MARK_SIZE = 48;
const COPIED_TOAST_MS = 1500;
const REVEAL_FALLBACK_MS = 400;

export type AssistantScreenProps = {
  source: AssistantContextSource;
  /** Scanner tray card ids, sent as context with the first question. */
  cardIds?: string[];
  initialThreadId?: string | null;
  onBack: () => void;
  onOpenCard: (cardId: string) => void;
};

type ChatRow =
  | { kind: 'message'; key: string; message: AssistantMessage }
  | { kind: 'pending'; key: string; pending: AssistantPendingQuestion };

/** What the next content-size change should do with the scroll position. */
type ScrollIntent = 'none' | 'end' | 'jump' | 'reply';

export function usageLabel(usage: AssistantUsage | null): string | null {
  if (!usage || usage.limit == null || usage.remainingToday == null) {
    return null;
  }
  return `${usage.remainingToday} left today`;
}

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
}: AssistantScreenProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardVisible();
  const services = useAppServices();
  const { spotlightRepository: repository } = services;
  const { ensureGuestSession, isGuest, openLogin } = useGuestGate();
  const { getAccessToken } = useAuth();

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

  const deleteThread = useCallback(async (threadId: string) => {
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

  const handleDismissAction = useCallback((action: AssistantProposedAction) => {
    setActionState(action.id, { status: 'dismissed' });
    capturePostHogEvent(AnalyticsEvent.assistantActionDismissed, { type: action.type });
    void repository.setAssistantActionState(action.id, 'dismissed')
      .then(chat.replaceAction)
      .catch(() => undefined);
  }, [chat.replaceAction, repository, setActionState]);

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
          onOpenCard={onOpenCard}
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

  const recentThreads = threads.filter((thread) => thread.id !== chat.threadId).slice(0, 3);
  const pill = usageLabel(chat.usage);
  const starterPrompts = assistantStarterPrompts(source, cardIds.length);
  const intro = assistantIntroCopy(cardIds.length);
  const isSending = chat.pending?.status === 'sending';
  const hasConversation = rows.length > 0;
  const canStartNewChat = hasConversation || chat.threadId != null;

  const emptyState = chat.isLoadingThread ? (
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
      <View style={[styles.introMark, { backgroundColor: theme.colors.purple50 }]}>
        <Sparks color={theme.colors.purple500} height={glassNavBubbleGlyphSize} width={glassNavBubbleGlyphSize} />
      </View>
      <View style={styles.introCopy}>
        <Text style={[theme.typography.titleLarge, styles.centerText]}>{intro.title}</Text>
        <Text style={[theme.typography.bodyLarge, styles.centerText, { color: theme.colors.gray600 }]}>
          {intro.body}
        </Text>
      </View>
      {chat.isLimitReached ? null : (
        <AssistantPromptChips
          onSelect={(prompt) => void handleSend(prompt)}
          prompts={starterPrompts}
          style={styles.centeredChips}
          testID="assistant-suggestions"
          testIDPrefix="assistant-suggestion"
        />
      )}
      {recentThreads.length > 0 ? (
        <View style={styles.recent} testID="assistant-recent-chats">
          <Text style={[theme.typography.overline, { color: theme.colors.gray500 }]}>RECENT CHATS</Text>
          {recentThreads.map((thread) => (
            <Button
              key={thread.id}
              label={thread.title}
              labelStyleVariant="control"
              onPress={() => openSavedThread(thread.id)}
              size="xs"
              testID={`assistant-recent-${thread.id}`}
              variant="ghost"
            />
          ))}
        </View>
      ) : null}
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
      <View style={styles.header}>
        <View style={[styles.headerSide, styles.headerSideLeft]}>
          <ChromeBackButton
            accessibilityLabel={view === 'history' ? 'Back to chat' : 'Back'}
            onPress={view === 'history' ? () => setView('chat') : onBack}
            testID="assistant-back"
          />
        </View>
        <View style={styles.headerTitle}>
          <Text accessibilityRole="header" numberOfLines={1} style={theme.typography.titleSmall}>
            {view === 'history' ? 'Saved chats' : 'Ask Ekalight'}
          </Text>
          {pill && view === 'chat' ? <Badge label={pill} size="sm" testID="assistant-usage-pill" tone="brand" /> : null}
        </View>
        <View style={[styles.headerSide, styles.headerSideRight]}>
          {view === 'chat' ? (
            <>
              <IconButton
                accessibilityLabel="Saved chats"
                onPress={openHistory}
                size={chromeBackButtonSize}
                testID="assistant-open-history"
                variant="elevated"
              >
                <ClockRotateRight color={theme.colors.textPrimary} height={HEADER_GLYPH_SIZE} width={HEADER_GLYPH_SIZE} />
              </IconButton>
              {canStartNewChat ? (
                // A labeled button: a bare icon read as "edit", not "new chat" (owner, 2026-11-17).
                <Button
                  label="New chat"
                  labelStyleVariant="control"
                  onPress={startNewChat}
                  size="xs"
                  testID="assistant-new-chat"
                  variant="outline"
                />
              ) : null}
            </>
          ) : null}
        </View>
      </View>

      {view === 'history' ? (
        <AssistantThreadList
          activeThreadId={chat.threadId}
          bottomInset={insets.bottom}
          onClearAll={clearAll}
          onDeleteThread={(threadId) => void deleteThread(threadId)}
          onNewChat={startNewChat}
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
              <AssistantComposer
                isSending={isSending}
                maxLength={MAX_QUESTION_LENGTH}
                onChangeText={setDraft}
                onSend={() => void handleSend(draft)}
                value={draft}
              />
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
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xxs,
    paddingBottom: spacing.xxs,
    paddingHorizontal: layout.pageGutter,
  },
  headerSide: {
    flexDirection: 'row',
    gap: spacing.xxs,
    width: HEADER_SIDE_WIDTH,
  },
  headerSideLeft: {
    justifyContent: 'flex-start',
  },
  headerSideRight: {
    justifyContent: 'flex-end',
  },
  headerTitle: {
    alignItems: 'center',
    flex: 1,
    gap: spacing.xxxs,
  },
  listContent: {
    flexGrow: 1,
    gap: spacing.lg,
    paddingHorizontal: layout.pageGutter,
    paddingVertical: spacing.sm,
  },
  listContentEmpty: {
    justifyContent: 'center',
  },
  intro: {
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.lg,
  },
  introMark: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: INTRO_MARK_SIZE / 2,
    height: INTRO_MARK_SIZE,
    justifyContent: 'center',
    width: INTRO_MARK_SIZE,
  },
  introCopy: {
    gap: spacing.xxs,
    paddingHorizontal: spacing.xs,
  },
  centerText: {
    textAlign: 'center',
  },
  centeredChips: {
    justifyContent: 'center',
  },
  recent: {
    alignItems: 'center',
    gap: spacing.xxxs,
    paddingTop: spacing.xs,
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
});
