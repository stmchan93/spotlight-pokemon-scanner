import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Linking,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  deckConditionOptions,
  graderOptions,
  type CardDetailRecord,
  type CardPriceTrendList as CardPriceTrendListRecord,
  type CardPriceTrendRow,
  type DeckConditionCode,
  type InventoryCardEntry,
  type MarketHistoryOption,
  type SlabContext,
} from '@spotlight/api-client';
import { Button, IconButton, colors, useSpotlightTheme } from '@spotlight/design-system';
import { NavArrowLeft, ShareIos, Trash } from 'iconoir-react-native';

import { CardConfigurator } from '@/features/cards/components/card-configurator';
import { GradeConditionSheet } from '@/features/cards/components/grade-condition-sheet';
import { CardDetailHero } from '@/features/cards/components/card-detail-hero';
import { CardPriceTrendList } from '@/features/cards/components/card-price-trend-list';
import { CardPriceTrendSkeleton } from '@/features/cards/components/card-price-trend-skeleton';
import { CardProductDetails } from '@/features/cards/components/card-product-details';
import { buildEbaySearchUrl, buildTcgPlayerSearchUrl } from '@/features/cards/marketplace-urls';
import {
  cardDetailPreviewFromCatalogResult,
  cardDetailPreviewFromInventoryEntry,
  getCardDetailPreview,
} from '@/features/cards/card-detail-preview-session';
import {
  defaultLaneFromPreview,
  getCardDetailCached,
  getCardPriceTrendsCached,
  invalidateCardDetailCache,
  laneKey,
  type CardDetailLane,
} from '@/features/cards/card-detail-prefetch';
import {
  getScanCandidateReviewSession,
} from '@/features/scanner/scan-candidate-review-session';
import { capturePostHogEvent } from '@/lib/observability/posthog';
import { useAppServices } from '@/providers/app-providers';

function displayNumber(value?: string | null) {
  const trimmed = value?.trim();
  if (!trimmed) {
    return '--';
  }

  // Identity block shows the bare number (Figma 992-7373 / 1080-3404: "095/094",
  // no "#" prefix), so strip a leading "#" if the source includes one.
  return trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
}

// Numeric grade scale shared by PSA/BGS/CGC slab grading lanes.
const numericGradeOptions: readonly string[] = [
  '10',
  '9.5',
  '9',
  '8.5',
  '8',
  '7.5',
  '7',
  '6.5',
  '6',
  '5.5',
  '5',
  '4.5',
  '4',
  '3.5',
  '3',
  '2.5',
  '2',
  '1.5',
  '1',
] as const;

type DropdownOption = {
  id: string;
  label: string;
};

type CardDetailScreenProps = {
  cardId: string;
  entryId?: string;
  onBack: () => void;
  previewId?: string;
  scanReviewId?: string;
};

function deckConditionLabel(code: string | null): string | null {
  if (!code) {
    return null;
  }
  return deckConditionOptions.find((option) => option.code === code)?.label ?? null;
}

