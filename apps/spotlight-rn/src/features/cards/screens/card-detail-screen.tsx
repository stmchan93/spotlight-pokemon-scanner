import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Keyboard,
  Linking,
  Share,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import Animated, {
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';

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

import { AddToCollectionSheet } from '@/features/cards/components/add-to-collection-sheet';
import { ConfirmDeleteSheet } from '@/features/cards/components/confirm-delete-sheet';
import {
  GradeConditionSheet,
  type GradeConditionOption,
} from '@/features/cards/components/grade-condition-sheet';
import { OwnedEntryEditFields } from '@/features/cards/components/owned-entry-edit-fields';
import { CardConfigurator } from '@/features/cards/components/card-configurator';
import { CardDetailHero } from '@/features/cards/components/card-detail-hero';
import { CardPopulationReport } from '@/features/cards/components/card-population-report';
import { CardWishlistCounter } from '@/features/cards/components/card-wishlist-counter';
import { CardPriceTrendList } from '@/features/cards/components/card-price-trend-list';
import { CardPriceTrendSkeleton } from '@/features/cards/components/card-price-trend-skeleton';
import { CardProductDetails } from '@/features/cards/components/card-product-details';
import {
  buildEbaySearchUrl,
  buildTcgPlayerProductUrl,
  buildTcgPlayerSearchUrl,
  resolveTcgPlayerProductId,
} from '@/features/cards/marketplace-urls';
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
  prefetchCardDetail,
  type CardDetailLane,
} from '@/features/cards/card-detail-prefetch';
import {
  getScanCandidateReviewSession,
} from '@/features/scanner/scan-candidate-review-session';
import { formatCurrency } from '@/features/portfolio/components/portfolio-formatting';
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

// Catalog release dates arrive as "YYYY/MM/DD" / "YYYY-MM-DD" (or a bare year).
// Render like the Figma identity line ("Jun 10, 2000"); fall back to the year,
// then the raw string. Built from local Y/M/D parts to avoid a UTC off-by-one.
function formatReleaseDate(value?: string | null): string | null {
  const raw = (value ?? '').trim();
  if (!raw) {
    return null;
  }
  const ymd = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (ymd) {
    const date = new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]));
    if (!Number.isNaN(date.getTime())) {
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }
  }
  const yearMatch = raw.match(/\b(\d{4})\b/);
  return yearMatch ? yearMatch[1] : raw;
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

// EN/JP language selector (Figma 1640:4087). Pre-fills to English; a JP card's
// PDP can switch the lens to Japanese. UI-only for now (not sent to the backend).
const languageOptions: readonly string[] = ['EN', 'JP'] as const;

