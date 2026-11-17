import { ClockRotateRight, EditPencil, SendDiagonal } from 'iconoir-react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  View,
} from 'react-native';
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
  PillButton,
  StateCard,
  Text,
  TextField,
  layout,
  spacing,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { ChromeBackButton } from '@/components/chrome-back-button';
import { runAssistantAction } from '@/features/assistant/assistant-action-runner';
import type { AssistantActionUiState } from '@/features/assistant/components/assistant-action-card';
import { AssistantMessageBubble, UserBubble } from '@/features/assistant/components/assistant-message-bubble';
import { AssistantThreadList } from '@/features/assistant/components/assistant-thread-list';
import {
  assistantErrorCopy,
  useAssistantChat,
  type AssistantPendingQuestion,
} from '@/features/assistant/use-assistant-chat';
import { useGuestGate } from '@/features/auth/use-guest-gate';
import { AnalyticsEvent } from '@/lib/observability/analytics-events';
import { capturePostHogEvent } from '@/lib/observability/posthog';
import { useAppServices } from '@/providers/app-providers';
import { useAuth } from '@/providers/auth-provider';

const MAX_QUESTION_LENGTH = 1000;
// Glyphs in the header's ghost buttons, matching the DM composer's send glyph.
const HEADER_GLYPH_SIZE = 20;

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

function suggestionsFor(source: AssistantContextSource, hasTrayCards: boolean): string[] {
  if (source === 'scanner' && hasTrayCards) {
    return ['Which of these is worth the most?', 'Are any of these worth grading?', 'Add these to my collection'];
  }
  return ["What's my collection worth?", 'What am I missing from my newest set?', 'Which of my cards went up this week?'];
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
  const listRef = useRef<FlatList<ChatRow>>(null);
  const limitReportedRef = useRef(false);

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

  const renderRow = useCallback(({ item }: { item: ChatRow }) => {
    if (item.kind === 'message') {
      return (
        <AssistantMessageBubble
          actionStates={actionStates}
          message={item.message}
          onConfirmAction={handleConfirmAction}
          onDismissAction={handleDismissAction}
          onOpenCard={onOpenCard}
        />
      );
    }
    const { pending } = item;
    if (pending.status === 'sending') {
      return (
        <View style={styles.pendingGroup}>
          <UserBubble testID="assistant-pending-question" text={pending.text} />
          <InlineLoader
            label={source === 'scanner' ? 'Checking these cards…' : 'Checking your collection…'}
            style={styles.typing}
            testID="assistant-sending"
          />
        </View>
      );
    }
    return (
      <UserBubble
        dimmed
        footer={
          <View style={styles.failedRow} testID="assistant-send-failed">
            <Text style={[theme.typography.caption, { color: theme.colors.dangerStrong }]}>
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
  }, [actionStates, chat, handleConfirmAction, handleDismissAction, onOpenCard, source, theme]);

  const pill = usageLabel(chat.usage);
  const suggestions = suggestionsFor(source, cardIds.length > 0);
  const canSend = draft.trim().length > 0 && chat.pending?.status !== 'sending';

  const emptyState = chat.isLoadingThread ? (
    <InlineLoader style={styles.typing} testID="assistant-thread-loading" />
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
      <Text style={theme.typography.titleSmall}>Ask about your cards</Text>
      <Text style={[theme.typography.body, { color: theme.colors.gray600 }]}>
        {source === 'scanner' && cardIds.length > 0
          ? `I can see the ${cardIds.length} ${cardIds.length === 1 ? 'card' : 'cards'} in your tray.`
          : 'Prices, what you own, what you are missing, and your Watchlist.'}
      </Text>
      {chat.isLimitReached ? null : (
        <View style={styles.suggestions}>
          {suggestions.map((suggestion, index) => (
            <PillButton
              key={suggestion}
              label={suggestion}
              onPress={() => void handleSend(suggestion)}
              testID={`assistant-suggestion-${index}`}
              tone="soft"
            />
          ))}
        </View>
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
      <View style={styles.header}>
        <ChromeBackButton
          accessibilityLabel={view === 'history' ? 'Back to chat' : 'Back'}
          onPress={view === 'history' ? () => setView('chat') : onBack}
          testID="assistant-back"
        />
        <View style={styles.headerTitle}>
          <Text numberOfLines={1} style={theme.typography.titleSmall}>
            {view === 'history' ? 'Saved chats' : 'Ask Ekalight'}
          </Text>
          {pill && view === 'chat' ? <Badge label={pill} size="sm" testID="assistant-usage-pill" tone="brand" /> : null}
        </View>
        {view === 'chat' ? (
          <View style={styles.headerActions}>
            <IconButton accessibilityLabel="Saved chats" onPress={openHistory} testID="assistant-open-history" variant="ghost">
              <ClockRotateRight color={theme.colors.gray900} height={HEADER_GLYPH_SIZE} width={HEADER_GLYPH_SIZE} />
            </IconButton>
            <IconButton accessibilityLabel="New chat" onPress={startNewChat} testID="assistant-new-chat" variant="ghost">
              <EditPencil color={theme.colors.gray900} height={HEADER_GLYPH_SIZE} width={HEADER_GLYPH_SIZE} />
            </IconButton>
          </View>
        ) : null}
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
          <FlatList
            ListEmptyComponent={emptyState}
            contentContainerStyle={styles.listContent}
            data={rows}
            keyExtractor={(item) => item.key}
            keyboardShouldPersistTaps="handled"
            onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
            ref={listRef}
            renderItem={renderRow}
            testID="assistant-messages"
          />
          <View
            style={[
              styles.composer,
              { borderTopColor: theme.colors.outlineSubtle, paddingBottom: Math.max(insets.bottom, spacing.xxs) },
            ]}
          >
            {chat.isLimitReached ? (
              limitBlock
            ) : (
              <View style={styles.composerRow}>
                <View style={styles.flex}>
                  <TextField
                    maxLength={MAX_QUESTION_LENGTH}
                    multiline
                    onChangeText={setDraft}
                    placeholder="Ask about your cards…"
                    testID="assistant-input"
                    value={draft}
                  />
                </View>
                <IconButton
                  accessibilityLabel="Send question"
                  disabled={!canSend}
                  onPress={() => void handleSend(draft)}
                  testID="assistant-send"
                  variant={canSend ? 'brand' : 'subtle'}
                >
                  <SendDiagonal color={theme.colors.gray900} height={18} width={18} />
                </IconButton>
              </View>
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
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xxs,
    paddingBottom: spacing.xxs,
    paddingHorizontal: layout.pageGutter,
  },
  headerTitle: {
    alignItems: 'center',
    flex: 1,
    flexDirection: 'row',
    gap: spacing.xxs,
  },
  headerActions: {
    flexDirection: 'row',
    gap: spacing.xxxs,
  },
  listContent: {
    gap: spacing.sm,
    paddingHorizontal: layout.pageGutter,
    paddingVertical: spacing.sm,
  },
  intro: {
    gap: spacing.xxs,
    paddingTop: spacing.lg,
  },
  suggestions: {
    alignItems: 'flex-start',
    gap: spacing.xxs,
    paddingTop: spacing.xxs,
  },
  pendingGroup: {
    gap: spacing.xs,
  },
  typing: {
    alignSelf: 'flex-start',
  },
  failedRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xxs,
  },
  composer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: layout.pageGutter,
    paddingTop: spacing.xxs,
  },
  composerRow: {
    alignItems: 'flex-end',
    flexDirection: 'row',
    gap: spacing.xxs,
  },
});