export function CardDetailScreen({
  cardId,
  entryId,
  onBack,
  previewId,
  scanReviewId,
}: CardDetailScreenProps) {
  const theme = useSpotlightTheme();
  const {
    spotlightRepository,
    dataVersion,
    refreshData,
    inventoryEntriesCache,
    portfolioDashboardCache,
  } = useAppServices();
  const [detail, setDetail] = useState<CardDetailRecord | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isFavoritePending, setIsFavoritePending] = useState(false);
  const [favoriteState, setFavoriteState] = useState<{ isFavorite: boolean; favoritedAt: string | null }>({
    favoritedAt: null,
    isFavorite: false,
  });
  // Configurator local state.
  const [selectedVariant, setSelectedVariant] = useState<string | null>(null);
  const [selectedGrader, setSelectedGrader] = useState<string | null>(null);
  const [selectedGrade, setSelectedGrade] = useState<string | null>(null);
  const [selectedCondition, setSelectedCondition] = useState<DeckConditionCode | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [gradeSheetOpen, setGradeSheetOpen] = useState(false);
  const [isAddPending, setIsAddPending] = useState(false);
  const [isManagePending, setIsManagePending] = useState(false);
  // The owned line the page is currently editing (sticky). null = ADD mode (the
  // card isn't owned, or the user tapped "+ Add copy" to create a new line).
  // Seeded once per card from the arrived-at entry; never recomputed from the
  // live selection, so changing the condition edits the SAME line instead of
  // flipping to ADD and duplicating it.
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);
  // True only while ADD mode was entered via "+ Add copy" from an owned card, so
  // the action row can offer a Cancel back to the line we were editing.
  const [isAddingCopy, setIsAddingCopy] = useState(false);
  const previousEditingEntryIdRef = useRef<string | null>(null);

  const [priceTrends, setPriceTrends] = useState<CardPriceTrendListRecord | null>(null);
  const [priceTrendsLoading, setPriceTrendsLoading] = useState(false);
  // The lane key (mode|variant|grader) of the most recent trend fetch, so the
  // lens-change effect refetches only when the resolved lane actually differs
  // from what the early parallel fetch already loaded (no double fetch for the
  // common raw/Normal case).
  const lastFetchedLaneKeyRef = useRef<string | null>(null);
  // Tracks the dataVersion the caches were last validated against, so a real
  // bump (pull-to-refresh / mutation) invalidates this card's cached detail +
  // trends, while the initial mount keeps any navigation-prefetched entries.
  const cacheDataVersionRef = useRef<number | null>(null);

  const scanReviewSession = useMemo(
    () => getScanCandidateReviewSession(scanReviewId),
    [scanReviewId],
  );
  const scanPreviewCandidate = useMemo(() => {
    return scanReviewSession?.candidates.find((candidate) => candidate.cardId === cardId) ?? null;
  }, [cardId, scanReviewSession]);
  const scanDetailPreview = useMemo(() => {
    return scanPreviewCandidate ? cardDetailPreviewFromCatalogResult(scanPreviewCandidate) : null;
  }, [scanPreviewCandidate]);
  const savedDetailPreview = useMemo(() => {
    const preview = getCardDetailPreview(previewId);
    return preview?.cardId === cardId ? preview : null;
  }, [cardId, previewId]);
  const dashboardDetailPreview = useMemo(() => {
    const inventoryEntry = (inventoryEntriesCache ?? portfolioDashboardCache?.inventoryItems)?.find((entry) => (
      entryId ? entry.id === entryId : entry.cardId === cardId
    ));

    return inventoryEntry ? cardDetailPreviewFromInventoryEntry(inventoryEntry) : null;
  }, [cardId, entryId, inventoryEntriesCache, portfolioDashboardCache]);
  const detailPreview = scanDetailPreview ?? savedDetailPreview ?? dashboardDetailPreview;

  useEffect(() => {
    let cancelled = false;
    setDetail((currentDetail) => (currentDetail?.cardId === cardId ? currentDetail : null));
    setErrorMessage(null);

    // Drop cached detail+trends for this card when dataVersion actually bumps
    // (refresh/mutation), but keep prefetched entries on the first mount.
    if (cacheDataVersionRef.current !== null && cacheDataVersionRef.current !== dataVersion) {
      invalidateCardDetailCache(cardId);
      lastFetchedLaneKeyRef.current = null;
    }
    cacheDataVersionRef.current = dataVersion;

    // Read through the short-TTL cache so a navigation prefetch (or a recent
    // visit) resolves instantly; otherwise this fires and populates it.
    void getCardDetailCached(spotlightRepository, cardId)
      .then((nextDetail) => {
        if (cancelled) {
          return;
        }

        if (!nextDetail) {
          setDetail(null);
          setErrorMessage('We could not find this card in the local catalog.');
          return;
        }

        setDetail(nextDetail);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }

        setErrorMessage('Could not load this card right now.');
      });

    return () => {
      cancelled = true;
    };
  }, [cardId, dataVersion, spotlightRepository]);

  useEffect(() => {
    setFavoriteState({ favoritedAt: null, isFavorite: false });
    setSelectedVariant(null);
    setSelectedGrader(null);
    setSelectedGrade(null);
    setSelectedCondition(null);
    setQuantity(1);
    setPriceTrends(null);
    setPriceTrendsLoading(false);
    setEditingEntryId(null);
    setIsAddingCopy(false);
    previousEditingEntryIdRef.current = null;
    lastFetchedLaneKeyRef.current = null;
    seededCardIdRef.current = null;
    seededVariantCardIdRef.current = null;
    seededQuantityEntryIdRef.current = null;
  }, [cardId]);

  useEffect(() => {
    if (!detail) {
      return;
    }
    setFavoriteState({
      favoritedAt: detail.favoritedAt ?? null,
      isFavorite: detail.isFavorite ?? false,
    });
  }, [detail]);

  // Owned entries for this card from the already-loaded inventory cache. The PDP
  // detail fast path resolves WITHOUT the heavy full-collection fetch (so its
  // image + variants paint immediately), so owned context comes from here.
  const cachedOwnedEntries = useMemo(() => {
    const source = inventoryEntriesCache ?? portfolioDashboardCache?.inventoryItems ?? [];
    return source.filter((entry) => entry.cardId === cardId);
  }, [cardId, inventoryEntriesCache, portfolioDashboardCache]);

  const selectedEntry = useMemo(() => {
    // Prefer authoritative owned entries if a full detail carried them; else the
    // inventory cache; else the navigation preview's single owned entry.
    const ownedPool = detail?.ownedEntries.length ? detail.ownedEntries : cachedOwnedEntries;
    if (ownedPool.length > 0) {
      return ownedPool.find((entry) => entry.id === entryId) ?? ownedPool[0] ?? null;
    }

    const previewEntry = detailPreview?.ownedEntry ?? null;
    if (!previewEntry) {
      return null;
    }

    return !entryId || previewEntry.id === entryId ? previewEntry : null;
  }, [cachedOwnedEntries, detail, detailPreview?.ownedEntry, entryId]);

  const ownedSlabContext = selectedEntry?.slabContext ?? scanReviewSession?.slabContext ?? null;

  // Variant options for the configurator: prefer catalog variantOptions, fall
  // back to the market-history available variants.
  const variantOptions = useMemo<MarketHistoryOption[]>(() => {
    const fromDetail = detail?.variantOptions ?? [];
    if (fromDetail.length > 0) {
      return fromDetail;
    }
    return detail?.marketHistory?.availableVariants ?? [];
  }, [detail?.marketHistory?.availableVariants, detail?.variantOptions]);

  // Seed grader/grade/condition defaults exactly once per card, after a source
  // (full detail or an owned-entry preview) has resolved — so the grader/grade
  // lens matches an owned slab instead of latching to the empty-state Raw
  // default. The variant default is seeded in a separate effect below because
  // variantOptions only resolves with full detail, which can land after the
  // owned-entry preview makes hasSource true.
  const seededCardIdRef = useRef<string | null>(null);
  useEffect(() => {
    const hasSource = detail != null || selectedEntry != null || ownedSlabContext != null;
    if (!hasSource || seededCardIdRef.current === cardId) {
      return;
    }
    seededCardIdRef.current = cardId;

    // Seed the sticky edit target to the line we arrived at (the tapped
    // collection entry via `entryId`, else the primary owned line). null when the
    // card isn't owned → the page stays in ADD mode.
    setEditingEntryId(selectedEntry?.id ?? null);

    if (ownedSlabContext?.grader) {
      const graderMatch = graderOptions.find(
        (option) => option.toLowerCase() === ownedSlabContext.grader.toLowerCase(),
      );
      setSelectedGrader(graderMatch ?? 'PSA');
      setSelectedGrade(ownedSlabContext.grade ?? '10');
    } else {
      setSelectedGrader('Raw');
      const ownedCondition = selectedEntry?.kind === 'raw' ? selectedEntry.conditionCode ?? null : null;
      setSelectedCondition(ownedCondition ?? deckConditionOptions[0]?.code ?? null);
    }
  }, [cardId, detail, ownedSlabContext, selectedEntry]);

  // Seed the variant default once the variant list actually resolves. Kept
  // separate from the grader seed because variantOptions is empty until full
  // detail loads — seeding it alongside an early owned-entry preview would
  // latch selectedVariant to null and never recover (the per-card guard blocks
  // re-seeding). Prefers the owned variant, then "Normal" (most cards aren't
  // holofoil and the catalog's first option isn't always Normal), then the
  // first available option.
  const seededVariantCardIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (variantOptions.length === 0 || seededVariantCardIdRef.current === cardId) {
      return;
    }
    seededVariantCardIdRef.current = cardId;

    const ownedVariant = selectedEntry?.kind === 'raw' ? selectedEntry.variantName?.trim() : null;
    const variantMatch = ownedVariant
      ? variantOptions.find((option) => option.label.toLowerCase() === ownedVariant.toLowerCase())
      : null;
    const normalVariant = variantOptions.find(
      (option) => option.label.trim().toLowerCase() === 'normal',
    );
    setSelectedVariant(variantMatch?.id ?? normalVariant?.id ?? variantOptions[0]?.id ?? null);
  }, [cardId, selectedEntry, variantOptions]);

  // Reset the per-lane selection whenever the grader switches so the grade
  // label always reflects the active lane.
  const handleSelectGrader = useCallback((grader: string) => {
    setSelectedGrader(grader);
    if (grader === 'Raw') {
      setSelectedCondition((current) => current ?? deckConditionOptions[0]?.code ?? null);
    } else {
      setSelectedGrade((current) => current ?? ownedSlabContext?.grade ?? '10');
    }
  }, [ownedSlabContext]);

  const isRawLane = selectedGrader == null || selectedGrader === 'Raw';

  // Resolve the active variant label (configurator uses option ids).
  const selectedVariantLabel = useMemo(() => {
    if (!selectedVariant) {
      return null;
    }
    return variantOptions.find((option) => option.id === selectedVariant)?.label ?? null;
  }, [selectedVariant, variantOptions]);

  // Monotonic request token. Each fetch claims the next token; only the most
  // recent token's result is applied. This survives benign effect re-runs (e.g.
  // when seeding flips selectedGrader and the early effect re-runs) — unlike a
  // per-effect cancel flag, which would drop the in-flight result. Bumped on
  // cardId change / unmount so a navigation away can't apply a stale lane.
  const trendRequestTokenRef = useRef(0);
  useEffect(() => {
    return () => {
      trendRequestTokenRef.current += 1;
    };
  }, [cardId]);

  // Shared lane fetch used by BOTH the early parallel fetch (on mount, from the
  // preview's default lane — no waiting on variantOptions/seeding) and the
  // lens-change fetch (after the user switches grader/variant). Reads through
  // the short-TTL cache, flips the loading flag, and records the fetched lane
  // key so the lens-change effect can skip a redundant refetch.
  const fetchTrendsForLane = useCallback(
    (lane: CardDetailLane) => {
      const key = laneKey(cardId, lane);
      lastFetchedLaneKeyRef.current = key;
      const token = trendRequestTokenRef.current + 1;
      trendRequestTokenRef.current = token;
      setPriceTrendsLoading(true);
      return getCardPriceTrendsCached(spotlightRepository, cardId, lane)
        .then((next) => {
          if (trendRequestTokenRef.current !== token) {
            return;
          }
          setPriceTrends(next);
          setPriceTrendsLoading(false);
        })
        .catch(() => {
          if (trendRequestTokenRef.current !== token) {
            return;
          }
          // Allow a later lens change / refresh to retry this lane.
          if (lastFetchedLaneKeyRef.current === key) {
            lastFetchedLaneKeyRef.current = null;
          }
          setPriceTrends(null);
          setPriceTrendsLoading(false);
        });
    },
    [cardId, spotlightRepository],
  );

  // EARLY parallel fetch: as soon as the card id + early owned context are
  // known, fetch the default lane (computed from the preview, mirroring the
  // grader/variant seeds) IN PARALLEL with getCardDetail — without waiting for
  // variantOptions or the seeding effects to settle. Guarded by the lane-key
  // ref so it fires at most once per lane.
  useEffect(() => {
    // Once the lane is resolved/seeded (selectedGrader set), the lens-change
    // effect owns fetching — so don't let the default lane stomp a graded lens
    // on a dataVersion bump. This only kicks off the pre-seed default fetch.
    if (selectedGrader != null) {
      return;
    }
    const lane = defaultLaneFromPreview(detailPreview);
    if (lastFetchedLaneKeyRef.current === laneKey(cardId, lane)) {
      return;
    }
    void fetchTrendsForLane(lane);
    // Intentionally keyed on cardId + the early lane signal only, NOT on the
    // seeded selection state, so it runs before seeding completes.
  }, [cardId, dataVersion, detailPreview, fetchTrendsForLane, selectedGrader]);

  // LENS-CHANGE fetch: once the user's lane resolves (grader/variant seeded or
  // changed), refetch ONLY when it differs from the lane already fetched. The
  // common raw/Normal default matches the early fetch's lane key, so this is a
  // no-op there (no double fetch); switching grader/variant refetches the new
  // lane.
  useEffect(() => {
    if (!detail || selectedGrader == null) {
      return;
    }
    const lane: CardDetailLane = {
      mode: isRawLane ? 'raw' : 'graded',
      variant: isRawLane ? (selectedVariantLabel ?? null) : null,
      grader: isRawLane ? null : selectedGrader,
    };
    if (lastFetchedLaneKeyRef.current === laneKey(cardId, lane)) {
      return;
    }
    void fetchTrendsForLane(lane);
  }, [cardId, detail, fetchTrendsForLane, isRawLane, selectedGrader, selectedVariantLabel]);

  // Tap a Price-Trend row → open the marketplace for that exact grade/condition.
  // Raw rows deep-link to a TCGplayer search (filtered to the condition + printing) —
  // instant, no network. Graded rows resolve the most-recent eBay SOLD listing for
  // that card+grader+grade via Scrydex (cached 24h on the backend, and per-row here),
  // then open it. The row `key` carries the structured identity:
  //   graded: "<grader>|<grade>|<variantKey>"   raw: "<variantKey>|<condition>"
  const handleTrendRowPress = useCallback((row: CardPriceTrendRow) => {
    if (!detail || !priceTrends) {
      return;
    }

    if (priceTrends.mode === 'graded') {
      // The graded row key format varies by backend version: "PSA 10" (space) on
      // staging vs "PSA|10|<variant>" (pipe) on newer builds. Normalize pipes to
      // spaces and take the first two tokens so both shapes yield grader + grade.
      const [grader, grade] = row.key.replace(/\|/g, ' ').trim().split(/\s+/);
      if (!grader || !grade) {
        return;
      }
      // Open eBay's sold + completed listings for this exact graded card so the user
      // sees the recent SALES (most-recent first) on eBay itself, instead of jumping
      // to a single most-recent listing.
      const ebayUrl = buildEbaySearchUrl({
        name: detail.name,
        cardNumber: detail.cardNumber,
        setName: detail.setName,
        grader,
        grade,
      });
      if (ebayUrl) {
        capturePostHogEvent('pricing_link_opened', { marketplace: 'ebay', lane: 'graded' });
        void Linking.openURL(ebayUrl);
      }
      return;
    }

    // Raw lane → TCGplayer product search for this exact card, filtered to the tapped
    // condition (Near Mint, etc.) so the user lands on that grade's price. The raw row
    // key is the bare condition code ("NM", staging) or "<variant>|<condition>" (pipe);
    // the condition is the last non-empty segment in both shapes.
    //
    // We deliberately keep Condition but NOT Printing: the Printing facet over-constrains
    // promos (their printing rarely matches TCGplayer's categorization), zeroing results
    // so TCGplayer falls back to unrelated popular cards (a Mew promo surfacing Charizard).
    const condition = row.key.split('|').filter(Boolean).pop() ?? null;
    const url = buildTcgPlayerSearchUrl({
      name: detail.name,
      cardNumber: detail.cardNumber,
      setName: detail.setName,
      condition,
    });
    if (url) {
      capturePostHogEvent('pricing_link_opened', { marketplace: 'tcgplayer', lane: 'raw' });
      void Linking.openURL(url);
    }
  }, [detail, priceTrends]);

  // Tap the provider logo (eBay / TCGplayer) in the Price-Trend header → open the
  // marketplace for the grade/grader currently selected on the PDP (the dropdown),
  // mirroring the per-row deep-links but keyed off the live configurator selection:
  //   raw lane    → TCGplayer search filtered to Near Mint (the standard raw price)
  //   graded lane → eBay sold + completed listings for the selected grader + grade
  // so switching the dropdown to "CGC 9.5" makes the eBay link land on CGC 9.5.
  const handleProviderPress = useCallback(() => {
    if (!detail || !priceTrends) {
      return;
    }

    if (priceTrends.mode === 'graded') {
      // Prefer the dropdown's live grader+grade; if it hasn't seeded yet, fall
      // back to the top graded row so the tap is never a dead end.
      let grader = selectedGrader;
      let grade = selectedGrade;
      if (!grader || grader === 'Raw' || !grade) {
        const [rowGrader, rowGrade] = (priceTrends.rows[0]?.key ?? '')
          .replace(/\|/g, ' ')
          .trim()
          .split(/\s+/);
        grader = grader && grader !== 'Raw' ? grader : rowGrader;
        grade = grade ?? rowGrade;
      }
      if (!grader || grader === 'Raw' || !grade) {
        return;
      }
      const ebayUrl = buildEbaySearchUrl({
        name: detail.name,
        cardNumber: detail.cardNumber,
        setName: detail.setName,
        grader,
        grade,
      });
      if (ebayUrl) {
        capturePostHogEvent('pricing_link_opened', { marketplace: 'ebay', lane: 'graded' });
        void Linking.openURL(ebayUrl);
      }
      return;
    }

    // Raw lane → TCGplayer Near Mint (printing intentionally omitted; see
    // handleTrendRowPress for why the Printing facet zeroes out promos).
    const url = buildTcgPlayerSearchUrl({
      name: detail.name,
      cardNumber: detail.cardNumber,
      setName: detail.setName,
      condition: 'Near Mint',
    });
    if (url) {
      capturePostHogEvent('pricing_link_opened', { marketplace: 'tcgplayer', lane: 'raw' });
      void Linking.openURL(url);
    }
  }, [detail, priceTrends, selectedGrade, selectedGrader]);

  const handleToggleFavorite = useCallback(() => {
    if (isFavoritePending) {
      return;
    }

    const previousFavoriteState = favoriteState;
    const nextIsFavorite = !favoriteState.isFavorite;
    setFavoriteState((current) => ({ ...current, isFavorite: nextIsFavorite }));
    setIsFavoritePending(true);

    void spotlightRepository.setCardFavorite(cardId, nextIsFavorite)
      .then((result) => {
        setFavoriteState({
          favoritedAt: result.favoritedAt ?? null,
          isFavorite: result.isFavorite,
        });
        setIsFavoritePending(false);
        // The short-TTL detail cache still holds the pre-toggle `isFavorite`;
        // without this, reopening the PDP within the TTL shows the stale heart
        // state (favorite persisted to the wishlist but the cached card detail
        // didn't). Drop it so the next open refetches the true favorite state.
        invalidateCardDetailCache(cardId);
      })
      .catch(() => {
        setFavoriteState(previousFavoriteState);
        setErrorMessage('Could not update wishlist right now.');
        setIsFavoritePending(false);
      });
  }, [cardId, favoriteState, isFavoritePending, spotlightRepository]);

  const hasDisplayContent = detail != null || detailPreview != null;

  const displayName = detail?.name ?? detailPreview?.name ?? '';
  const displayImageUrl = detail?.largeImageUrl
    ?? detail?.imageUrl
    ?? detailPreview?.largeImageUrl
    ?? detailPreview?.imageUrl
    ?? null;
  const displayCardNumber = detail?.cardNumber ?? detailPreview?.cardNumber ?? '';
  const displaySetName = detail?.setName ?? detailPreview?.setName ?? '';

  // Carried into the log-transaction flow as the note so a bought/sold/traded
  // entry started from this card keeps its identity.
  const transactionLabel = [displayName, displayCardNumber, displaySetName]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' · ');

  const marketplaceUrl = useMemo(() => buildTcgPlayerSearchUrl({
    cardNumber: displayCardNumber,
    name: displayName,
    setName: displaySetName,
    condition: deckConditionLabel(selectedCondition),
    printing: selectedVariantLabel,
  }), [displayCardNumber, displayName, displaySetName, selectedCondition, selectedVariantLabel]);

  const handleShare = useCallback(() => {
    const message = [transactionLabel, marketplaceUrl].filter(Boolean).join('\n');
    if (!message) {
      return;
    }
    void Share.share(
      marketplaceUrl
        ? { message, url: marketplaceUrl }
        : { message },
    ).catch(() => undefined);
  }, [marketplaceUrl, transactionLabel]);

  // Builds the slab context for the configured ADD ITEM action.
  const configuredSlabContext = useMemo<SlabContext | null>(() => {
    if (isRawLane || !selectedGrader) {
      return null;
    }
    return {
      grader: selectedGrader,
      grade: selectedGrade,
      certNumber: null,
      variantName: selectedGrade ? `${selectedGrader} ${selectedGrade}` : null,
    };
  }, [isRawLane, selectedGrade, selectedGrader]);

  const handleAddItem = useCallback(() => {
    // ADD ITEM is disabled until `detail` resolves, so this always runs with a
    // loaded card — add it directly with the variant/condition shown on the page.
    if (isAddPending || !detail) {
      return;
    }
    setIsAddPending(true);
    void spotlightRepository.createInventoryEntry({
      cardID: detail.cardId,
      slabContext: configuredSlabContext,
      variantName: isRawLane ? (selectedVariantLabel ?? null) : null,
      condition: isRawLane ? selectedCondition : null,
      quantity: Math.max(1, quantity),
      sourceScanID: null,
      addedAt: new Date().toISOString(),
    })
      .then((response) => {
        capturePostHogEvent('card_detail_add_item_succeeded', {
          kind: isRawLane ? 'raw' : 'graded',
          quantity: Math.max(1, quantity),
        });
        // The card is now owned → switch the page into edit mode for the new (or
        // merged) line so the same controls update it from here on.
        setIsAddingCopy(false);
        setEditingEntryId(response.deckEntryID);
        refreshData();
      })
      .catch(() => {
        setErrorMessage('Could not add this card right now.');
      })
      .finally(() => {
        setIsAddPending(false);
      });
  }, [
    configuredSlabContext,
    detail,
    isAddPending,
    isRawLane,
    quantity,
    refreshData,
    selectedCondition,
    selectedVariantLabel,
    spotlightRepository,
  ]);

  // All owned lines for this card (full detail → inventory cache → nav preview).
  const ownedEntries = useMemo(() => {
    if (detail?.ownedEntries?.length) {
      return detail.ownedEntries;
    }
    if (cachedOwnedEntries.length) {
      return cachedOwnedEntries;
    }
    return detailPreview?.ownedEntry ? [detailPreview.ownedEntry] : [];
  }, [cachedOwnedEntries, detail?.ownedEntries, detailPreview?.ownedEntry]);

  // Does the CURRENT configurator selection still describe `entry`'s identity?
  // Used to tell a quantity-only edit (→ setQuantity) from an attribute change
  // (→ replace, which rewrites the line in place). Mirrors the seed defaults so a
  // raw entry stored without a variant/condition still matches the seeded
  // "Normal" + default-condition lane.
  const selectionMatchesEntry = useCallback(
    (entry: InventoryCardEntry) => {
      if (isRawLane !== (entry.kind === 'raw')) {
        return false;
      }
      if (isRawLane) {
        const ownedName = entry.kind === 'raw' ? (entry.variantName ?? '').trim() : '';
        const ownedVariantId = (ownedName
          ? variantOptions.find((option) => option.label.toLowerCase() === ownedName.toLowerCase())?.id
          : undefined)
          ?? variantOptions.find((option) => option.label.trim().toLowerCase() === 'normal')?.id
          ?? variantOptions[0]?.id
          ?? null;
        const ownedCondition = entry.conditionCode ?? deckConditionOptions[0]?.code ?? null;
        return ownedVariantId === selectedVariant && ownedCondition === selectedCondition;
      }
      const ownedGrader = (entry.slabContext?.grader ?? '').trim().toLowerCase();
      const ownedGrade = (entry.slabContext?.grade ?? '').trim().toLowerCase();
      return ownedGrader === (selectedGrader ?? '').trim().toLowerCase()
        && ownedGrade === (selectedGrade ?? '').trim().toLowerCase();
    },
    [isRawLane, selectedCondition, selectedGrade, selectedGrader, selectedVariant, variantOptions],
  );

  // The line being edited (sticky — driven by editingEntryId, not the live
  // selection). null id ⇒ ADD mode. isManaged keys off the id (not the resolved
  // entry) so the edit UI doesn't flicker to ADD during a post-mutation refresh.
  const editingEntry = useMemo(() => {
    if (!editingEntryId) {
      return null;
    }
    const exact = ownedEntries.find((entry) => entry.id === editingEntryId);
    if (exact) {
      return exact;
    }
    // After add/replace the backend returns a `deckEntryID` that may not equal the
    // card-detail entry id (the two come from different endpoints with different id
    // forms). Without this, the just-added line never resolves, leaving SAVE
    // permanently disabled. When exactly one line is owned the edit target is
    // unambiguous, so resolve to it instead of stranding the editor.
    return ownedEntries.length === 1 ? ownedEntries[0] : null;
  }, [editingEntryId, ownedEntries]);
  const isManaged = editingEntryId != null;

  // SAVE is enabled only when the pending edit differs from what's stored — an
  // attribute change (condition/variant/grade) or a quantity change.
  const isDirty = useMemo(() => {
    if (!editingEntry) {
      return false;
    }
    if (!selectionMatchesEntry(editingEntry)) {
      return true;
    }
    return Math.max(1, quantity) !== editingEntry.quantity;
  }, [editingEntry, quantity, selectionMatchesEntry]);

  // TEMP DIAGNOSTIC (remove once the "SAVE stuck disabled after Add" report is
  // pinned): fire only in the genuinely-stuck state — managed mode, detail
  // loaded, but the edit target never resolved (so SAVE can never enable). The
  // payload distinguishes the candidate causes: ownedEntryCount===0 means the
  // refetched list never surfaced the new line; a routeCardId/detailCardId/
  // ownedEntryCardIds mismatch means the cardId filter dropped it; editingEntryId
  // absent from ownedEntryIds despite count>0 would mean a true id mismatch.
  const diagnosedEditTargetRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isManaged || !editingEntryId || !detail || editingEntry != null) {
      return;
    }
    if (diagnosedEditTargetRef.current === editingEntryId) {
      return;
    }
    diagnosedEditTargetRef.current = editingEntryId;
    capturePostHogEvent('card_detail_edit_target_unresolved', {
      routeCardId: cardId,
      detailCardId: detail.cardId,
      editingEntryId,
      ownedEntryCount: ownedEntries.length,
      ownedEntryIds: ownedEntries.map((entry) => entry.id),
      ownedEntryCardIds: ownedEntries.map((entry) => entry.cardId),
    });
  }, [isManaged, editingEntryId, detail, editingEntry, ownedEntries, cardId]);

  // Seed the stepper from the edited line's real quantity (min 1), once per
  // target. The id ref guard keeps manual −/+ edits from being clobbered on
  // re-render; ADD mode (no target) resets to 1.
  const seededQuantityEntryIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (editingEntryId == null) {
      if (seededQuantityEntryIdRef.current !== null) {
        seededQuantityEntryIdRef.current = null;
        setQuantity(1);
      }
      return;
    }
    // Wait for the entry to resolve so we seed its real quantity, not a stale 1.
    if (!editingEntry || seededQuantityEntryIdRef.current === editingEntryId) {
      return;
    }
    seededQuantityEntryIdRef.current = editingEntryId;
    setQuantity(Math.max(1, editingEntry.quantity));
  }, [editingEntry, editingEntryId]);

  // SAVE: commit the pending edit to the active line. A quantity-only change sets
  // the holding; an attribute change rewrites the line via replace (the backend
  // merges into an existing matching line and returns its id — so adopt the
  // returned id as the new edit target).
  const handleSave = useCallback(() => {
    if (isManagePending || !editingEntry || !isDirty) {
      return;
    }
    const nextQuantity = Math.max(1, quantity);
    const attrsChanged = !selectionMatchesEntry(editingEntry);
    setIsManagePending(true);
    const request = attrsChanged
      ? spotlightRepository
          .replacePortfolioEntry({
            deckEntryID: editingEntry.id,
            cardID: editingEntry.cardId,
            slabContext: configuredSlabContext,
            variantName: isRawLane ? (selectedVariantLabel ?? null) : null,
            condition: isRawLane ? selectedCondition : null,
            quantity: nextQuantity,
            unitPrice: editingEntry.costBasisPerUnit ?? 0,
            currencyCode: editingEntry.currencyCode ?? 'USD',
            updatedAt: new Date().toISOString(),
          })
          .then((response) => {
            seededQuantityEntryIdRef.current = null;
            setEditingEntryId(response.deckEntryID);
          })
      : spotlightRepository.setPortfolioEntryQuantity({
          deckEntryID: editingEntry.id,
          quantity: nextQuantity,
        });
    void request
      .then(() => {
        capturePostHogEvent('card_detail_update_item_succeeded', {
          attrsChanged,
          kind: isRawLane ? 'raw' : 'graded',
          quantity: nextQuantity,
        });
        refreshData();
      })
      .catch(() => {
        setErrorMessage('Could not update this card right now.');
      })
      .finally(() => {
        setIsManagePending(false);
      });
  }, [
    configuredSlabContext,
    editingEntry,
    isDirty,
    isManagePending,
    isRawLane,
    quantity,
    refreshData,
    selectedCondition,
    selectedVariantLabel,
    selectionMatchesEntry,
    spotlightRepository,
  ]);

  // REMOVE: delete the active line, then drop to the next owned line (if any) or
  // ADD mode.
  const handleRemove = useCallback(() => {
    if (isManagePending || !editingEntry) {
      return;
    }
    const removedId = editingEntry.id;
    setIsManagePending(true);
    void spotlightRepository
      .deletePortfolioEntry({ deckEntryID: removedId })
      .then(() => {
        const remaining = ownedEntries.filter((entry) => entry.id !== removedId);
        seededQuantityEntryIdRef.current = null;
        setIsAddingCopy(false);
        setEditingEntryId(remaining[0]?.id ?? null);
        refreshData();
      })
      .catch(() => {
        setErrorMessage('Could not remove this card right now.');
      })
      .finally(() => {
        setIsManagePending(false);
      });
  }, [editingEntry, isManagePending, ownedEntries, refreshData, spotlightRepository]);

  // "+ Add copy": leave the edited line untouched and drop to ADD mode so the
  // user can create a SEPARATE line (e.g. own NM and LP). Cancel restores it.
  const handleAddCopy = useCallback(() => {
    previousEditingEntryIdRef.current = editingEntryId;
    setIsAddingCopy(true);
    setEditingEntryId(null);
  }, [editingEntryId]);

  const handleCancelAddCopy = useCallback(() => {
    setIsAddingCopy(false);
    setEditingEntryId(previousEditingEntryIdRef.current);
  }, []);

  // Grade/Condition dropdown wiring for the configurator.
  // Both lanes title this section "Grade" per Figma (992-7373 graded /
  // 1080-3404 raw); the raw dropdown still lists conditions (Near Mint…Damaged).
  const gradeTitle = 'Grade';
  const gradeLabel = isRawLane
    ? deckConditionLabel(selectedCondition)
    : (selectedGrade ? `${selectedGrader} ${selectedGrade}` : null);
  const gradePickerOptions = useMemo<DropdownOption[]>(() => {
    if (isRawLane) {
      return deckConditionOptions.map((option) => ({ id: option.code, label: option.label }));
    }
    return numericGradeOptions.map((grade) => ({ id: grade, label: `${selectedGrader} ${grade}` }));
  }, [isRawLane, selectedGrader]);
  const gradePickerSelectedId = isRawLane ? selectedCondition : selectedGrade;
  const handleGradePick = useCallback((id: string) => {
    if (isRawLane) {
      setSelectedCondition(id as DeckConditionCode);
    } else {
      setSelectedGrade(id);
    }
  }, [isRawLane]);

  const isFavorite = favoriteState.isFavorite;

  if (!hasDisplayContent && !errorMessage) {
    return (
      <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.gray0 }]}>
        <View style={styles.loadingState}>
          <Text style={theme.typography.headline}>Loading card...</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!hasDisplayContent) {
    return (
      <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.gray0 }]}>
        <View style={styles.loadingState}>
          <Text style={theme.typography.headline}>Card unavailable</Text>
          <Text style={[theme.typography.body, styles.errorCopy]}>{errorMessage}</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView
      edges={['top', 'left', 'right', 'bottom']}
      style={[styles.safeArea, { backgroundColor: colors.gray0 }]}
    >
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.headerRow}>
          <IconButton
            accessibilityLabel="Go back"
            onPress={onBack}
            shape="circle"
            size={36}
            testID="detail-back"
            variant="subtle"
          >
            <NavArrowLeft color={theme.colors.gray900} height={24} width={24} />
          </IconButton>
          <Text
            numberOfLines={1}
            style={[theme.typography.titleMedium, styles.headerTitle]}
            testID="detail-header-title"
          >
            {displayName}
          </Text>
          <IconButton
            accessibilityLabel="Share this card"
            onPress={handleShare}
            shape="circle"
            size={36}
            testID="detail-share"
            variant="subtle"
          >
            <ShareIos color={theme.colors.gray900} height={20} width={20} />
          </IconButton>
        </View>

        <CardDetailHero
          imageUrl={displayImageUrl}
          isFavorite={isFavorite}
          name={displayName}
          onToggleFavorite={handleToggleFavorite}
          testID="detail-hero-card"
        />

        <View style={styles.identityBlock} testID="detail-identity">
          <Text style={theme.typography.titleLarge} testID="detail-name">
            {displayName}
          </Text>
          <Text style={[theme.typography.bodyMedium, styles.identityMeta]}>
            {displayNumber(displayCardNumber)}
          </Text>
          <Text style={[theme.typography.bodyMedium, styles.identityMeta]}>
            {displaySetName}
          </Text>
        </View>

        <View style={styles.actionSection}>
          <View style={styles.actionRow}>
            {isManaged ? (
              // Owned: SAVE commits the pending edit to THIS line (quantity, or
              // condition/variant via replace). Enabled only when something
              // changed. Never silently turns into ADD.
              <Button
                disabled={isManagePending || !detail || !isDirty}
                label="SAVE"
                labelStyleVariant="label"
                onPress={handleSave}
                shape="rounded"
                size="md"
                style={styles.actionButton}
                testID="detail-update-item"
                variant="accent"
              />
            ) : (
              <Button
                // Disabled until the card resolves so ADD ITEM is always a direct
                // add with the on-page variant/condition (never the old sheet).
                disabled={isAddPending || !detail}
                label="ADD ITEM"
                labelStyleVariant="label"
                onPress={handleAddItem}
                shape="rounded"
                size="md"
                style={styles.actionButton}
                testID="detail-add-item"
                variant="accent"
              />
            )}
          </View>
          {isManaged ? (
            // Secondary row mirrors the primary action row's shell (md / rounded /
            // outline) so the controls read as one consistent set. UX polish TBD.
            <View style={styles.actionRow}>
              <Button
                disabled={isManagePending}
                label="+ Add copy"
                labelStyleVariant="label"
                onPress={handleAddCopy}
                shape="rounded"
                size="md"
                style={styles.actionButton}
                testID="detail-add-copy"
                variant="outline"
              />
              <Button
                disabled={isManagePending}
                label="Remove"
                labelStyle={{ color: theme.colors.dangerStrong }}
                labelStyleVariant="label"
                leadingAccessory={<Trash color={theme.colors.dangerStrong} height={18} width={18} />}
                onPress={handleRemove}
                shape="rounded"
                size="md"
                style={styles.actionButton}
                testID="detail-remove-item"
                variant="outline"
              />
            </View>
          ) : isAddingCopy ? (
            // ADD mode reached via "+ Add copy": offer a way back to the line we
            // were editing.
            <View style={styles.manageRow}>
              <Button
                disabled={isAddPending}
                label="Cancel"
                labelStyleVariant="label"
                onPress={handleCancelAddCopy}
                size="sm"
                style={styles.manageLink}
                testID="detail-cancel-add-copy"
                variant="ghost"
              />
            </View>
          ) : null}
        </View>

        <CardConfigurator
          gradeLabel={gradeLabel}
          gradeTitle={gradeTitle}
          graders={[...graderOptions]}
          onDecrement={() => setQuantity((current) => Math.max(1, current - 1))}
          onIncrement={() => setQuantity((current) => current + 1)}
          onOpenGradePicker={() => setGradeSheetOpen(true)}
          onSelectGrader={handleSelectGrader}
          onSelectVariant={setSelectedVariant}
          quantity={quantity}
          selectedGrader={selectedGrader}
          selectedVariant={selectedVariant}
          testID="detail-configurator"
          variants={variantOptions}
          variantsLoading={detail == null && errorMessage == null}
        />

        <GradeConditionSheet
          onClose={() => setGradeSheetOpen(false)}
          onSelect={handleGradePick}
          options={gradePickerOptions}
          selectedId={gradePickerSelectedId}
          testID="detail-grade-sheet"
          title={gradeTitle}
          visible={gradeSheetOpen}
        />

        {priceTrends && priceTrends.rows.length > 0 ? (
          <View style={styles.trendBlock}>
            <CardPriceTrendList
              list={priceTrends}
              onProviderPress={handleProviderPress}
              onRowPress={handleTrendRowPress}
              testID="detail-price-trends"
            />
          </View>
        ) : priceTrendsLoading ? (
          <View style={styles.trendBlock}>
            <CardPriceTrendSkeleton testID="detail-price-trends-skeleton" />
          </View>
        ) : null}

        {detail?.cardText ? (
          <CardProductDetails cardText={detail.cardText} testID="detail-product-details" />
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  actionButton: {
    flex: 1,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 12,
  },
  actionSection: {
    gap: 8,
  },
  manageLink: {
    borderWidth: 0,
    paddingHorizontal: 4,
  },
  manageRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 4,
  },
  content: {
    // 32px between stacked sections (Figma PDP): actions↔configurator,
    // configurator↔price-trend, price-trend↔product-details, etc.
    gap: 32,
    paddingBottom: 120,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  errorCopy: {
    marginTop: 8,
    textAlign: 'center',
  },
  headerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'space-between',
  },
  headerTitle: {
    flex: 1,
    textAlign: 'center',
  },
  identityBlock: {
    gap: 4,
  },
  identityMeta: {
    color: colors.gray600,
  },
  loadingState: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  safeArea: {
    flex: 1,
  },
  trendBlock: {
    gap: 10,
    width: '100%',
  },
});
