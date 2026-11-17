import {
  buildWatchKey,
  deckConditionOptions,
  type AssistantCardRef,
  type AssistantConditionCode,
  type AssistantProposedAction,
  type DeckConditionCode,
  type InventoryCardEntry,
  type SpotlightRepository,
} from '@spotlight/api-client';

import { invalidateCardDetailCache } from '@/features/cards/card-detail-prefetch';
import type { WatchlistCardBasics, WatchlistStore } from '@/features/wishlist/watchlist-store';
import { AnalyticsEvent, watchlistKindForCardId } from '@/lib/observability/analytics-events';
import { capturePostHogEvent } from '@/lib/observability/posthog';

/*
  Confirm on a ProposedAction runs the SAME repository call the app's own
  Add / Edit / Watch controls run (contract table in
  docs/ai-chat-contracts-2026-11-17.md), then the same post-success cache work
  those controls do. The chat backend never writes; it only records the
  outcome afterwards (`setAssistantActionState`, done by the caller).
*/

export type AssistantActionDeps = {
  repository: SpotlightRepository;
  /** Collection the Collection tab is scoped to — PDP adds land there too. */
  activeCollectionID: string;
  inventoryEntriesCache: InventoryCardEntry[] | null;
  prependOptimisticInventoryEntry: (entry: InventoryCardEntry) => void;
  removeOptimisticInventoryEntries: (ids: string[]) => void;
  refreshData: () => void;
  watchlistStore: WatchlistStore;
  /** Cards shown with the action's message, for optimistic rows. */
  cards: AssistantCardRef[];
};

export type AssistantActionOutcome =
  | { status: 'done' }
  | { status: 'failed'; message: string };

export class AssistantActionError extends Error {}

export function deckConditionFromAssistant(code: AssistantConditionCode | null): DeckConditionCode | null {
  if (!code) {
    return null;
  }
  return deckConditionOptions.find((option) => option.shortLabel === code)?.code ?? null;
}

function watchlistBasicsFromCardRef(card: AssistantCardRef | undefined, cardId: string): WatchlistCardBasics | null {
  if (!card || card.cardId !== cardId) {
    return null;
  }
  return {
    cardId: card.cardId,
    name: card.name,
    cardNumber: card.number,
    setName: card.setName,
    imageUrl: card.imageSmallUrl ?? '',
    smallImageUrl: card.imageSmallUrl,
    marketPrice: card.priceUsd,
    currencyCode: 'USD',
    isOwned: (card.quantityOwned ?? 0) > 0,
  };
}

async function findHolding(deps: AssistantActionDeps, holdingId: string) {
  const cached = deps.inventoryEntriesCache?.find((entry) => entry.id === holdingId);
  if (cached) {
    return cached;
  }
  const entries = await deps.repository.getInventoryEntries();
  return entries.find((entry) => entry.id === holdingId) ?? null;
}

async function runAddToCollection(
  action: Extract<AssistantProposedAction, { type: 'add_to_collection' }>,
  deps: AssistantActionDeps,
) {
  const { params } = action;
  const isSlab = Boolean(params.grader);
  const condition = isSlab ? null : deckConditionFromAssistant(params.condition) ?? 'near_mint';
  const addedAt = new Date().toISOString();
  const slabContext = isSlab
    ? { grader: params.grader as string, grade: params.grade, certNumber: null, variantName: params.variantName }
    : null;
  const response = await deps.repository.createInventoryEntry({
    cardID: params.cardId,
    slabContext,
    variantName: isSlab ? null : params.variantName,
    condition,
    quantity: Math.max(1, params.quantity),
    sourceScanID: null,
    selectionSource: 'assistant',
    addedAt,
    collectionID: params.collectionId ?? deps.activeCollectionID,
  });

  // Same optimistic insert the PDP's ADD ITEM does: real entry id, so the
  // background refetch reconciles instead of duplicating.
  const card = deps.cards.find((candidate) => candidate.cardId === params.cardId);
  if (card) {
    const option = condition ? deckConditionOptions.find((entry) => entry.code === condition) ?? null : null;
    deps.prependOptimisticInventoryEntry({
      id: response.deckEntryID,
      cardId: card.cardId,
      name: card.name,
      cardNumber: card.number,
      setName: card.setName,
      imageUrl: card.imageSmallUrl ?? '',
      smallImageUrl: card.imageSmallUrl,
      // A slab's price is its grade's; leave it to the refetch.
      marketPrice: isSlab ? 0 : card.priceUsd ?? 0,
      hasMarketPrice: !isSlab && card.priceUsd != null,
      currencyCode: 'USD',
      quantity: Math.max(1, params.quantity),
      addedAt: response.addedAt || addedAt,
      kind: isSlab ? 'graded' : 'raw',
      variantName: params.variantName,
      conditionCode: condition,
      conditionLabel: option?.label ?? null,
      conditionShortLabel: option?.shortLabel ?? null,
      slabContext,
    });
  }
  invalidateCardDetailCache(params.cardId);
  deps.refreshData();
}

