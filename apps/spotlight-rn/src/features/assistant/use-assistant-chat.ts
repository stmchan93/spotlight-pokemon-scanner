import { useCallback, useEffect, useRef, useState } from 'react';

import {
  createAssistantClientMessageId,
  isAssistantRequestError,
  type AssistantContext,
  type AssistantErrorCode,
  type AssistantFeedback,
  type AssistantFeedbackInput,
  type AssistantMessage,
  type AssistantUsage,
  type SpotlightRepository,
} from '@spotlight/api-client';

import type { AssistantPhotoAttachment } from '@/features/assistant/assistant-photo-scan';

/** The question in flight (or the one that failed and can be retried). */
export type AssistantPendingQuestion = {
  clientMessageId: string;
  text: string;
  status: 'sending' | 'failed';
  errorCode: AssistantErrorCode | null;
  /** Cards this question is about (a tapped printing choice); kept for Retry. */
  cardIds?: string[];
  /** A chat photo the scanner identified; its card goes as context.attachedCardIds. Kept for Retry. */
  attachment?: AssistantPhotoAttachment;
};

export type AssistantSendOptions = {
  /** Sent as context.card_ids with this one question (e.g. the printing the user tapped). */
  cardIds?: string[];
  /** A confirmed chat photo: sent as context.attachedCardIds on THIS turn (any turn). */
  attachment?: AssistantPhotoAttachment;
};

export type AssistantSendOutcome = 'sent' | 'failed' | 'limit' | 'ignored';

type UseAssistantChatOptions = {
  repository: SpotlightRepository;
  context: AssistantContext;
  initialThreadId?: string | null;
  /**
   * Mint/await the guest identity before an authed call. Resolves false when
   * there's no identity to send with (mint failed / signed out).
   */
  ensureIdentity: () => Promise<boolean>;
  /** False for a not-yet-minted guest: reading usage on open would be wasted. */
  canReadOnOpen: boolean;
};

export function assistantErrorCopy(code: AssistantErrorCode | null): string {
  switch (code) {
    case 'assistant_disabled':
      return "Ask Ekalight isn't available right now.";
    case 'assistant_busy':
      return 'Ask Ekalight is busy right now. Try again later.';
    case 'invalid_request':
      return "That message couldn't be sent. Try rephrasing it.";
    case 'unauthenticated':
      return 'Sign in to ask Ekalight.';
    case 'network':
      return "Couldn't reach Ekalight. Check your connection.";
    default:
      return "Ekalight couldn't answer that. Try again.";
  }
}

