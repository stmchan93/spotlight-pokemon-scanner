// Wire parsers for the Ask Ekalight endpoints (/api/v1/assistant/*), contract in
// docs/ai-chat-contracts-2026-11-17.md. snake_case in, camelCase out. Tolerant:
// a malformed row is dropped and a missing field becomes null, so a newer or
// older server never breaks the chat.
import type {
  AssistantActionState,
  AssistantCardRef,
  AssistantConditionCode,
  AssistantContext,
  AssistantErrorCode,
  AssistantMessage,
  AssistantProposedAction,
  AssistantSendPayload,
  AssistantSendResult,
  AssistantThreadSummary,
  AssistantThreadsPage,
  AssistantUsage,
} from './types';

type Raw = Record<string, unknown>;

function asRecord(value: unknown): Raw | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Raw) : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asInt(value: unknown): number | null {
  const number = asNumber(value);
  return number == null ? null : Math.trunc(number);
}

const conditionCodes: readonly AssistantConditionCode[] = ['NM', 'LP', 'MP', 'HP', 'DMG'];

function asCondition(value: unknown): AssistantConditionCode | null {
  const raw = asString(value)?.toUpperCase();
  return raw && (conditionCodes as readonly string[]).includes(raw) ? (raw as AssistantConditionCode) : null;
}

function asActionState(value: unknown): AssistantActionState {
  return value === 'confirmed' || value === 'dismissed' ? value : 'proposed';
}

export function parseAssistantUsage(value: unknown): AssistantUsage | null {
  const raw = asRecord(value);
  if (!raw) {
    return null;
  }
  return {
    limit: asInt(raw.limit),
    usedToday: Math.max(0, asInt(raw.used_today) ?? 0),
    remainingToday: raw.remaining_today == null ? null : Math.max(0, asInt(raw.remaining_today) ?? 0),
    resetsAt: asString(raw.resets_at),
    isGuest: raw.is_guest === true,
  };
}

export function parseAssistantCardRef(value: unknown): AssistantCardRef | null {
  const raw = asRecord(value);
  const cardId = raw ? asString(raw.card_id) : null;
  if (!raw || !cardId) {
    return null;
  }
  return {
    cardId,
    name: asString(raw.name) ?? '',
    setName: asString(raw.set) ?? '',
    number: asString(raw.number) ?? '',
    language: asString(raw.language),
    imageSmallUrl: asString(raw.image_small_url),
    priceUsd: asNumber(raw.price_usd),
    variant: asString(raw.variant),
    grader: asString(raw.grader),
    grade: asString(raw.grade),
    quantityOwned: asInt(raw.quantity_owned),
    appUrl: asString(raw.app_url),
  };
}

export function parseAssistantAction(value: unknown): AssistantProposedAction | null {
  const raw = asRecord(value);
  const id = raw ? asString(raw.id) : null;
  if (!raw || !id) {
    return null;
  }
  const params = asRecord(raw.params) ?? {};
  const base = { id, summary: asString(raw.summary) ?? '', state: asActionState(raw.state) };
  switch (raw.type) {
    case 'add_to_collection': {
      const cardId = asString(params.card_id);
      if (!cardId) {
        return null;
      }
      return {
        ...base,
        type: 'add_to_collection',
        params: {
          cardId,
          quantity: Math.max(1, asInt(params.quantity) ?? 1),
          condition: asCondition(params.condition),
          variantName: asString(params.variant_name),
          grader: asString(params.grader),
          grade: asString(params.grade),
          collectionId: asString(params.collection_id),
        },
      };
    }
    case 'update_holding': {
      const holdingId = asString(params.holding_id);
      if (!holdingId) {
        return null;
      }
      const quantity = asInt(params.quantity);
      return {
        ...base,
        type: 'update_holding',
        params: {
          holdingId,
          // v1 never deletes, so anything under 1 is treated as "no change".
          quantity: quantity != null && quantity >= 1 ? quantity : null,
          condition: asCondition(params.condition),
        },
      };
    }
    case 'watch_card': {
      const cardId = asString(params.card_id);
      if (!cardId) {
        return null;
      }
      const target = asNumber(params.target_price_usd);
      return {
        ...base,
        type: 'watch_card',
        params: {
          cardId,
          variant: asString(params.variant),
          targetPriceUsd: target != null && target > 0 ? target : null,
        },
      };
    }
    default:
      return null;
  }
}

function parseList<T>(value: unknown, parse: (item: unknown) => T | null): T[] {
  return Array.isArray(value) ? value.map(parse).filter((item): item is T => item != null) : [];
}

export const ASSISTANT_MAX_SUGGESTIONS = 3;

/** Follow-up prompts: strings only, trimmed, de-duplicated, at most 3. */
export function parseAssistantSuggestions(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  for (const item of value) {
    const text = typeof item === 'string' ? item.trim() : '';
    if (text && !seen.has(text)) {
      seen.add(text);
    }
    if (seen.size >= ASSISTANT_MAX_SUGGESTIONS) {
      break;
    }
  }
  return [...seen];
}

