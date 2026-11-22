// Wire parsers for the Ask Ekalight endpoints (/api/v1/assistant/*), contract in
// docs/ai-chat-contracts-2026-11-17.md. snake_case in, camelCase out. Tolerant:
// a malformed row is dropped and a missing field becomes null, so a newer or
// older server never breaks the chat.
import type {
  AssistantActionState,
  AssistantActionUndo,
  AssistantCardRef,
  AssistantCardSparkline,
  AssistantCardsViewAll,
  AssistantChartRange,
  AssistantConditionCode,
  AssistantContext,
  AssistantErrorCode,
  AssistantFeedback,
  AssistantFeedbackInput,
  AssistantFeedbackReason,
  AssistantMessage,
  AssistantPriceChart,
  AssistantPrintingChoice,
  AssistantProposedAction,
  AssistantSendPayload,
  AssistantSendResult,
  AssistantSetRef,
  AssistantSetWindow,
  AssistantThreadSummary,
  AssistantThreadsPage,
  AssistantUsage,
  AssistantVerdict,
  AssistantVerdictItem,
  AssistantDealVerdictCode,
  AssistantGradingRecommendation,
  AssistantGradingVerdict,
  AssistantTradeSide,
} from './types';
import { CARD_GAMES } from './types';

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

const chartRanges: readonly AssistantChartRange[] = ['30d', '90d', '1y'];

const conditionCodes: readonly AssistantConditionCode[] = ['NM', 'LP', 'MP', 'HP', 'DMG'];

function asCondition(value: unknown): AssistantConditionCode | null {
  const raw = asString(value)?.toUpperCase();
  return raw && (conditionCodes as readonly string[]).includes(raw) ? (raw as AssistantConditionCode) : null;
}

const actionStates: readonly AssistantActionState[] = ['proposed', 'confirmed', 'dismissed', 'done', 'undone'];

function asActionState(value: unknown): AssistantActionState {
  return (actionStates as readonly unknown[]).includes(value) ? (value as AssistantActionState) : 'proposed';
}

function parseActionUndo(value: unknown): AssistantActionUndo | null {
  const raw = asRecord(value);
  const deckEntryId = raw ? asString(raw.deck_entry_id) : null;
  const quantityAdded = raw ? asInt(raw.quantity_added) : null;
  if (!raw || !deckEntryId || quantityAdded == null || quantityAdded < 1) {
    return null;
  }
  return { deckEntryId, quantityAdded, expiresAt: asString(raw.expires_at) };
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
    sparkline: parseAssistantCardSparkline(raw.sparkline),
  };
}

const ASSISTANT_MAX_SPARKLINE_POINTS = 30;

/** Needs two or more USD points; anything else means "no sparkline". */
export function parseAssistantCardSparkline(value: unknown): AssistantCardSparkline | null {
  const raw = asRecord(value);
  if (!raw || !Array.isArray(raw.points)) {
    return null;
  }
  const points = raw.points
    .map(asNumber)
    .filter((point): point is number => point != null)
    .slice(-ASSISTANT_MAX_SPARKLINE_POINTS);
  if (points.length < 2) {
    return null;
  }
  const range = chartRanges.find((option) => option === raw.range) ?? '90d';
  return { range, points, changePct: asNumber(raw.change_pct) };
}

export const ASSISTANT_MAX_SETS = 6;
const setWindows: readonly AssistantSetWindow[] = ['7d', '30d', '90d'];

/** A set tile needs an id and a name; everything else is optional. */
export function parseAssistantSetRef(value: unknown): AssistantSetRef | null {
  const raw = asRecord(value);
  const setId = raw ? asString(raw.set_id) : null;
  const name = raw ? asString(raw.name) : null;
  if (!raw || !setId || !name) {
    return null;
  }
  return {
    setId,
    name,
    game: CARD_GAMES.find((game) => game === raw.game) ?? null,
    logoUrl: asString(raw.logo_url),
    symbolUrl: asString(raw.symbol_url),
    changePct: asNumber(raw.change_pct),
    window: setWindows.find((option) => option === raw.window) ?? null,
    releaseYear: asString(raw.release_year),
  };
}

export function parseAssistantCardsViewAll(value: unknown): AssistantCardsViewAll | null {
  const raw = asRecord(value);
  const total = raw ? asInt(raw.total) : null;
  return raw && raw.screen === 'watchlist' && total != null && total > 0 ? { screen: 'watchlist', total } : null;
}