async function runUpdateHolding(
  action: Extract<AssistantProposedAction, { type: 'update_holding' }>,
  deps: AssistantActionDeps,
) {
  const { params } = action;
  const entry = await findHolding(deps, params.holdingId);
  if (!entry) {
    throw new AssistantActionError("That card isn't in your collection anymore.");
  }
  const nextCondition = deckConditionFromAssistant(params.condition);
  const conditionChanges = nextCondition != null && nextCondition !== (entry.conditionCode ?? 'near_mint');

  if (conditionChanges) {
    if (entry.kind !== 'raw') {
      throw new AssistantActionError("Graded cards don't have a condition to change.");
    }
    // The PDP edit sheet's path: replace (condition is part of the holding's
    // identity) carrying everything else verbatim, then re-write the cost basis
    // because replace re-derives it from `unitPrice`.
    const costBasis = entry.costBasisPerUnit ?? null;
    const result = await deps.repository.replacePortfolioEntry({
      deckEntryID: entry.id,
      cardID: entry.cardId,
      slabContext: entry.slabContext ?? null,
      variantName: entry.variantName ?? null,
      condition: nextCondition,
      quantity: params.quantity ?? entry.quantity,
      unitPrice: costBasis ?? 0,
      currencyCode: entry.currencyCode || 'USD',
      updatedAt: new Date().toISOString(),
    });
    await deps.repository.updateDeckEntryCostBasis({
      deckEntryID: result.deckEntryID,
      costBasisPerUnit: costBasis,
    });
    if (result.deckEntryID !== entry.id) {
      deps.removeOptimisticInventoryEntries([entry.id]);
    }
  } else if (params.quantity != null && params.quantity !== entry.quantity) {
    await deps.repository.setPortfolioEntryQuantity({
      deckEntryID: entry.id,
      quantity: Math.max(1, params.quantity),
    });
  }
  invalidateCardDetailCache(entry.cardId);
  deps.refreshData();
}

async function runWatchCard(
  action: Extract<AssistantProposedAction, { type: 'watch_card' }>,
  deps: AssistantActionDeps,
) {
  const { cardId, variant, targetPriceUsd } = action.params;
  const record = await deps.repository.setCardFavorite(cardId, true, { variant });
  if (!record.isFavorite) {
    throw new AssistantActionError("Couldn't add it to your Watchlist.");
  }
  const watchVariant = record.watchVariant ?? variant ?? null;
  deps.watchlistStore.applyWatchWrite(
    { ...record, watchVariant },
    watchlistBasicsFromCardRef(deps.cards.find((card) => card.cardId === cardId), cardId),
  );
  capturePostHogEvent(AnalyticsEvent.watchlistItemAdded, {
    source: 'assistant',
    kind: watchlistKindForCardId(cardId),
    has_printing: variant != null,
  });
  invalidateCardDetailCache(cardId);

  if (targetPriceUsd == null) {
    return;
  }
  const targetPriceCents = Math.round(targetPriceUsd * 100);
  const result = await deps.repository.setCardFavoriteTarget(cardId, targetPriceCents, { variant });
  if (result.status !== 'ok') {
    throw new AssistantActionError("Added to your Watchlist, but the price alert didn't save.");
  }
  const watchKey = buildWatchKey(cardId, watchVariant);
  deps.watchlistStore.setEntries((entries) =>
    entries.map((entry) => (
      entry.watchKey === watchKey ? { ...entry, targetPriceCents: result.target.targetPriceCents } : entry
    )),
  );
  capturePostHogEvent(AnalyticsEvent.watchTargetSet, { source: 'assistant', cleared: false });
}

/** Runs the real write for one action. Never throws. */
export async function runAssistantAction(
  action: AssistantProposedAction,
  deps: AssistantActionDeps,
): Promise<AssistantActionOutcome> {
  try {
    switch (action.type) {
      case 'add_to_collection':
        await runAddToCollection(action, deps);
        break;
      case 'update_holding':
        await runUpdateHolding(action, deps);
        break;
      case 'watch_card':
        await runWatchCard(action, deps);
        break;
    }
    return { status: 'done' };
  } catch (error) {
    return {
      status: 'failed',
      message: error instanceof AssistantActionError ? error.message : "Couldn't do that right now. Try again.",
    };
  }
}
