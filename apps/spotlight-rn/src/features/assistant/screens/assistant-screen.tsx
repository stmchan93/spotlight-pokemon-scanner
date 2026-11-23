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
import { GestureDetector } from 'react-native-gesture-handler';
import Animated from 'react-native-reanimated';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { PullDownToDismiss, usePullDownToDismiss } from '@/components/pull-down-to-dismiss';
import type {
  AssistantCardRef,
  AssistantContextSource,
  AssistantFeedbackInput,
  AssistantMessage,
  AssistantPageContext,
  AssistantProposedAction,
  AssistantSetRef,
  AssistantThreadSummary,
  CardGame,
  CatalogSearchResult,
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
  assistantPagePrompts,
  assistantRemainingCaption,
  assistantStarterPrompts,
} from '@/features/assistant/assistant-prompts';
import { AssistantPageChip } from '@/features/assistant/components/assistant-page-chip';
import { assistantPageKey } from '@/features/assistant/page-context/assistant-page-context';
import {
  readThreadPageKey,
  rememberThreadPageKey,
} from '@/features/assistant/page-context/assistant-page-persistence';
import {
  assistantPhotoCardLabel,
  cropAssistantPhoto,
  deleteAssistantPhoto,
  identifyAssistantPhoto,
  pickAssistantPhoto,
  type AssistantPhotoAttachment,
  type AssistantPhotoSource,
} from '@/features/assistant/assistant-photo-scan';
import { assistantPrintingChoiceMessage } from '@/features/assistant/assistant-printing-choice';
import type { AssistantActionUiState } from '@/features/assistant/components/assistant-action-card';
import { AssistantComposer } from '@/features/assistant/components/assistant-composer';
import {
  AssistantPhotoBubbleThumb,
  AssistantPhotoChip,
} from '@/features/assistant/components/assistant-photo-attachment';
import { AssistantPhotoMatchSheet } from '@/features/assistant/components/assistant-photo-match-sheet';
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
// Mark + greeting sit 80pt under the toolbar (Figma 6607:11777); the list adds spacing.sm.
const INTRO_TOP_OFFSET = 80 - spacing.sm;
const COPIED_TOAST_MS = 1500;
const REVEAL_FALLBACK_MS = 400;

export type AssistantScreenProps = {
  source: AssistantContextSource;
  /** Scanner tray card ids, sent as context with the first question. */
  cardIds?: string[];
  /** The opening screen's game; the server scopes market-wide rankings to it. */
  game?: CardGame | null;
  initialThreadId?: string | null;
  onBack: () => void;
  onOpenCard: (cardId: string) => void;
  /** A set tile under a set-level answer: that set's page. */
  onOpenSet?: (set: AssistantSetRef) => void;
  /** "View all N" under a Watchlist preview. */
  onOpenWatchlist?: () => void;
  /**
   * The page the floating bubble opened the chat from: rides every turn as
   * `context.page`, shapes the starter chips and the "Looking at" chip, and
   * decides whether to continue the latest chat (same page) or start fresh.
   */
  page?: AssistantPageContext | null;
};

type ChatRow =
  | { kind: 'message'; key: string; message: AssistantMessage }
  | { kind: 'pending'; key: string; pending: AssistantPendingQuestion };