// Reddit-style auto-hiding bars (px deltas, tuned by feel on-device). Scrolling
// down past DOWN_HIDE_DELTA hides the top/bottom bars; they stay hidden on a slow
// scroll up and only re-appear on an up-flick faster than FAST_UP_REVEAL_DELTA per
// frame, or once you're within TOP_REVEAL_THRESHOLD of the top.
const TOP_REVEAL_THRESHOLD = 8;
const SCROLL_DOWN_HIDE_DELTA = 2;
const FAST_UP_REVEAL_DELTA = 9;

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
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const {
    spotlightRepository,
    dataVersion,
    refreshData,
    inventoryEntriesCache,
    portfolioDashboardCache,
    prependOptimisticInventoryEntry,
    removeOptimisticInventoryEntries,
  } = useAppServices();
  // The card currently DISPLAYED. Starts as the routed `cardId`, but the EN/JP
  // language toggle repoints it to the other-language counterpart IN PLACE (no
  // navigation), so every card-derived fetch keys off this, not the route prop.
  const [activeCardId, setActiveCardId] = useState(cardId);
  // Optimistic chip highlight during a swap, before the counterpart detail (and
  // its real `language`) lands. Cleared once the new detail arrives.
  const [languageOverride, setLanguageOverride] = useState<string | null>(null);
  const [detail, setDetail] = useState<CardDetailRecord | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isFavoritePending, setIsFavoritePending] = useState(false);
  const [favoriteState, setFavoriteState] = useState<{ isFavorite: boolean; favoritedAt: string | null }>({
    favoritedAt: null,
    isFavorite: false,
  });
  // Public wishlist count shown as social proof; mutates optimistically
  // alongside the favorite toggle.
  const [likeCount, setLikeCount] = useState(0);
  // Configurator local state.
  const [selectedVariant, setSelectedVariant] = useState<string | null>(null);
  const [selectedGrader, setSelectedGrader] = useState<string | null>(null);
  const [selectedGrade, setSelectedGrade] = useState<string | null>(null);
  const [selectedCondition, setSelectedCondition] = useState<DeckConditionCode | null>(null);
  const [quantity, setQuantity] = useState(1);
  // The "Add to Collection" sheet hosts Grade + Quantity (moved out of the
  // always-visible configurator). Opened by ADD ITEM (add) or Edit (owned line).
  const [addSheetOpen, setAddSheetOpen] = useState(false);
  // The add sheet owns its OWN variant/grader/grade/condition, seeded from the page
  // when it opens. Editing the sheet must NOT change what the PDP shows behind it.
  const [addVariant, setAddVariant] = useState<string | null>(null);
  const [addGrader, setAddGrader] = useState<string | null>(null);
  const [addGrade, setAddGrade] = useState<string | null>(null);
  const [addCondition, setAddCondition] = useState<DeckConditionCode | null>(null);
  // The add sheet also owns its OWN language (EN/JP). Toggling it re-targets
  // which card the ADD writes to (this card vs its other-language counterpart)
  // but must NEVER swap the PDP behind the sheet. null = follow the page.
  const [addLanguageChip, setAddLanguageChip] = useState<string | null>(null);
  // The counterpart's detail, loaded sheet-locally when the sheet's language
  // targets it — the page's `detail` stays untouched.
  const [addCounterpartDetail, setAddCounterpartDetail] = useState<CardDetailRecord | null>(null);
  const [isAddPending, setIsAddPending] = useState(false);
  // Confirm-delete bottom sheet for an OWNED entry (Figma 1874:23102 "Delete from
  // PDP"): the trash affordance in the header opens it; CONFIRM removes the entry.
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [isDeletePending, setIsDeletePending] = useState(false);
  // Owned-card inline edit mode (Figma 1874:21729): Quantity + Cost Basis edited
  // on the page; Variant/Grader/Grade/Condition reuse the page configurator state.
  // SAVE persists via replace + cost-basis; the grade/condition picker is hosted
  // here. Seeded from the owned entry once per entry id.
  const [editQuantity, setEditQuantity] = useState(1);
  const [editCostBasisText, setEditCostBasisText] = useState('');
  const [editGradePickerOpen, setEditGradePickerOpen] = useState(false);
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const seededEditEntryIdRef = useRef<string | null>(null);
  // Once the user edits Cost Basis, a background data refresh (which can swap the
  // selectedEntry reference / id) must not silently reset what they typed.
  const editCostBasisDirtyRef = useRef(false);

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
  // On an EN/JP swap, the variant LABEL the user had selected — re-resolved
  // against the counterpart card's (differently-id'd) variant list by name.
  const pendingVariantLabelRef = useRef<string | null>(null);
  // Same idea for the Add sheet's OWN variant: the sheet's EN/JP toggle (which
  // re-targets the ADD, never the page) re-resolves `addVariant` against the
  // target card's options by name (the sheet's variant is independent of the
  // page's, so it needs its own carry-over).
  const pendingAddVariantLabelRef = useRef<string | null>(null);

  // Defensive: keep activeCardId in sync if the route prop ever changes without a
  // remount. Normally the route `key` remounts the screen, so this is inert; it
  // never fires during an in-place language swap (the prop stays put then).
  useEffect(() => {
    setActiveCardId(cardId);
  }, [cardId]);

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
    setErrorMessage(null);
    // Intentionally do NOT null `detail` here: on a language swap (activeCardId
    // changes mid-mount) keeping the prior card visible until the counterpart
    // detail resolves avoids a blank "Loading card…" flash. The fetch below
    // replaces it; the request token guards against a stale result landing late.

    // Drop cached detail+trends for this card when dataVersion actually bumps
    // (refresh/mutation), but keep prefetched entries on the first mount.
    if (cacheDataVersionRef.current !== null && cacheDataVersionRef.current !== dataVersion) {
      invalidateCardDetailCache(activeCardId);
      lastFetchedLaneKeyRef.current = null;
    }
    cacheDataVersionRef.current = dataVersion;

    // Read through the short-TTL cache so a navigation prefetch (or a recent
    // visit) resolves instantly; otherwise this fires and populates it.
    void getCardDetailCached(spotlightRepository, activeCardId)
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
  }, [activeCardId, dataVersion, spotlightRepository]);

  // Per-MOUNT reset, keyed on the route prop `cardId` (NOT activeCardId) so it
  // fires only on a real navigation/remount — never on an in-place EN/JP swap,
  // which must preserve the user's grade/grader/condition/variant.
  useEffect(() => {
    setFavoriteState({ favoritedAt: null, isFavorite: false });
    setLikeCount(0);
    setSelectedVariant(null);
    setSelectedGrader(null);
    setSelectedGrade(null);
    setSelectedCondition(null);
    setQuantity(1);
    setPriceTrends(null);
    setPriceTrendsLoading(false);
    setLanguageOverride(null);
    setAddLanguageChip(null);
    setAddCounterpartDetail(null);
    lastFetchedLaneKeyRef.current = null;
    pendingVariantLabelRef.current = null;
    pendingAddVariantLabelRef.current = null;
    seededCardIdRef.current = null;
    seededVariantCardIdRef.current = null;
  }, [cardId]);

  useEffect(() => {
    if (!detail) {
      return;
    }
    setFavoriteState({
      favoritedAt: detail.favoritedAt ?? null,
      isFavorite: detail.isFavorite ?? false,
    });
    setLikeCount(detail.likeCount ?? 0);
    // The counterpart detail (real `language`) is in — drop the optimistic chip
    // override so the toggle reflects the loaded card.
    setLanguageOverride(null);
  }, [detail]);

  // Owned entries for this card from the already-loaded inventory cache. The PDP
  // detail fast path resolves WITHOUT the heavy full-collection fetch (so its
  // image + variants paint immediately), so owned context comes from here.
  const cachedOwnedEntries = useMemo(() => {
    const source = inventoryEntriesCache ?? portfolioDashboardCache?.inventoryItems ?? [];
    return source.filter((entry) => entry.cardId === activeCardId);
  }, [activeCardId, inventoryEntriesCache, portfolioDashboardCache]);

  // Last entry this mounted screen resolved for `entryId` — survives an EN/JP
  // swap that empties every live pool (the counterpart detail owns nothing and
  // the inventory cache may not be loaded yet).
  const pinnedEntryRef = useRef<InventoryCardEntry | null>(null);

  const selectedEntry = useMemo(() => {
    // An explicit entryId pins the EDITED entry by id across every pool — even
    // after an EN/JP swap, when the entry's cardId no longer matches the
    // displayed activeCardId (SAVE then retargets the entry to the displayed
    // printing). The cardId-filtered pools below come back empty in that state,
    // which used to null out selectedEntry and turn SAVE into a silent no-op.
    if (entryId) {
      const allCached = inventoryEntriesCache ?? portfolioDashboardCache?.inventoryItems ?? [];
      const pinned =
        detail?.ownedEntries.find((entry) => entry.id === entryId)
        ?? allCached.find((entry) => entry.id === entryId)
        ?? (detailPreview?.ownedEntry?.id === entryId ? detailPreview.ownedEntry : null)
        ?? (pinnedEntryRef.current?.id === entryId ? pinnedEntryRef.current : null);
      if (pinned) {
        return pinned;
      }
    }

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
  }, [
    cachedOwnedEntries,
    detail,
    detailPreview?.ownedEntry,
    entryId,
    inventoryEntriesCache,
    portfolioDashboardCache,
  ]);

  // Record the resolution AFTER the memo so the ref lags one render behind —
  // exactly what the pin fallback above needs when the pools churn.
  useEffect(() => {
    if (entryId && selectedEntry?.id === entryId) {
      pinnedEntryRef.current = selectedEntry;
    }
  }, [entryId, selectedEntry]);

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
    // Wait until the ACTIVE card's own detail (hence its variant list) has loaded,
    // so an EN/JP swap re-resolves against the counterpart's options — not the
    // outgoing card's (which we keep visible during the swap to avoid a flash).
    if (
      variantOptions.length === 0
      || detail?.cardId !== activeCardId
      || seededVariantCardIdRef.current === activeCardId
    ) {
      return;
    }
    seededVariantCardIdRef.current = activeCardId;

    // Preference order: the variant carried over from an EN/JP swap (matched by
    // NAME), then the owned variant, then "Normal", then the first option.
    const carriedLabel = pendingVariantLabelRef.current;
    pendingVariantLabelRef.current = null;
    const carriedMatch = carriedLabel
      ? variantOptions.find((option) => option.label.toLowerCase() === carriedLabel.toLowerCase())
      : null;
    const ownedVariant = selectedEntry?.kind === 'raw' ? selectedEntry.variantName?.trim() : null;
    const variantMatch = ownedVariant
      ? variantOptions.find((option) => option.label.toLowerCase() === ownedVariant.toLowerCase())
      : null;
    const normalVariant = variantOptions.find(
      (option) => option.label.trim().toLowerCase() === 'normal',
    );
    setSelectedVariant(
      carriedMatch?.id ?? variantMatch?.id ?? normalVariant?.id ?? variantOptions[0]?.id ?? null,
    );
  }, [activeCardId, detail?.cardId, selectedEntry, variantOptions]);

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
  }, [activeCardId]);

  // Shared lane fetch used by BOTH the early parallel fetch (on mount, from the
  // preview's default lane — no waiting on variantOptions/seeding) and the
  // lens-change fetch (after the user switches grader/variant). Reads through
  // the short-TTL cache, flips the loading flag, and records the fetched lane
  // key so the lens-change effect can skip a redundant refetch.
  const fetchTrendsForLane = useCallback(
    (lane: CardDetailLane) => {
      const key = laneKey(activeCardId, lane);
      lastFetchedLaneKeyRef.current = key;
      const token = trendRequestTokenRef.current + 1;
      trendRequestTokenRef.current = token;
      setPriceTrendsLoading(true);
      return getCardPriceTrendsCached(spotlightRepository, activeCardId, lane)
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
    [activeCardId, spotlightRepository],
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
    if (lastFetchedLaneKeyRef.current === laneKey(activeCardId, lane)) {
      return;
    }
    void fetchTrendsForLane(lane);
    // Intentionally keyed on activeCardId + the early lane signal only, NOT on the
    // seeded selection state, so it runs before seeding completes.
  }, [activeCardId, dataVersion, detailPreview, fetchTrendsForLane, selectedGrader]);

  // LENS-CHANGE fetch: once the user's lane resolves (grader/variant seeded or
  // changed), refetch ONLY when it differs from the lane already fetched. The
  // common raw/Normal default matches the early fetch's lane key, so this is a
  // no-op there (no double fetch); switching grader/variant refetches the new
  // lane.
  useEffect(() => {
    // Gate on the ACTIVE card's own detail so a swap fetches trends for the
    // counterpart with its re-resolved variant label, not the outgoing card's.
    if (!detail || detail.cardId !== activeCardId || selectedGrader == null) {
      return;
    }
    const lane: CardDetailLane = {
      mode: isRawLane ? 'raw' : 'graded',
      // Carry the selected printing on BOTH lanes. The backend graded resolver
      // reads it as slab_context.variantName; without it, graded always returns
      // the base printing's price (e.g. Unlimited) regardless of the chip. The
      // variant is part of laneKey, so switching the printing in graded mode
      // changes the key and triggers a refetch below.
      variant: selectedVariantLabel ?? null,
      grader: isRawLane ? null : selectedGrader,
    };
    if (lastFetchedLaneKeyRef.current === laneKey(activeCardId, lane)) {
      return;
    }
    void fetchTrendsForLane(lane);
  }, [activeCardId, detail, fetchTrendsForLane, isRawLane, selectedGrader, selectedVariantLabel]);

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
        // Scope sold comps to the selected printing/edition (1st Edition vs
        // Unlimited) so the recent-sales list isn't a mix of both.
        variant: selectedVariantLabel,
        language: detail.language,
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
    // Prefer an exact product-page deep link for the selected printing; fall back
    // to the keyword search when no product_id resolves.
    const productId = resolveTcgPlayerProductId(detail.tcgPlayerVariants, selectedVariantLabel);
    const url =
      (productId ? buildTcgPlayerProductUrl({ productId, condition }) : null) ??
      buildTcgPlayerSearchUrl({
        name: detail.name,
        cardNumber: detail.cardNumber,
        setName: detail.setName,
        condition,
      });
    if (url) {
      capturePostHogEvent('pricing_link_opened', { marketplace: 'tcgplayer', lane: 'raw' });
      void Linking.openURL(url);
    }
  }, [detail, priceTrends, selectedVariantLabel]);

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
        // Scope sold comps to the selected printing/edition (1st Edition vs
        // Unlimited) so the recent-sales list isn't a mix of both.
        variant: selectedVariantLabel,
        language: detail.language,
      });
      if (ebayUrl) {
        capturePostHogEvent('pricing_link_opened', { marketplace: 'ebay', lane: 'graded' });
        void Linking.openURL(ebayUrl);
      }
      return;
    }

    // Raw lane → exact TCGplayer product page for the selected printing at Near
    // Mint when we can resolve a product_id; otherwise fall back to the keyword
    // search (printing intentionally omitted there; see handleTrendRowPress for
    // why the Printing facet zeroes out promos).
    const productId = resolveTcgPlayerProductId(detail.tcgPlayerVariants, selectedVariantLabel);
    const url =
      (productId ? buildTcgPlayerProductUrl({ productId, condition: 'Near Mint' }) : null) ??
      buildTcgPlayerSearchUrl({
        name: detail.name,
        cardNumber: detail.cardNumber,
        setName: detail.setName,
        condition: 'Near Mint',
      });
    if (url) {
      capturePostHogEvent('pricing_link_opened', { marketplace: 'tcgplayer', lane: 'raw' });
      void Linking.openURL(url);
    }
  }, [detail, priceTrends, selectedGrade, selectedGrader, selectedVariantLabel]);

  const handleToggleFavorite = useCallback(() => {
    if (isFavoritePending) {
      return;
    }

    const previousFavoriteState = favoriteState;
    const nextIsFavorite = !favoriteState.isFavorite;
    setFavoriteState((current) => ({ ...current, isFavorite: nextIsFavorite }));
    setIsFavoritePending(true);
    // NOTE: likeCount is the public "like" (card_likes), NOT the wishlist, so the
    // wishlist heart must NOT touch it. (Earlier it optimistically bumped likeCount
    // back when likes reused favorites; the separate card_likes feature ended that.)

    void spotlightRepository.setCardFavorite(activeCardId, nextIsFavorite)
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
        invalidateCardDetailCache(activeCardId);
      })
      .catch(() => {
        setFavoriteState(previousFavoriteState);
        setErrorMessage('Could not update wishlist right now.');
        setIsFavoritePending(false);
      });
  }, [activeCardId, favoriteState, isFavoritePending, spotlightRepository]);

  // EN/JP toggle: derived from the loaded card's language + its other-language
  // counterpart. Shown only when a confident counterpart link exists. Switching
  // swaps the displayed card IN PLACE (no navigation) — see handleSwitchLanguage.
  const currentCardLanguage = detail?.language ?? null;
  const counterpartCardId = detail?.counterpartCardId ?? null;
  const hasLanguageCounterpart = Boolean(
    currentCardLanguage && counterpartCardId && detail?.counterpartLanguage,
  );
  // Optimistic override highlights the tapped chip instantly; otherwise reflect
  // the loaded card's own language.
  const selectedLanguageChip =
    languageOverride ?? (currentCardLanguage === 'japanese' ? 'JP' : 'EN');
  const languageToggleOptions = hasLanguageCounterpart ? [...languageOptions] : [];

  // Warm the counterpart's detail + default lane so the EN/JP swap is instant.
  useEffect(() => {
    if (counterpartCardId) {
      void prefetchCardDetail(spotlightRepository, counterpartCardId);
    }
  }, [counterpartCardId, spotlightRepository]);

  const handleSwitchLanguage = useCallback(
    (chip: string) => {
      const target = chip === 'JP' ? 'japanese' : 'english';
      if (!counterpartCardId || target === currentCardLanguage) {
        return;
      }
      // Swap the displayed card IN PLACE — the page stays mounted (scroll, open
      // sheets, and the language-agnostic grade/grader/condition all preserved).
      // The variant carries over by NAME (re-resolved against the counterpart's
      // options in the variant-seed effect); art + price trends refetch for the
      // counterpart. No router navigation, matching the prior no-back-stack intent.
      pendingVariantLabelRef.current = selectedVariantLabel;
      seededVariantCardIdRef.current = null;
      lastFetchedLaneKeyRef.current = null;
      setPriceTrends(null);
      setPriceTrendsLoading(true);
      setLanguageOverride(chip);
      capturePostHogEvent('card_detail_language_switched', {
        from: currentCardLanguage,
        to: target,
      });
      setActiveCardId(counterpartCardId);
    },
    [counterpartCardId, currentCardLanguage, selectedVariantLabel],
  );

  const hasDisplayContent = detail != null || detailPreview != null;

  const displayName = detail?.name ?? detailPreview?.name ?? '';
  const displayImageUrl = detail?.largeImageUrl
    ?? detail?.imageUrl
    ?? detailPreview?.largeImageUrl
    ?? detailPreview?.imageUrl
    ?? null;
  const displayCardNumber = detail?.cardNumber ?? detailPreview?.cardNumber ?? '';
  const displaySetName = detail?.setName ?? detailPreview?.setName ?? '';
  // Card number + set name share one line, dot-separated ("052 · Scarlet &
  // Violet Black Star Promos"). Either part may be missing.
  const identityNumberSetLine =
    [
      displayCardNumber.trim() ? displayNumber(displayCardNumber) : null,
      displaySetName.trim() || null,
    ]
      .filter(Boolean)
      .join(' · ') || displayNumber(displayCardNumber);
  // Release date + illustrator (Figma 1965:25870): "Jun 10, 2000 · Illus. Yuka
  // Morii". Either part may be missing; the line is omitted when both are.
  const displayArtist = detail?.artist?.trim() || null;
  const displayReleaseLabel = formatReleaseDate(detail?.releaseDate);
  const identityDetailLine = [
    displayReleaseLabel,
    displayArtist ? `Illus. ${displayArtist}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  // Carried into the log-transaction flow as the note so a bought/sold/traded
  // entry started from this card keeps its identity.
  const transactionLabel = [displayName, displayCardNumber, displaySetName]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' · ');

  const marketplaceUrl = useMemo(() => {
    const condition = deckConditionLabel(selectedCondition);
    // Exact product page for the selected printing when the detail payload
    // carries product ids; otherwise the keyword search (also the path before
    // `detail` resolves, where only preview fields are available).
    const productId = resolveTcgPlayerProductId(detail?.tcgPlayerVariants, selectedVariantLabel);
    return (
      (productId ? buildTcgPlayerProductUrl({ productId, condition }) : null) ??
      buildTcgPlayerSearchUrl({
        cardNumber: displayCardNumber,
        name: displayName,
        setName: displaySetName,
        condition,
        printing: selectedVariantLabel,
      })
    );
  }, [detail, displayCardNumber, displayName, displaySetName, selectedCondition, selectedVariantLabel]);

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

  // --- Add to Collection sheet's OWN selection (independent of the page) ---
  // The raw lane titles the dropdown "Condition" (Figma 1664:2201 — Near Mint…
  // Damaged); the graded lane titles it "Grade" (numeric).
  const addIsRaw = addGrader == null || addGrader === 'Raw';
  // The sheet's language decides which card the ADD writes to: the page's card,
  // or its other-language counterpart. The PDP behind the sheet NEVER changes —
  // only the page-level toggle swaps the displayed card.
  const activeCardLanguageChip = currentCardLanguage === 'japanese' ? 'JP' : 'EN';
  const addSelectedLanguageChip = addLanguageChip ?? activeCardLanguageChip;
  const addTargetsCounterpart =
    hasLanguageCounterpart && addSelectedLanguageChip !== activeCardLanguageChip;
  // Null while the counterpart detail is still resolving — CONFIRM stays
  // disabled and the variant list shows its loading state until it lands.
  const addDetail = addTargetsCounterpart
    ? (addCounterpartDetail?.cardId === counterpartCardId ? addCounterpartDetail : null)
    : detail;
  // Variant options for the ADD target (same preference order as the page's).
  const addVariantOptions = useMemo<MarketHistoryOption[]>(() => {
    if (!addTargetsCounterpart) {
      return variantOptions;
    }
    const fromDetail = addDetail?.variantOptions ?? [];
    if (fromDetail.length > 0) {
      return fromDetail;
    }
    return addDetail?.marketHistory?.availableVariants ?? [];
  }, [addDetail?.marketHistory?.availableVariants, addDetail?.variantOptions, addTargetsCounterpart, variantOptions]);
  const addVariantLabel = useMemo(() => {
    if (!addVariant) {
      return null;
    }
    return addVariantOptions.find((option) => option.id === addVariant)?.label ?? null;
  }, [addVariant, addVariantOptions]);
  // EN/JP toggle inside the Add sheet: sheet-local only. Queue the sheet's
  // current variant LABEL so it carries over (by name) to the target card's
  // options. Grader/grade/condition are language-agnostic and stay as-is.
  const handleSheetSwitchLanguage = useCallback(
    (chip: string) => {
      if (chip === addSelectedLanguageChip) {
        return;
      }
      pendingAddVariantLabelRef.current = addVariantLabel;
      setAddLanguageChip(chip);
      capturePostHogEvent('card_detail_add_language_switched', {
        from: addSelectedLanguageChip,
        to: chip,
      });
    },
    [addSelectedLanguageChip, addVariantLabel],
  );
  // Load the counterpart's detail for the sheet (through the short-TTL cache —
  // it's prefetched on mount, so this usually resolves instantly). On failure,
  // snap the sheet back to the page's language instead of wedging CONFIRM.
  useEffect(() => {
    if (!addSheetOpen || !addTargetsCounterpart || !counterpartCardId) {
      return;
    }
    if (addCounterpartDetail?.cardId === counterpartCardId) {
      return;
    }
    let cancelled = false;
    void getCardDetailCached(spotlightRepository, counterpartCardId)
      .then((next) => {
        if (cancelled) {
          return;
        }
        if (!next) {
          setAddLanguageChip(null);
          setErrorMessage('Could not load the other-language card right now.');
          return;
        }
        setAddCounterpartDetail(next);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setAddLanguageChip(null);
        setErrorMessage('Could not load the other-language card right now.');
      });
    return () => {
      cancelled = true;
    };
  }, [addCounterpartDetail, addSheetOpen, addTargetsCounterpart, counterpartCardId, spotlightRepository]);
  // Re-resolve the sheet's variant by NAME once the target card's options are
  // in (counterpart options after a toggle, or the page's when toggling back).
  useEffect(() => {
    if (
      pendingAddVariantLabelRef.current == null
      || addDetail == null
      || addVariantOptions.length === 0
    ) {
      return;
    }
    const carriedLabel = pendingAddVariantLabelRef.current;
    pendingAddVariantLabelRef.current = null;
    const carriedMatch = addVariantOptions.find(
      (option) => option.label.toLowerCase() === carriedLabel.toLowerCase(),
    );
    setAddVariant(carriedMatch?.id ?? addVariantOptions[0]?.id ?? null);
  }, [addDetail, addVariantOptions]);
  const handleAddSelectGrader = useCallback((grader: string) => {
    setAddGrader(grader);
    if (grader === 'Raw') {
      setAddCondition((current) => current ?? deckConditionOptions[0]?.code ?? null);
    } else {
      setAddGrade((current) => current ?? ownedSlabContext?.grade ?? '10');
    }
  }, [ownedSlabContext]);
  const handleAddGradePick = useCallback((id: string) => {
    if (addIsRaw) {
      setAddCondition(id as DeckConditionCode);
    } else {
      setAddGrade(id);
    }
  }, [addIsRaw]);
  const addGradeTitle = addIsRaw ? 'Condition' : 'Grade';
  const addGradeLabel = addIsRaw
    ? deckConditionLabel(addCondition)
    : (addGrade ? `${addGrader} ${addGrade}` : null);
  const addGradePickerOptions = useMemo<DropdownOption[]>(() => {
    if (addIsRaw) {
      return deckConditionOptions.map((option) => ({ id: option.code, label: option.label }));
    }
    return numericGradeOptions.map((grade) => ({ id: grade, label: `${addGrader} ${grade}` }));
  }, [addIsRaw, addGrader]);
  const addGradePickerSelectedId = addIsRaw ? addCondition : addGrade;
  const addConfiguredSlabContext = useMemo<SlabContext | null>(() => {
    if (addIsRaw || !addGrader) {
      return null;
    }
    return {
      grader: addGrader,
      grade: addGrade,
      certNumber: null,
      variantName: addGrade ? `${addGrader} ${addGrade}` : null,
    };
  }, [addIsRaw, addGrade, addGrader]);

  const handleAddItem = useCallback(() => {
    // CONFIRM is disabled until the ADD target's detail resolves (the page's
    // card, or the counterpart when the sheet's EN/JP toggle picked it), so
    // this always runs with a loaded target card.
    if (isAddPending || !addDetail) {
      return;
    }
    setIsAddPending(true);
    const addedAt = new Date().toISOString();
    const addedQuantity = Math.max(1, quantity);
    const addedCondition = addIsRaw ? addCondition : null;
    const addedVariantName = addIsRaw ? (addVariantLabel ?? null) : addConfiguredSlabContext?.variantName ?? null;
    void spotlightRepository.createInventoryEntry({
      cardID: addDetail.cardId,
      slabContext: addConfiguredSlabContext,
      variantName: addIsRaw ? (addVariantLabel ?? null) : null,
      condition: addedCondition,
      quantity: addedQuantity,
      sourceScanID: null,
      addedAt,
    })
      .then((response) => {
        // Optimistic insert: surface the new card at the top of the Collection
        // immediately (using the REAL entry id from the create response so the
        // background refreshData() refetch reconciles by id instead of
        // duplicating). Only runs on success — a failed add never inserts.
        const conditionOption = addedCondition
          ? deckConditionOptions.find((option) => option.code === addedCondition) ?? null
          : null;
        prependOptimisticInventoryEntry({
          id: response.deckEntryID,
          cardId: addDetail.cardId,
          name: addDetail.name,
          cardNumber: addDetail.cardNumber,
          setName: addDetail.setName,
          imageUrl: addDetail.imageUrl,
          largeImageUrl: addDetail.largeImageUrl ?? null,
          marketPrice: addDetail.marketPrice ?? 0,
          hasMarketPrice: addDetail.marketPrice != null,
          currencyCode: addDetail.currencyCode,
          quantity: addedQuantity,
          addedAt: response.addedAt || addedAt,
          kind: addIsRaw ? 'raw' : 'graded',
          variantName: addedVariantName,
          conditionCode: addedCondition,
          conditionLabel: conditionOption?.label ?? null,
          conditionShortLabel: conditionOption?.shortLabel ?? null,
          slabContext: addConfiguredSlabContext,
          isFavorite: addDetail.isFavorite ?? false,
        });
        capturePostHogEvent('card_detail_add_item_succeeded', {
          kind: addIsRaw ? 'raw' : 'graded',
          quantity: Math.max(1, quantity),
        });
        setAddSheetOpen(false);
        refreshData();
        // Adding is the END of the search/add flow: collapse the pushed stack
        // (search + PDP) back to the Collection page, where the optimistic
        // insert has already surfaced the new card at the top.
        router.dismissTo({ pathname: '/', params: { page: 'portfolio' } } as never);
      })
      .catch(() => {
        setErrorMessage('Could not add this card right now.');
      })
      .finally(() => {
        setIsAddPending(false);
      });
  }, [
    addConfiguredSlabContext,
    addCondition,
    addDetail,
    addIsRaw,
    addVariantLabel,
    isAddPending,
    prependOptimisticInventoryEntry,
    quantity,
    refreshData,
    router,
    spotlightRepository,
  ]);

  // Opening the Add to Collection sheet always starts a fresh add at a fixed
  // default — first variant, Raw / Near Mint, quantity 1 — regardless of what the
  // PDP is currently showing. Edits stay local to the sheet (Figma 1640:4077).
  const handleOpenAddSheet = useCallback(() => {
    setAddVariant(variantOptions[0]?.id ?? null);
    setAddGrader('Raw');
    setAddGrade(null);
    setAddCondition('near_mint');
    setAddLanguageChip(null);
    pendingAddVariantLabelRef.current = null;
    setQuantity(1);
    setAddSheetOpen(true);
  }, [variantOptions]);

  // Delete the owned entry behind this PDP (Figma 1874:23102). On success the
  // entry is gone, so close the sheet, recalc the portfolio (refreshData), and
  // pop back to where the user came from (Collection). Guarded so a stray tap
  // without an owned entry — or a double-tap — can't fire a delete.
  const handleConfirmDelete = useCallback(() => {
    const deckEntryID = selectedEntry?.id;
    if (!deckEntryID || isDeletePending) {
      return;
    }
    setIsDeletePending(true);
    spotlightRepository
      .deletePortfolioEntry({ deckEntryID })
      .then(() => {
        setConfirmDeleteOpen(false);
        refreshData();
        onBack();
      })
      .catch(() => {
        setErrorMessage('Could not delete this item right now.');
      })
      .finally(() => {
        setIsDeletePending(false);
      });
  }, [isDeletePending, onBack, refreshData, selectedEntry, spotlightRepository]);

  // --- Owned-card inline edit mode (Figma 1874:21729) ---------------------
  // Page is in edit mode whenever it shows an owned entry. The Variant / Grader
  // / Grade / Condition reuse the page configurator state (already seeded from
  // the owned entry); we only add Quantity + Cost Basis here.
  const isOwnedEdit = selectedEntry != null;

  useEffect(() => {
    if (!selectedEntry || seededEditEntryIdRef.current === selectedEntry.id) {
      return;
    }
    seededEditEntryIdRef.current = selectedEntry.id;
    setEditQuantity(Math.max(1, selectedEntry.quantity || 1));
    if (!editCostBasisDirtyRef.current) {
      setEditCostBasisText(
        selectedEntry.costBasisPerUnit != null ? String(selectedEntry.costBasisPerUnit) : '',
      );
    }
  }, [selectedEntry]);

  const handleChangeEditCostBasisText = useCallback((text: string) => {
    editCostBasisDirtyRef.current = true;
    setEditCostBasisText(text);
  }, []);

  const editIsRaw = selectedGrader == null || selectedGrader === 'Raw';
  // Figma 1874:21488 titles this "Condition" in both lanes and shows the bare
  // grade ("10"), not "PSA 10".
  const editGradeTitle = 'Condition';
  const editGradeLabel = editIsRaw ? deckConditionLabel(selectedCondition) : selectedGrade;
  const editGradePickerOptions = useMemo<GradeConditionOption[]>(() => {
    if (editIsRaw) {
      return deckConditionOptions.map((option) => ({ id: option.code, label: option.label }));
    }
    return numericGradeOptions.map((grade) => ({ id: grade, label: grade }));
  }, [editIsRaw]);
  const editGradePickerSelectedId = editIsRaw ? selectedCondition : selectedGrade;
  // "Updated <date>" stamp on the Cost Basis row, from the owned entry's date.
  const editUpdatedLabel = useMemo(() => {
    if (!selectedEntry || selectedEntry.costBasisPerUnit == null || !selectedEntry.addedAt) {
      return null;
    }
    const parsed = new Date(selectedEntry.addedAt);
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }
    return `Updated ${parsed.getMonth() + 1}/${parsed.getDate()}/${parsed.getFullYear()}`;
  }, [selectedEntry]);
  const editSlabContext = useMemo<SlabContext | null>(() => {
    if (editIsRaw || !selectedGrader) {
      return null;
    }
    return {
      grader: selectedGrader,
      grade: selectedGrade,
      certNumber: ownedSlabContext?.certNumber ?? null,
      // Slab variant must be the PRINT variant the graded price is keyed by.
      // For an ALREADY-graded entry keep its stored slab variant so a no-op edit
      // can't change identity_key (that orphaned the cost basis). For a RAW→graded
      // conversion `ownedSlabContext` is null — do NOT fall back to the raw
      // variant (e.g. "League Stamp"), which has no graded price and blanks the
      // slab. Send null so the backend graded resolver falls back to an available
      // graded variant.
      variantName: ownedSlabContext?.variantName ?? null,
    };
  }, [editIsRaw, ownedSlabContext, selectedGrade, selectedGrader]);

  const editCostBasisPerUnit = useMemo(() => {
    const cleaned = editCostBasisText.replace(/[^0-9.]/g, '');
    if (!cleaned) {
      return null;
    }
    const parsed = Number.parseFloat(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }, [editCostBasisText]);

  // Per-unit gain = current market − the SAVED cost basis (only when both known).
  // We intentionally read the persisted cost basis (not the live edit text) so the
  // gain pill doesn't recompute on every keystroke — it only moves once the user
  // taps SAVE (which refreshes `selectedEntry`).
  const editGainPerUnit = useMemo(() => {
    const savedCostBasis = selectedEntry?.costBasisPerUnit;
    if (savedCostBasis == null || !selectedEntry?.hasMarketPrice) {
      return null;
    }
    return Number((selectedEntry.marketPrice - savedCostBasis).toFixed(2));
  }, [selectedEntry]);
  const editGainLabel = editGainPerUnit == null
    ? null
    : formatCurrency(Math.abs(editGainPerUnit), selectedEntry?.currencyCode ?? 'USD');

  const handleEditGradePick = useCallback((id: string) => {
    if (editIsRaw) {
      setSelectedCondition(id as DeckConditionCode);
    } else {
      setSelectedGrade(id);
    }
    setEditGradePickerOpen(false);
  }, [editIsRaw]);

  // SAVE: persist identity/config + quantity via replace, then write the
  // authoritative per-unit cost basis (the replace response carries the row id,
  // which changes when the identity — grader/grade/variant/condition — changes).
  const handleSaveEdit = useCallback(() => {
    if (!selectedEntry || !detail || isSavingEdit) {
      return;
    }
    setIsSavingEdit(true);
    setErrorMessage(null);
    const costBasis = editCostBasisPerUnit;
    spotlightRepository
      .replacePortfolioEntry({
        deckEntryID: selectedEntry.id,
        // activeCardId, NOT detail.cardId: the EN/JP toggle sets activeCardId
        // synchronously while `detail` refetches. A fast SAVE right after the
        // toggle used to persist the OLD printing from the stale detail.
        cardID: activeCardId,
        slabContext: editSlabContext,
        variantName: editIsRaw ? selectedVariantLabel : null,
        condition: editIsRaw ? selectedCondition : null,
        quantity: editQuantity,
        unitPrice: costBasis ?? 0,
        currencyCode: selectedEntry.currencyCode || 'USD',
        updatedAt: new Date().toISOString(),
      })
      .then(async (result) => {
        await spotlightRepository.updateDeckEntryCostBasis({
          deckEntryID: result.deckEntryID,
          costBasisPerUnit: costBasis,
        });
        return result;
      })
      .then((result) => {
        editCostBasisDirtyRef.current = false;
        // Optimistic edit: reflect the save into the shared inventory cache so
        // the Collection shows the change INSTANTLY instead of waiting on the
        // multi-second dashboard refetch (which then reconciles by id). An
        // identity change (variant/condition/grade/language) returns a NEW row
        // id, so drop the old row first. Display fields come from `detail` when
        // it matches the saved card; after a fast EN/JP toggle `detail` can
        // still be the other language's card mid-refetch, so fall back to the
        // existing entry's fields and let the refetch correct the visuals.
        const detailFresh = detail.cardId === activeCardId;
        const conditionOption = editIsRaw
          ? deckConditionOptions.find((option) => option.code === selectedCondition) ?? null
          : null;
        if (result.deckEntryID !== selectedEntry.id) {
          removeOptimisticInventoryEntries([selectedEntry.id]);
        }
        prependOptimisticInventoryEntry({
          id: result.deckEntryID,
          cardId: activeCardId,
          name: detailFresh ? detail.name : selectedEntry.name,
          cardNumber: detailFresh ? detail.cardNumber : selectedEntry.cardNumber,
          setName: detailFresh ? detail.setName : selectedEntry.setName,
          imageUrl: detailFresh ? detail.imageUrl : selectedEntry.imageUrl,
          largeImageUrl: detailFresh ? detail.largeImageUrl ?? null : selectedEntry.largeImageUrl,
          marketPrice: detailFresh ? detail.marketPrice ?? 0 : selectedEntry.marketPrice,
          hasMarketPrice: detailFresh ? detail.marketPrice != null : selectedEntry.hasMarketPrice,
          currencyCode: selectedEntry.currencyCode || 'USD',
          quantity: editQuantity,
          addedAt: selectedEntry.addedAt,
          kind: editIsRaw ? 'raw' : 'graded',
          variantName: editIsRaw ? selectedVariantLabel ?? null : editSlabContext?.variantName ?? null,
          conditionCode: editIsRaw ? selectedCondition : null,
          conditionLabel: conditionOption?.label ?? null,
          conditionShortLabel: conditionOption?.shortLabel ?? null,
          slabContext: editSlabContext,
          isFavorite: selectedEntry.isFavorite,
        });
        refreshData();
        onBack();
      })
      .catch(() => {
        setErrorMessage('Could not save your changes right now.');
      })
      .finally(() => {
        setIsSavingEdit(false);
      });
  }, [
    activeCardId,
    detail,
    editCostBasisPerUnit,
    editIsRaw,
    editQuantity,
    editSlabContext,
    isSavingEdit,
    onBack,
    prependOptimisticInventoryEntry,
    refreshData,
    removeOptimisticInventoryEntries,
    selectedCondition,
    selectedEntry,
    selectedVariantLabel,
    spotlightRepository,
  ]);

  const isFavorite = favoriteState.isFavorite;

  // Auto-hiding top/bottom bars (Reddit-style). All scroll logic stays on the UI
  // thread — the worklet only writes shared values / withTiming (never setState),
  // so there's no gesture/scroll worklet hazard.
  const barsShown = useSharedValue(1);
  const lastScrollY = useSharedValue(0);
  // While the keyboard is up (editing Cost Basis) we FREEZE the auto-hide so the
  // bars don't jump, and lift the footer above the keyboard so SAVE/CANCEL stay
  // reachable. `keyboardLift` is the live keyboard height (animated).
  const barsFrozen = useSharedValue(false);
  const keyboardLift = useSharedValue(0);
  const [headerHeight, setHeaderHeight] = useState(56);
  const [footerHeight, setFooterHeight] = useState(76);

  // Keyboard-aware scroll for the Cost Basis input: the edit section sits low in
  // the page (behind the footer), so when its input focuses we scroll its bottom
  // just above the keyboard. We track the section's rect (content-relative, via
  // onLayout on the options group) and the live keyboard height.
  const scrollRef = useRef<Animated.ScrollView>(null);
  const { height: windowHeight } = useWindowDimensions();
  const editSectionRectRef = useRef({ y: 0, height: 0 });
  const costBasisFocusedRef = useRef(false);
  const keyboardHeightRef = useRef(0);

  const scrollEditSectionAboveKeyboard = useCallback(
    (keyboardHeight: number) => {
      if (!costBasisFocusedRef.current || keyboardHeight <= 0) {
        return;
      }
      const { y, height } = editSectionRectRef.current;
      // The footer rides above the keyboard, so the input must clear BOTH. Scroll
      // so the section's bottom sits just above the lifted footer.
      const available = windowHeight - keyboardHeight - footerHeight;
      const target = y + height + 12 - available;
      if (target > 0) {
        scrollRef.current?.scrollTo({ y: target, animated: true });
      }
    },
    [footerHeight, windowHeight],
  );

  useEffect(() => {
    const showSub = Keyboard.addListener('keyboardDidShow', (event) => {
      keyboardHeightRef.current = event.endCoordinates.height;
      keyboardLift.value = withTiming(event.endCoordinates.height, { duration: 220 });
      scrollEditSectionAboveKeyboard(event.endCoordinates.height);
    });
    const hideSub = Keyboard.addListener('keyboardDidHide', () => {
      keyboardHeightRef.current = 0;
      keyboardLift.value = withTiming(0, { duration: 220 });
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [keyboardLift, scrollEditSectionAboveKeyboard]);

  const handleCostBasisFocus = useCallback(() => {
    costBasisFocusedRef.current = true;
    // Freeze the header (shown) so the programmatic keyboard-scroll can't hide it.
    barsFrozen.value = true;
    barsShown.value = withTiming(1, { duration: 160 });
    // If the keyboard is already up (e.g. moving from another field), scroll now;
    // otherwise keyboardDidShow handles it once the keyboard animates in.
    scrollEditSectionAboveKeyboard(keyboardHeightRef.current);
  }, [barsFrozen, barsShown, scrollEditSectionAboveKeyboard]);

  const handleCostBasisBlur = useCallback(() => {
    costBasisFocusedRef.current = false;
    barsFrozen.value = false;
  }, [barsFrozen]);

  // CANCEL behaves contextually: while the user is mid-edit in the Cost Basis
  // field (keyboard up), the first CANCEL only discards the in-progress input and
  // dismisses the keyboard — keeping them ON the PDP. With the keyboard down it
  // closes the edit and returns to the prior screen as before. (Cost Basis is the
  // only text field here, so a visible keyboard means they're typing into it.)
  const handleCancelEdit = useCallback(() => {
    if (keyboardHeightRef.current > 0) {
      editCostBasisDirtyRef.current = false;
      setEditCostBasisText(
        selectedEntry?.costBasisPerUnit != null ? String(selectedEntry.costBasisPerUnit) : '',
      );
      costBasisFocusedRef.current = false;
      barsFrozen.value = false;
      Keyboard.dismiss();
      return;
    }
    onBack();
  }, [barsFrozen, onBack, selectedEntry]);

  const scrollHandler = useAnimatedScrollHandler({
    onScroll: (event) => {
      'worklet';
      const y = event.contentOffset.y;
      const dy = y - lastScrollY.value;
      lastScrollY.value = y;
      // Keep the bars pinned (shown) while editing — don't let the keyboard's
      // programmatic scroll, or any scroll, hide them.
      if (barsFrozen.value) {
        return;
      }
      if (y <= TOP_REVEAL_THRESHOLD) {
        barsShown.value = withTiming(1, { duration: 160 });
      } else if (dy > SCROLL_DOWN_HIDE_DELTA) {
        barsShown.value = withTiming(0, { duration: 220 });
      } else if (dy < -FAST_UP_REVEAL_DELTA) {
        barsShown.value = withTiming(1, { duration: 160 });
      }
    },
  });

  const stickyHeaderStyle = useAnimatedStyle(
    () => ({
      opacity: barsShown.value,
      transform: [{ translateY: (barsShown.value - 1) * headerHeight }],
    }),
    [headerHeight],
  );
  // The action bar auto-hides on scroll exactly like the header (slides down +
  // fades via barsShown), AND rises above the keyboard while editing
  // (-keyboardLift). Editing sets barsFrozen so the scroll handler leaves
  // barsShown at 1 → the auto-hide term is 0 and only the keyboard lift applies.
  // footerHeight includes the safe-area padding, so at barsShown=0 the bar fully
  // clears the bottom edge; `box-none` on the wrapper means it can never trap
  // touches while hidden (the prior "off-screen + unresponsive" bug).
  const stickyFooterStyle = useAnimatedStyle(
    () => ({
      opacity: barsShown.value,
      transform: [
        { translateY: (1 - barsShown.value) * footerHeight - keyboardLift.value },
      ],
    }),
    [footerHeight],
  );

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
      // Only inset the sides here — the sticky header/footer own the top/bottom
      // insets (they're absolutely positioned and would otherwise ignore the
      // SafeAreaView padding, sliding under the status bar / home indicator).
      edges={['left', 'right']}
      style={[styles.safeArea, { backgroundColor: colors.gray0 }]}
    >
      <Animated.ScrollView
        ref={scrollRef}
        contentContainerStyle={[
          styles.content,
          { paddingTop: headerHeight, paddingBottom: footerHeight },
        ]}
        keyboardShouldPersistTaps="handled"
        onScroll={scrollHandler}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}
        style={styles.scroll}
      >
        <CardDetailHero
          imageUrl={displayImageUrl}
          isFavorite={isFavorite}
          name={displayName}
          onToggleFavorite={handleToggleFavorite}
          testID="detail-hero-card"
        />

        <View style={styles.identityRow}>
          <View style={[styles.identityBlock, styles.identityText]} testID="detail-identity">
            <Text style={theme.typography.titleLarge} testID="detail-name">
              {displayName}
            </Text>
            <Text
              style={[theme.typography.bodyMedium, styles.identityMeta]}
              testID="detail-identity-number-set"
            >
              {identityNumberSetLine}
            </Text>
            {identityDetailLine ? (
              <Text
                style={[theme.typography.bodyMedium, styles.identityMeta]}
                testID="detail-identity-meta"
              >
                {identityDetailLine}
              </Text>
            ) : null}
          </View>
          {/* Wishlist social-proof counter (heart + count, max 9999+). */}
          <CardWishlistCounter count={likeCount} testID="detail-wishlist-counter" />
        </View>

        <View
          onLayout={(event) => {
            const { y, height } = event.nativeEvent.layout;
            editSectionRectRef.current = { y, height };
          }}
          style={styles.optionsGroup}
        >
          <CardConfigurator
            graders={[...graderOptions]}
            languages={languageToggleOptions}
            onSelectGrader={handleSelectGrader}
            onSelectLanguage={handleSwitchLanguage}
            onSelectVariant={setSelectedVariant}
            selectedGrader={selectedGrader}
            selectedLanguage={selectedLanguageChip}
            selectedVariant={selectedVariant}
            testID="detail-configurator"
            variants={variantOptions}
            variantsLoading={detail == null && errorMessage == null}
          />

          {isOwnedEdit ? (
            <OwnedEntryEditFields
              costBasisText={editCostBasisText}
              gainLabel={editGainLabel}
              gainPerUnit={editGainPerUnit}
              gradeLabel={editGradeLabel}
              gradeTitle={editGradeTitle}
              onChangeCostBasisText={handleChangeEditCostBasisText}
              onCostBasisBlur={handleCostBasisBlur}
              onCostBasisFocus={handleCostBasisFocus}
              onDecrement={() => setEditQuantity((current) => Math.max(1, current - 1))}
              onIncrement={() => setEditQuantity((current) => current + 1)}
              onOpenGradePicker={() => setEditGradePickerOpen(true)}
              quantity={editQuantity}
              testID="detail-owned-edit"
              updatedLabel={editUpdatedLabel}
            />
          ) : null}
        </View>

        <AddToCollectionSheet
          confirmDisabled={isAddPending || !addDetail}
          confirmLabel="CONFIRM"
          gradeLabel={addGradeLabel}
          gradeTitle={addGradeTitle}
          graders={[...graderOptions]}
          languages={languageToggleOptions}
          onClose={() => setAddSheetOpen(false)}
          onConfirm={handleAddItem}
          onDecrement={() => setQuantity((current) => Math.max(1, current - 1))}
          onIncrement={() => setQuantity((current) => current + 1)}
          gradeOptions={addGradePickerOptions}
          gradeSelectedId={addGradePickerSelectedId}
          onSelectGrade={handleAddGradePick}
          gradePickerTestID="detail-grade-sheet"
          onSelectGrader={handleAddSelectGrader}
          onSelectLanguage={handleSheetSwitchLanguage}
          onSelectVariant={setAddVariant}
          quantity={quantity}
          selectedGrader={addGrader}
          selectedLanguage={addSelectedLanguageChip}
          selectedVariant={addVariant}
          testID="detail-add-sheet"
          title="Add to Collection"
          variants={addVariantOptions}
          variantsLoading={addDetail == null && errorMessage == null}
          visible={addSheetOpen}
        />

        <ConfirmDeleteSheet
          confirmPending={isDeletePending}
          onClose={() => setConfirmDeleteOpen(false)}
          onConfirm={handleConfirmDelete}
          quantity={selectedEntry?.quantity ?? 1}
          testID="detail-delete-sheet"
          visible={confirmDeleteOpen}
        />

        <GradeConditionSheet
          onClose={() => setEditGradePickerOpen(false)}
          onSelect={handleEditGradePick}
          options={editGradePickerOptions}
          selectedId={editGradePickerSelectedId}
          testID="detail-edit-grade-sheet"
          title={editGradeTitle}
          visible={editGradePickerOpen}
        />

        <CardPopulationReport
          grader={selectedGrader}
          population={detail?.population}
          testID="detail-population-report"
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
      </Animated.ScrollView>

      {/* Sticky top bar — lifted out of the ScrollView so it overlays the content
          and auto-hides on scroll (slides up + fades). */}
      <Animated.View
        onLayout={(event) => setHeaderHeight(event.nativeEvent.layout.height)}
        style={[
          styles.stickyHeader,
          { backgroundColor: colors.gray0, paddingTop: insets.top + 8 },
          stickyHeaderStyle,
        ]}
      >
        <View style={styles.headerRow}>
          {/* Equal-width side zones flank the title so it's anchored to the true
              header center (Figma 1874:13992), regardless of how many icons sit
              on the right (the extra Delete icon used to shove it left). */}
          <View style={styles.headerSide}>
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
          </View>
          <Text
            numberOfLines={1}
            style={[theme.typography.titleMedium, styles.headerTitle]}
            testID="detail-header-title"
          >
            {displayName}
          </Text>
          <View style={[styles.headerSide, styles.headerSideRight]}>
            {selectedEntry ? (
              <IconButton
                accessibilityLabel="Delete from collection"
                onPress={() => setConfirmDeleteOpen(true)}
                shape="circle"
                size={36}
                testID="detail-delete"
                variant="subtle"
              >
                <Trash color={theme.colors.gray900} height={20} width={20} />
              </IconButton>
            ) : null}
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
        </View>
      </Animated.View>

      {/* Sticky action bar — also auto-hides on scroll (slides down + fades).
          Owned cards edit in place (SAVE + CANCEL); new cards add (ADD ITEM +
          SHARE; ADD ITEM flashes "SAVED" 5s after a successful add). */}
      <Animated.View
        onLayout={(event) => setFooterHeight(event.nativeEvent.layout.height)}
        pointerEvents="box-none"
        style={[
          styles.stickyFooter,
          { backgroundColor: colors.gray0, paddingBottom: insets.bottom + 8 },
          stickyFooterStyle,
        ]}
      >
        {isOwnedEdit ? (
          <View style={styles.actionBar}>
            <Button
              disabled={isSavingEdit || !detail}
              label="SAVE"
              labelStyleVariant="label"
              onPress={handleSaveEdit}
              shape="rounded"
              size="md"
              style={styles.actionButton}
              testID="detail-save-edit"
              variant="accent"
            />
            <Button
              disabled={isSavingEdit}
              label="CANCEL"
              labelStyleVariant="label"
              onPress={handleCancelEdit}
              shape="rounded"
              size="md"
              style={styles.actionButton}
              testID="detail-cancel-edit"
              variant="outline"
            />
          </View>
        ) : (
          <View style={styles.actionBar}>
            <Button
              disabled={isAddPending || !detail}
              label="ADD ITEM"
              labelStyleVariant="label"
              onPress={handleOpenAddSheet}
              shape="rounded"
              size="md"
              style={styles.actionButton}
              testID="detail-add-item"
              variant="accent"
            />
            <Button
              label="SHARE"
              labelStyleVariant="label"
              onPress={handleShare}
              shape="rounded"
              size="md"
              style={styles.actionButton}
              testID="detail-share-button"
              variant="outline"
            />
          </View>
        )}
      </Animated.View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  actionBar: {
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 10,
  },
  actionButton: {
    flex: 1,
  },
  content: {
    // Tightened section spacing (Figma): identity↔configurator↔price-trend↔
    // product-details sit closer together than the original 32px.
    gap: 24,
    paddingBottom: 24,
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
  },
  headerSide: {
    alignItems: 'center',
    flexDirection: 'row',
    // Equal-width flanks → the title between them lands on the true center.
    flex: 1,
    gap: 8,
  },
  headerSideRight: {
    justifyContent: 'flex-end',
  },
  stickyHeader: {
    elevation: 10,
    left: 0,
    paddingBottom: 8,
    paddingHorizontal: 16,
    paddingTop: 12,
    position: 'absolute',
    right: 0,
    top: 0,
    zIndex: 10,
  },
  stickyFooter: {
    bottom: 0,
    elevation: 10,
    left: 0,
    paddingBottom: 8,
    position: 'absolute',
    right: 0,
    zIndex: 10,
  },
  headerTitle: {
    flexShrink: 1,
    marginHorizontal: 8,
    textAlign: 'center',
  },
  identityBlock: {
    gap: 4,
  },
  identityMeta: {
    color: colors.gray600,
  },
  identityRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
  },
  identityText: {
    flex: 1,
  },
  loadingState: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  optionsGroup: {
    // Product Options read as one continuous list — chips + the owned-edit
    // controls sit 16px apart (Figma 1874:21488), tighter than the 24px section gap.
    gap: 16,
    width: '100%',
  },
  safeArea: {
    flex: 1,
  },
  scroll: {
    flex: 1,
  },
  trendBlock: {
    gap: 10,
    width: '100%',
  },
});