export function parseAssistantMessage(value: unknown): AssistantMessage | null {
  const raw = asRecord(value);
  const id = raw ? asString(raw.id) : null;
  if (!raw || !id) {
    return null;
  }
  const role = raw.role === 'user' ? 'user' : 'assistant';
  return {
    id,
    threadId: asString(raw.thread_id) ?? '',
    role,
    text: typeof raw.text === 'string' ? raw.text : '',
    cards: parseList(raw.cards, parseAssistantCardRef).slice(0, 12),
    // Actions are assistant-only by contract.
    actions: role === 'assistant' ? parseList(raw.actions, parseAssistantAction) : [],
    createdAt: asString(raw.created_at) ?? '',
    status: raw.status === 'error' ? 'error' : 'ok',
    suggestions: role === 'assistant' ? parseAssistantSuggestions(raw.suggestions) : [],
  };
}

export function parseAssistantMessages(value: unknown): AssistantMessage[] {
  return parseList(asRecord(value)?.messages, parseAssistantMessage);
}

export function parseAssistantSendResult(value: unknown): AssistantSendResult | null {
  const raw = asRecord(value);
  if (!raw) {
    return null;
  }
  const message = parseAssistantMessage(raw.message);
  const userMessage = parseAssistantMessage(raw.user_message);
  const usage = parseAssistantUsage(raw.usage);
  const threadId = asString(raw.thread_id) ?? message?.threadId ?? null;
  if (!message || !userMessage || !usage || !threadId) {
    return null;
  }
  return { threadId, userMessage, message, usage };
}

export function parseAssistantThreadSummary(value: unknown): AssistantThreadSummary | null {
  const raw = asRecord(value);
  const id = raw ? asString(raw.id) : null;
  if (!raw || !id) {
    return null;
  }
  return {
    id,
    title: asString(raw.title) ?? '',
    updatedAt: asString(raw.updated_at) ?? '',
    lastMessagePreview: asString(raw.last_message_preview) ?? '',
  };
}

export function parseAssistantThreadsPage(value: unknown): AssistantThreadsPage {
  const raw = asRecord(value) ?? {};
  return {
    threads: parseList(raw.threads, parseAssistantThreadSummary),
    nextCursor: asString(raw.next_cursor),
  };
}

/** App payload → wire body for POST /api/v1/assistant/messages. */
export function buildAssistantSendBody(payload: AssistantSendPayload): Record<string, unknown> {
  const body: Record<string, unknown> = {
    thread_id: payload.threadId ?? null,
    client_message_id: payload.clientMessageId,
    text: payload.text,
  };
  const context: AssistantContext | null | undefined = payload.context;
  if (context) {
    const cardIds = (context.cardIds ?? []).filter((id) => typeof id === 'string' && id.length > 0);
    body.context = {
      source: context.source,
      // Contract cap: ≤20 tray card ids, deduped.
      ...(cardIds.length > 0 ? { card_ids: Array.from(new Set(cardIds)).slice(0, 20) } : {}),
    };
  }
  return body;
}

/**
 * A failed assistant call. `code` is the contract's machine-readable `error`
 * (plus `unauthenticated`/`not_found`/`network`/`unknown` for the transport
 * cases); a 429 carries the server's `usage` so the limit state can render.
 */
export class AssistantRequestError extends Error {
  constructor(
    message: string,
    readonly code: AssistantErrorCode,
    readonly status?: number,
    readonly usage: AssistantUsage | null = null,
  ) {
    super(message);
    this.name = 'AssistantRequestError';
  }
}

export function isAssistantRequestError(error: unknown): error is AssistantRequestError {
  return error instanceof AssistantRequestError;
}

const knownErrorCodes: readonly AssistantErrorCode[] = [
  'invalid_request',
  'daily_limit',
  'assistant_disabled',
  'assistant_busy',
  'assistant_failed',
];

/** Maps an HTTP failure (status + parsed JSON body, if any) to an AssistantRequestError. */
export function assistantErrorFromResponse(status: number, body: unknown): AssistantRequestError {
  const raw = asRecord(body);
  const errorField = raw ? asString(raw.error) : null;
  let code: AssistantErrorCode;
  if (errorField && (knownErrorCodes as readonly string[]).includes(errorField)) {
    code = errorField as AssistantErrorCode;
  } else if (status === 401) {
    code = 'unauthenticated';
  } else if (status === 404) {
    code = 'not_found';
  } else if (status === 429) {
    code = 'daily_limit';
  } else {
    code = 'unknown';
  }
  const usage = raw ? parseAssistantUsage(raw.usage) : null;
  return new AssistantRequestError(errorField ?? `Assistant request failed (${status})`, code, status, usage);
}

/** RFC-4122 v4 id for `client_message_id` (same scheme the repository uses for labeling ids). */
export function createAssistantClientMessageId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
    const random = Math.floor(Math.random() * 16);
    const value = character === 'x' ? random : ((random & 0x3) | 0x8);
    return value.toString(16);
  });
}