/** Tap-to-pick printing choice; anything unrecognized = ordinary tiles. */
export function parseAssistantPrintingChoice(value: unknown): AssistantPrintingChoice | null {
  const raw = asRecord(value);
  if (!raw || raw.kind !== 'pick_printing' || (raw.intent !== 'add' && raw.intent !== 'update')) {
    return null;
  }
  const quantity = asInt(raw.quantity);
  const grader = asString(raw.grader);
  return {
    kind: 'pick_printing',
    intent: raw.intent,
    quantity: quantity != null && quantity >= 1 ? quantity : raw.intent === 'add' ? 1 : null,
    condition: grader ? null : asCondition(raw.condition) ?? (raw.intent === 'add' ? 'NM' : null),
    grader,
    grade: grader ? asString(raw.grade) : null,
    quantityStated: raw.quantity_stated === true,
    conditionStated: raw.condition_stated === true,
  };
}

export function parseAssistantAction(value: unknown): AssistantProposedAction | null {
  const raw = asRecord(value);
  const id = raw ? asString(raw.id) : null;
  if (!raw || !id) {
    return null;
  }
  const params = asRecord(raw.params) ?? {};
  const undo = parseActionUndo(raw.undo);
  const base = {
    id,
    summary: asString(raw.summary) ?? '',
    state: asActionState(raw.state),
    ...(undo ? { undo } : {}),
  };
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
    case 'remove_holding': {
      const holdingId = asString(params.holding_id);
      const quantity = asInt(params.quantity);
      if (!holdingId || quantity == null || quantity < 1) {
        return null;
      }
      return {
        ...base,
        type: 'remove_holding',
        params: {
          holdingId,
          cardId: asString(params.card_id),
          quantity,
          removeAll: params.remove_all === true,
          remainingQuantity: Math.max(0, asInt(params.remaining_quantity) ?? 0),
        },
      };
    }
    case 'move_holding': {
      const holdingId = asString(params.holding_id);
      const collectionId = asString(params.collection_id);
      if (!holdingId || !collectionId) {
        return null;
      }
      const quantity = asInt(params.quantity);
      return {
        ...base,
        type: 'move_holding',
        params: {
          holdingId,
          cardId: asString(params.card_id),
          collectionId,
          collectionName: asString(params.collection_name),
          quantity: quantity != null && quantity >= 1 ? quantity : null,
        },
      };
    }
    case 'create_collection': {
      const name = asString(typeof params.name === 'string' ? params.name.trim() : null);
      if (!name) {
        return null;
      }
      return {
        ...base,
        type: 'create_collection',
        params: {
          name,
          holdingIds: Array.isArray(params.holding_ids)
            ? params.holding_ids.map(asString).filter((id): id is string => id != null)
            : [],
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

export const ASSISTANT_MAX_CHARTS = 2;
const ASSISTANT_MAX_CHART_POINTS = 90;

/** A chart needs at least two dated USD points; anything else is dropped. */
export function parseAssistantPriceChart(value: unknown): AssistantPriceChart | null {
  const raw = asRecord(value);
  const cardId = raw ? asString(raw.card_id) : null;
  if (!raw || !cardId) {
    return null;
  }
  const points = (Array.isArray(raw.points) ? raw.points : [])
    .map((item) => {
      const point = asRecord(item);
      const date = point ? asString(point.date) : null;
      const usd = point ? asNumber(point.usd) : null;
      return date && /^\d{4}-\d{2}-\d{2}/.test(date) && usd != null ? { date: date.slice(0, 10), usd } : null;
    })
    .filter((point): point is { date: string; usd: number } => point != null)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-ASSISTANT_MAX_CHART_POINTS);
  if (points.length < 2) {
    return null;
  }
  const range = chartRanges.find((option) => option === raw.range) ?? '90d';
  const grader = asString(raw.grader);
  return {
    cardId,
    name: asString(raw.name) ?? '',
    variant: asString(raw.variant),
    condition: grader ? null : asCondition(raw.condition),
    grader,
    grade: grader ? asString(raw.grade) : null,
    range,
    points,
    source: raw.source === 'tcgplayer' || raw.source === 'scrydex' ? raw.source : null,
  };
}

export const ASSISTANT_FEEDBACK_REASONS: readonly AssistantFeedbackReason[] = [
  'wrong',
  'not_helpful',
  'too_long',
  'wrong_cards',
  'other',
];
export const ASSISTANT_FEEDBACK_NOTE_MAX_CHARS = 500;

export function parseAssistantFeedback(value: unknown): AssistantFeedback | null {
  const raw = asRecord(value);
  if (!raw || (raw.rating !== 'up' && raw.rating !== 'down')) {
    return null;
  }
  const reason = (ASSISTANT_FEEDBACK_REASONS as readonly unknown[]).includes(raw.reason)
    ? (raw.reason as AssistantFeedbackReason)
    : null;
  return { rating: raw.rating, reason, note: asString(raw.note), updatedAt: asString(raw.updated_at) };
}

/** App input → wire body for POST /api/v1/assistant/messages/{id}/feedback. */
export function buildAssistantFeedbackBody(input: AssistantFeedbackInput): Record<string, unknown> {
  if (input.rating == null) {
    return { rating: null };
  }
  const note = input.note?.trim().slice(0, ASSISTANT_FEEDBACK_NOTE_MAX_CHARS) || null;
  return { rating: input.rating, reason: input.reason ?? null, note };
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
    cardsLabel: role === 'assistant' ? asString(typeof raw.cards_label === 'string' ? raw.cards_label.trim() : null) : null,
    cardsViewAll: role === 'assistant' ? parseAssistantCardsViewAll(raw.cards_view_all) : null,
    // Actions are assistant-only by contract.
    actions: role === 'assistant' ? parseList(raw.actions, parseAssistantAction) : [],
    createdAt: asString(raw.created_at) ?? '',
    status: raw.status === 'error' ? 'error' : 'ok',
    suggestions: role === 'assistant' ? parseAssistantSuggestions(raw.suggestions) : [],
    charts: role === 'assistant' ? parseList(raw.charts, parseAssistantPriceChart).slice(0, ASSISTANT_MAX_CHARTS) : [],
    sets: role === 'assistant' ? parseList(raw.sets, parseAssistantSetRef).slice(0, ASSISTANT_MAX_SETS) : [],
    choice: role === 'assistant' ? parseAssistantPrintingChoice(raw.choice) : null,
    feedback: role === 'assistant' ? parseAssistantFeedback(raw.feedback) : null,
    verdicts: role === 'assistant' ? parseList(raw.verdicts, parseAssistantVerdict).slice(0, ASSISTANT_MAX_VERDICTS) : [],
  };
}

export const ASSISTANT_MAX_VERDICTS = 2;

function parseVerdictItem(value: unknown): AssistantVerdictItem | null {
  const raw = asRecord(value);
  const cardId = raw ? asString(raw.card_id) : null;
  if (!raw || !cardId) {
    return null;
  }
  const solds = asRecord(raw.solds);
  const soldCount = solds ? asInt(solds.count) : null;
  const grader = asString(raw.grader);
  return {
    cardId,
    name: asString(raw.name) ?? '',
    setName: asString(raw.set) ?? '',
    number: asString(raw.number) ?? '',
    imageSmallUrl: asString(raw.image_small_url),
    variant: asString(raw.variant),
    condition: grader ? null : asCondition(raw.condition),
    conditionAssumed: raw.condition_assumed === true,
    grader,
    grade: grader ? asString(raw.grade) : null,
    quantity: Math.max(1, asInt(raw.quantity) ?? 1),
    priceUsd: asNumber(raw.price_usd),
    marketTotalUsd: asNumber(raw.market_total_usd),
    askingUsd: asNumber(raw.asking_usd),
    pctOfMarket: asNumber(raw.pct_of_market),
    change30dPct: asNumber(raw.change_30d_pct),
    priceAsOf: asString(raw.price_as_of),
    solds: solds && soldCount != null && soldCount > 0
      ? { count: soldCount, averageUsd: asNumber(solds.average_usd), latestSoldAt: asString(solds.latest_sold_at) }
      : null,
  };
}

const dealVerdicts: readonly AssistantDealVerdictCode[] = [
  'good_buy', 'fair', 'above_market', 'strong_offer', 'typical_offer', 'low_offer', 'unknown',
];
const tradeVerdicts = ['fair', 'slightly_uneven', 'uneven', 'unknown'] as const;
const gradingRecommendations: readonly AssistantGradingRecommendation[] = [
  'worth_grading', 'grade_if_confident_10', 'not_worth_it', 'no_comps', 'no_raw_price',
];

function parseTradeSide(value: unknown, fallbackLabel: string): AssistantTradeSide {
  const raw = asRecord(value) ?? {};
  return {
    label: asString(raw.label) ?? fallbackLabel,
    totalUsd: asNumber(raw.total_usd),
    unpricedCount: Math.max(0, asInt(raw.unpriced_count) ?? 0),
    items: parseList(raw.items, parseVerdictItem),
  };
}

function parseGradingCards(value: unknown): AssistantGradingVerdict['cards'] {
  return parseList(value, (item) => {
    const raw = asRecord(item);
    const cardId = raw ? asString(raw.card_id) : null;
    if (!raw || !cardId) {
      return null;
    }
    const breakEven: Record<string, string | null> = {};
    for (const [grader, grade] of Object.entries(asRecord(raw.break_even) ?? {})) {
      breakEven[grader] = asString(grade);
    }
    return {
      cardId,
      name: asString(raw.name) ?? '',
      setName: asString(raw.set) ?? '',
      number: asString(raw.number) ?? '',
      imageSmallUrl: asString(raw.image_small_url),
      rawPriceUsd: asNumber(raw.raw_price_usd),
      recommendation: gradingRecommendations.find((code) => code === raw.recommendation) ?? null,
      breakEven,
      scenarios: parseList(raw.scenarios, (row) => {
        const scenario = asRecord(row);
        const grader = scenario ? asString(scenario.grader) : null;
        const grade = scenario ? asString(scenario.grade) : null;
        if (!scenario || !grader || !grade) {
          return null;
        }
        return {
          grader,
          grade,
          compPriceUsd: asNumber(scenario.comp_price_usd),
          feeUsd: asNumber(scenario.fee_usd),
          shippingUsd: asNumber(scenario.shipping_usd),
          netUsd: asNumber(scenario.net_usd),
        };
      }),
    };
  });
}

/** Deal / trade / grading card; an unknown kind (newer server) is dropped. */
export function parseAssistantVerdict(value: unknown): AssistantVerdict | null {
  const raw = asRecord(value);
  if (!raw) {
    return null;
  }
  const label = asString(raw.label) ?? '';
  switch (raw.kind) {
    case 'deal': {
      const verdict = dealVerdicts.find((code) => code === raw.verdict);
      if (!verdict) {
        return null;
      }
      return {
        kind: 'deal',
        verdict,
        label,
        side: raw.side === 'selling' ? 'selling' : 'buying',
        askingUsd: asNumber(raw.asking_usd),
        marketUsd: asNumber(raw.market_usd),
        pctOfMarket: asNumber(raw.pct_of_market),
        diffUsd: asNumber(raw.diff_usd),
        items: parseList(raw.items, parseVerdictItem),
        unpricedCount: Math.max(0, asInt(raw.unpriced_count) ?? 0),
      };
    }
    case 'trade': {
      const verdict = tradeVerdicts.find((code) => code === raw.verdict);
      if (!verdict) {
        return null;
      }
      const balance = asRecord(raw.balance);
      const cash = balance ? asNumber(balance.cash_usd) : null;
      return {
        kind: 'trade',
        verdict,
        label,
        sideA: parseTradeSide(raw.side_a, 'You give'),
        sideB: parseTradeSide(raw.side_b, 'You get'),
        gapUsd: asNumber(raw.gap_usd),
        gapPct: asNumber(raw.gap_pct),
        favors: raw.favors === 'you' || raw.favors === 'them' ? raw.favors : null,
        balance: balance && cash != null && (balance.who_adds === 'you' || balance.who_adds === 'them')
          ? { whoAdds: balance.who_adds, cashUsd: cash }
          : null,
      };
    }
    case 'grading': {
      const cards = parseGradingCards(raw.cards);
      if (cards.length === 0) {
        return null;
      }
      const fees = asRecord(raw.fees) ?? {};
      return {
        kind: 'grading',
        cards,
        fees: { asOf: asString(fees.as_of), placeholder: fees.placeholder === true, shippingUsd: asNumber(fees.shipping_usd) },
      };
    }
    default:
      return null;
  }
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
    // Tells the server this build renders executed adds with Undo (direct add).
    capabilities: ['direct_add'],
  };
  const context: AssistantContext | null | undefined = payload.context;
  if (context) {
    const cardIds = (context.cardIds ?? []).filter((id) => typeof id === 'string' && id.length > 0);
    const attachedCardIds = (context.attachedCardIds ?? []).filter((id) => typeof id === 'string' && id.length > 0);
    body.context = {
      source: context.source,
      // Contract cap: ≤20 tray card ids, deduped.
      ...(cardIds.length > 0 ? { card_ids: Array.from(new Set(cardIds)).slice(0, 20) } : {}),
      // Contract cap: ≤5 attached card ids per message, deduped.
      ...(attachedCardIds.length > 0 ? { attached_card_ids: Array.from(new Set(attachedCardIds)).slice(0, 5) } : {}),
      ...(context.game && CARD_GAMES.includes(context.game) ? { game: context.game } : {}),
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
  'not_undoable',
  'undo_expired',
  'cannot_undo',
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