/** A photo in the composer: being identified, failed, or matched (top 5, one picked). */
type ComposerPhoto =
  | { status: 'identifying'; photoUri: string }
  | { status: 'failed'; photoUri: string }
  | { status: 'ready'; photoUri: string; candidates: CatalogSearchResult[]; selectedCardId: string };

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
  game = null,
  initialThreadId = null,
  onBack,
  onOpenCard,
  onOpenSet,
  onOpenWatchlist,
  page = null,
}: AssistantScreenProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardVisible();
  const services = useAppServices();
  const { spotlightRepository: repository } = services;
  const { ensureGuestSession, isGuest, openLogin } = useGuestGate();
  const { currentUser, getAccessToken } = useAuth();

  // "Looking at …" can be dismissed: the rest of this chat then goes without the page.
  const [pageDismissed, setPageDismissed] = useState(false);
  const activePage = pageDismissed ? null : page;
  const pageKey = page ? assistantPageKey(page) : null;
  const pageJson = activePage ? JSON.stringify(activePage) : '';
  const context = useMemo(
    () => ({
      source,
      ...(cardIds.length > 0 ? { cardIds } : {}),
      ...(game ? { game } : {}),
      ...(activePage ? { page: activePage } : {}),
    }),
    // cardIds / page are fresh per render from the route; key on their contents.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- content-keyed
    [source, cardIds.join(','), game, pageJson],
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
  const [photo, setPhoto] = useState<ComposerPhoto | null>(null);
  const photoRef = useRef(photo);
  photoRef.current = photo;
  const [matchSheetVisible, setMatchSheetVisible] = useState(false);
  // Every chat-photo crop this screen wrote; all deleted when it closes.
  const photoFilesRef = useRef(new Set<string>());
  // Only the newest pick's identification may land.
  const photoRunRef = useRef(0);
  useEffect(() => {
    const files = photoFilesRef.current;
    return () => {
      photoRunRef.current += 1;
      files.forEach((uri) => deleteAssistantPhoto(uri));
      files.clear();
    };
  }, []);
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
  // Slid up: swipe down anywhere closes it while the chat is scrolled to the top.
  const pullDown = usePullDownToDismiss({ enabled: view === 'chat', onDismiss: onBack });
  const { resetScroll } = pullDown;
  useEffect(() => {
    resetScroll();
  }, [resetScroll, view]);

  useEffect(() => {
    // The floating bubble logs its own open (with the page kind).
    if (!page) {
      capturePostHogEvent(AnalyticsEvent.assistantOpened, { source });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per open
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

  const identifyPhoto = useCallback(async (photoUri: string) => {
    const run = ++photoRunRef.current;
    setPhoto({ status: 'identifying', photoUri });
    try {
      const candidates = await identifyAssistantPhoto(repository, photoUri, game);
      if (run !== photoRunRef.current) {
        return;
      }
      setPhoto(candidates.length > 0
        ? { status: 'ready', photoUri, candidates, selectedCardId: candidates[0].cardId }
        : { status: 'failed', photoUri });
    } catch {
      if (run === photoRunRef.current) {
        setPhoto({ status: 'failed', photoUri });
      }
    }
  }, [game, repository]);

  const discardComposerPhoto = useCallback((current: ComposerPhoto | null) => {
    photoRunRef.current += 1;
    if (current) {
      photoFilesRef.current.delete(current.photoUri);
      deleteAssistantPhoto(current.photoUri);
    }
  }, []);

  const handleAttachPhoto = useCallback(async (photoSource: AssistantPhotoSource) => {
    try {
      const picked = await pickAssistantPhoto(photoSource);
      if (picked.kind === 'unavailable') {
        Alert.alert('Update needed', 'Adding a photo needs the latest app version.');
        return;
      }
      if (picked.kind === 'denied') {
        Alert.alert(
          photoSource === 'camera' ? 'Camera access needed' : 'Photos access needed',
          photoSource === 'camera' ? 'Allow camera access to take a photo.' : 'Allow photo access to choose a picture.',
        );
        return;
      }
      if (picked.kind !== 'picked') {
        return;
      }
      const cropped = await cropAssistantPhoto(picked);
      // The picker's own copy is a cache file; only the crop is kept.
      deleteAssistantPhoto(picked.uri);
      if (!cropped) {
        Alert.alert('Photo failed', 'Could not read that photo. Please try another.');
        return;
      }
      photoFilesRef.current.add(cropped);
      // A new photo replaces the one in the composer.
      discardComposerPhoto(photoRef.current);
      capturePostHogEvent(AnalyticsEvent.assistantPhotoAttached, { source, photo_source: photoSource });
      await identifyPhoto(cropped);
    } catch {
      Alert.alert('Photo failed', 'Could not open the camera or your photos. Please try again.');
    }
  }, [discardComposerPhoto, identifyPhoto, source]);

  const handleRemovePhoto = useCallback(() => {
    discardComposerPhoto(photo);
    setPhoto(null);
    setMatchSheetVisible(false);
  }, [discardComposerPhoto, photo]);

  const handleSend = useCallback(async (text: string) => {
    const question = text.trim();
    if (!question || chat.pending?.status === 'sending' || chat.isLimitReached || photo?.status === 'identifying') {
      return;
    }
    const sentPhoto = photo?.status === 'ready' ? photo : null;
    const selected = sentPhoto?.candidates.find((card) => card.cardId === sentPhoto.selectedCardId);
    const attachment: AssistantPhotoAttachment | undefined = sentPhoto && selected
      ? { photoUri: sentPhoto.photoUri, cardId: selected.cardId, label: assistantPhotoCardLabel(selected) }
      : undefined;
    setDraft('');
    if (attachment) {
      // The file now belongs to the sent bubble; a failed identification is just dropped.
      setPhoto(null);
    } else if (photo) {
      handleRemovePhoto();
    }
    capturePostHogEvent(AnalyticsEvent.assistantQuestionSent, {
      source,
      ...(attachment ? { photo: true } : {}),
      ...(activePage ? { page_kind: activePage.kind } : {}),
    });
    if (chat.threadId == null) {
      startedBlankRef.current = true;
    }
    const outcome = await chat.send(question.slice(0, MAX_QUESTION_LENGTH), attachment ? { attachment } : undefined);
    if (outcome === 'limit') {
      // Not answered and not charged: give the words (and the photo) back.
      setDraft(question);
      if (sentPhoto) {
        setPhoto(sentPhoto);
      }
    }
  }, [activePage, chat, handleRemovePhoto, photo, source]);

  // A tapped candidate printing: ask for the add/update of exactly that card, or (intent "pick")
  // name it so the pending question carries on for it.
  const handlePickCard = useCallback(async (card: AssistantCardRef, message: AssistantMessage) => {
    if (!message.choice || chat.pending?.status === 'sending' || chat.isLimitReached) {
      return;
    }
    void Haptics.selectionAsync().catch(() => undefined);
    capturePostHogEvent(AnalyticsEvent.assistantQuestionSent, { source });
    await chat.send(assistantPrintingChoiceMessage(message.choice, card).slice(0, MAX_QUESTION_LENGTH), {
      cardIds: [card.cardId],
    });
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
  const ownerKey = currentUser?.id ?? null;
  // A chat STARTED here (first send from a blank chat) is remembered as this page's.
  const startedBlankRef = useRef(false);
  useEffect(() => {
    if (chat.threadId == null) {
      return;
    }
    if (startedBlankRef.current && pageKey && ownerKey) {
      void rememberThreadPageKey(ownerKey, chat.threadId, pageKey);
    }
    startedBlankRef.current = false;
  }, [chat.threadId, ownerKey, pageKey]);
  useEffect(() => {
    if (!canReadOnOpen) {
      return;
    }
    let cancelled = false;
    void (async () => {
      setThreadsStatus('loading');
      try {
        const listed = await repository.listAssistantThreads({ limit: 50 });
        if (cancelled) {
          return;
        }
        const latest = listed.threads[0];
        // From the floating bubble: continue the latest chat only if it was
        // started on this same page; any other page gets a fresh chat.
        const continueLatest = Boolean(
          resumeLatest &&
            latest &&
            (!pageKey || !ownerKey || (await readThreadPageKey(ownerKey, latest.id)) === pageKey),
        );
        if (cancelled) {
          return;
        }
        setThreads(listed.threads);
        setThreadsStatus('ready');
        if (continueLatest && latest) {
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
      const sentPhoto = item.message.role === 'user' ? chat.attachments[item.message.id] : undefined;
      const bubble = (
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
          onPickCard={item.message.id === latestMessage?.id ? (card, message) => void handlePickCard(card, message) : undefined}
          onFeedback={handleFeedback}
          onOpenCard={onOpenCard}
          onOpenSet={onOpenSet}
          onOpenWatchlist={onOpenWatchlist}
        />
      );
      return sentPhoto ? (
        <View style={styles.photoGroup}>
          <AssistantPhotoBubbleThumb label={sentPhoto.label} photoUri={sentPhoto.photoUri} />
          {bubble}
        </View>
      ) : bubble;
    }
    const { pending } = item;
    const pendingPhoto = pending.attachment ? (
      <AssistantPhotoBubbleThumb label={pending.attachment.label} photoUri={pending.attachment.photoUri} />
    ) : null;
    if (pending.status === 'sending') {
      return (
        <View style={styles.pendingGroup}>
          {pendingPhoto}
          <UserBubble animateEntrance testID="assistant-pending-question" text={pending.text} />
          <Animated.View entering={assistantRowEntering}>
            <AssistantThinkingIndicator
              label={
                pending.attachment
                  ? 'Looking at your card…'
                  : source === 'scanner' && cardIds.length > 0 ? 'Looking at your cards…' : 'Thinking…'
              }
              testID="assistant-sending"
            />
          </Animated.View>
        </View>
      );
    }
    return (
      <View style={styles.photoGroup}>
      {pendingPhoto}
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
      </View>
    );
  };

  const headerGlyph = {
    color: theme.colors.gray900,
    height: glassNavBubbleGlyphSize,
    strokeWidth: glassNavBubbleGlyphStrokeWidth,
    width: glassNavBubbleGlyphSize,
  };
  const remainingCaption = assistantRemainingCaption(chat.usage);
  // Bubble opens: chips about the page (the scan tray still uses the tray set via source).
  const starterPrompts = page && !pageDismissed && cardIds.length === 0
    ? assistantPagePrompts(page)
    : assistantStarterPrompts(cardIds.length, source);
  const greeting = assistantGreeting(currentUser?.displayName, isGuest);
  const cardContextLine = assistantCardContextLine(cardIds.length);
  const isSending = chat.pending?.status === 'sending';
  const hasConversation = rows.length > 0;
  // Starter chips step aside once the user starts typing (Figma 6607:11817).
  const isComposing = keyboardVisible || draft.length > 0;

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
      {chat.isLimitReached || isComposing ? null : (
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
    <PullDownToDismiss controller={pullDown} testID="assistant-pull-down">
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
          <GestureDetector gesture={pullDown.scrollGesture}>
          <ScrollView
            {...pullDown.scrollProps}
            contentContainerStyle={[styles.listContent, hasConversation ? null : styles.listContentEmpty]}
            // Not `interactive`: KeyboardAvoidingView only hears the keyboard's
            // frame on release, so the composer stayed put while the keyboard
            // followed the finger (a gap opened, then snapped shut).
            keyboardDismissMode="on-drag"
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
          </GestureDetector>
          <AssistantPhotoMatchSheet
            candidates={photo?.status === 'ready' ? photo.candidates : []}
            onClose={() => setMatchSheetVisible(false)}
            onSelect={(cardId) => {
              void Haptics.selectionAsync().catch(() => undefined);
              setPhoto((current) => (current?.status === 'ready' ? { ...current, selectedCardId: cardId } : current));
              setMatchSheetVisible(false);
            }}
            selectedCardId={photo?.status === 'ready' ? photo.selectedCardId : null}
            visible={matchSheetVisible && photo?.status === 'ready'}
          />
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
                {activePage?.label ? (
                  <AssistantPageChip
                    label={activePage.label}
                    onDismiss={() => setPageDismissed(true)}
                    testID="assistant-page-chip"
                  />
                ) : null}
                {remainingCaption ? (
                  <Text
                    style={[theme.typography.caption, styles.remaining, { color: theme.colors.gray600 }]}
                    testID="assistant-remaining"
                  >
                    {remainingCaption}
                  </Text>
                ) : null}
                <AssistantComposer
                  attachment={photo ? (
                    <AssistantPhotoChip
                      onChangeMatch={() => setMatchSheetVisible(true)}
                      onRemove={handleRemovePhoto}
                      onRetry={() => void identifyPhoto(photo.photoUri)}
                      state={photo.status === 'ready'
                        ? {
                            status: 'ready',
                            photoUri: photo.photoUri,
                            label: assistantPhotoCardLabel(
                              photo.candidates.find((card) => card.cardId === photo.selectedCardId) ?? photo.candidates[0],
                            ),
                            alternateCount: photo.candidates.length - 1,
                          }
                        : photo}
                    />
                  ) : null}
                  isSending={isSending}
                  maxLength={MAX_QUESTION_LENGTH}
                  onAttachPhoto={(photoSource) => void handleAttachPhoto(photoSource)}
                  onChangeText={setDraft}
                  onSend={() => void handleSend(draft)}
                  placeholder={photo ? 'Ask about this card' : undefined}
                  sendBlocked={photo?.status === 'identifying'}
                  value={draft}
                />
              </>
            )}
          </View>
        </KeyboardAvoidingView>
      )}
    </SafeAreaView>
    </PullDownToDismiss>
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
  // Figma 6607:11726: mark + greeting in the upper third, 16pt apart; the
  // starter chips stack left-aligned at the bottom, just above the composer.
  intro: {
    flexGrow: 1,
    gap: spacing.xxl,
    justifyContent: 'space-between',
  },
  introHead: {
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: INTRO_TOP_OFFSET,
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
  photoGroup: {
    gap: spacing.xxs,
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