export function useAssistantChat({
  repository,
  context,
  initialThreadId = null,
  ensureIdentity,
  canReadOnOpen,
}: UseAssistantChatOptions) {
  const [threadId, setThreadId] = useState<string | null>(initialThreadId);
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [pending, setPending] = useState<AssistantPendingQuestion | null>(null);
  const [usage, setUsage] = useState<AssistantUsage | null>(null);
  const [isLoadingThread, setIsLoadingThread] = useState(Boolean(initialThreadId));
  const [threadError, setThreadError] = useState(false);
  // The reply that just arrived live (animates in, gets scrolled to). Never set
  // for a loaded history.
  const [lastReplyId, setLastReplyId] = useState<string | null>(null);
  // Chat photos by the user message they rode with. Local only (the photo is
  // never uploaded to the assistant), so a reopened thread shows none.
  const [attachments, setAttachments] = useState<Record<string, AssistantPhotoAttachment>>({});
  // Tray context goes with the FIRST question of a thread only; follow-ups ride
  // the thread's own history. Source and game go every time (the server keeps
  // the thread's own game first, so the screen's game only fills a gap).
  const contextSentRef = useRef(Boolean(initialThreadId));
  const loadGenerationRef = useRef(0);

  const refreshUsage = useCallback(async () => {
    try {
      setUsage(await repository.getAssistantUsage());
    } catch {
      // Usage is decoration; a failed read just hides the pill.
    }
  }, [repository]);

  useEffect(() => {
    if (canReadOnOpen) {
      void refreshUsage();
    }
  }, [canReadOnOpen, refreshUsage]);

  const openThread = useCallback(async (nextThreadId: string | null) => {
    const generation = ++loadGenerationRef.current;
    setThreadId(nextThreadId);
    setMessages([]);
    setPending(null);
    setThreadError(false);
    setLastReplyId(null);
    setAttachments({});
    contextSentRef.current = nextThreadId != null;
    if (!nextThreadId) {
      setIsLoadingThread(false);
      return;
    }
    setIsLoadingThread(true);
    try {
      const loaded = await repository.getAssistantThreadMessages(nextThreadId);
      if (generation === loadGenerationRef.current) {
        setMessages(loaded);
      }
    } catch {
      if (generation === loadGenerationRef.current) {
        setThreadError(true);
      }
    } finally {
      if (generation === loadGenerationRef.current) {
        setIsLoadingThread(false);
      }
    }
  }, [repository]);

  useEffect(() => {
    if (initialThreadId) {
      void openThread(initialThreadId);
    }
    // Only the route's thread on mount; later switches go through openThread.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only
  }, []);

  const submit = useCallback(async (question: AssistantPendingQuestion): Promise<AssistantSendOutcome> => {
    setPending({ ...question, status: 'sending', errorCode: null });
    const generation = loadGenerationRef.current;
    if (!(await ensureIdentity())) {
      setPending({ ...question, status: 'failed', errorCode: 'unauthenticated' });
      return 'failed';
    }
    try {
      const turnContext: AssistantContext = question.cardIds?.length
        ? { source: context.source, cardIds: question.cardIds, ...(context.game ? { game: context.game } : {}) }
        : contextSentRef.current
          ? { source: context.source, ...(context.game ? { game: context.game } : {}) }
          : context;
      const result = await repository.sendAssistantMessage({
        threadId,
        clientMessageId: question.clientMessageId,
        text: question.text,
        // A photo's card rides beside (never instead of) the tray context.
        context: question.attachment
          ? { ...turnContext, attachedCardIds: [question.attachment.cardId] }
          : turnContext,
      });
      if (generation !== loadGenerationRef.current) {
        return 'ignored';
      }
      contextSentRef.current = true;
      setThreadId(result.threadId);
      setMessages((current) => [...current, result.userMessage, result.message]);
      const { attachment } = question;
      if (attachment) {
        setAttachments((current) => ({ ...current, [result.userMessage.id]: attachment }));
      }
      setLastReplyId(result.message.id);
      setPending(null);
      setUsage(result.usage);
      return 'sent';
    } catch (error) {
      if (generation !== loadGenerationRef.current) {
        return 'ignored';
      }
      const code = isAssistantRequestError(error) ? error.code : 'unknown';
      if (code === 'daily_limit') {
        setPending(null);
        if (isAssistantRequestError(error) && error.usage) {
          setUsage(error.usage);
        } else {
          setUsage((current) => current && { ...current, remainingToday: 0 });
        }
        return 'limit';
      }
      setPending({ ...question, status: 'failed', errorCode: code });
      return 'failed';
    }
  }, [context, ensureIdentity, repository, threadId]);

  const send = useCallback((text: string, options?: AssistantSendOptions) => {
    const trimmed = text.trim();
    if (!trimmed || pending?.status === 'sending') {
      return Promise.resolve<AssistantSendOutcome>('ignored');
    }
    return submit({
      clientMessageId: createAssistantClientMessageId(),
      text: trimmed,
      status: 'sending',
      errorCode: null,
      ...(options?.cardIds?.length ? { cardIds: options.cardIds } : {}),
      ...(options?.attachment ? { attachment: options.attachment } : {}),
    });
  }, [pending, submit]);

  /** Re-sends the failed question with the SAME client_message_id (the idempotency key). */
  const retry = useCallback(() => {
    if (!pending || pending.status !== 'failed') {
      return Promise.resolve<AssistantSendOutcome>('ignored');
    }
    return submit(pending);
  }, [pending, submit]);

  const replaceAction = useCallback((updated: AssistantMessage['actions'][number]) => {
    setMessages((current) =>
      current.map((message) =>
        message.actions.some((action) => action.id === updated.id)
          ? { ...message, actions: message.actions.map((action) => (action.id === updated.id ? updated : action)) }
          : message,
      ),
    );
  }, []);

  const messagesRef = useRef(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  // Per-message request counter: only the newest tap's response may land.
  const feedbackSeqRef = useRef<Record<string, number>>({});

  const patchFeedback = useCallback((messageId: string, feedback: AssistantFeedback | null) => {
    setMessages((current) =>
      current.map((message) => (message.id === messageId ? { ...message, feedback } : message)),
    );
  }, []);

  /** Optimistic 👍/👎; reverts if the save fails. Resolves false on failure. */
  const setFeedback = useCallback(async (messageId: string, input: AssistantFeedbackInput) => {
    const previous = messagesRef.current.find((message) => message.id === messageId)?.feedback ?? null;
    const seq = (feedbackSeqRef.current[messageId] ?? 0) + 1;
    feedbackSeqRef.current[messageId] = seq;
    patchFeedback(
      messageId,
      input.rating == null
        ? null
        : { rating: input.rating, reason: input.reason ?? null, note: input.note?.trim() || null, updatedAt: null },
    );
    try {
      const stored = await repository.setAssistantFeedback(messageId, input);
      if (feedbackSeqRef.current[messageId] === seq) {
        patchFeedback(messageId, stored);
      }
      return true;
    } catch {
      if (feedbackSeqRef.current[messageId] === seq) {
        patchFeedback(messageId, previous);
      }
      return false;
    }
  }, [patchFeedback, repository]);

  const isLimitReached = usage != null && usage.limit != null && (usage.remainingToday ?? 0) <= 0;

  return {
    threadId,
    messages,
    pending,
    usage,
    isLimitReached,
    isLoadingThread,
    threadError,
    lastReplyId,
    attachments,
    send,
    retry,
    openThread,
    refreshUsage,
    replaceAction,
    setFeedback,
  };
}
