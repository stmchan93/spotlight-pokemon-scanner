import { NavArrowLeft, ShareIos } from 'iconoir-react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Image, ScrollView, Share, StyleSheet, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import {
  DEFAULT_CARD_GAME,
  deckConditionOptions,
  type CardGame,
  type CatalogSearchResult,
  type ExpansionRecord,
  type InventoryCardEntry,
  type RarityBucket,
} from '@spotlight/api-client';
import {
  GlassNavBubble,
  PillButton,
  SearchField,
  SectionHeader,
  StateCard,
  Toast,
  cardGrid,
  glassNavBubbleGlyphSize,
  glassNavBubbleGlyphStrokeWidth,
  layout,
  spacing,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { useGuestGate } from '@/features/auth/use-guest-gate';
import { consumeCardAddedNotice } from '@/features/cards/card-added-notice';
import { invalidateCardDetailCache } from '@/features/cards/card-detail-prefetch';
import { useSetPageAccent } from '@/features/catalog/hooks/use-set-page-accent';
import { OwnedCopiesSheet } from '@/features/catalog/components/owned-copies-sheet';
import { SetCardTile } from '@/features/catalog/components/set-card-tile';
import { SetProgressCard } from '@/features/catalog/components/set-progress-card';
import {
  countOwnedCards,
  filterSetCards,
  rarityChipsForCards,
  setCompletion,
} from '@/features/catalog/set-progress';
import { eventGradientStops } from '@/features/events/event-accent';
import { formatCurrency } from '@/features/portfolio/components/portfolio-formatting';
import { withLoadDeadline } from '@/lib/load-deadline';
import { useForegroundRefetch } from '@/lib/use-foreground-refetch';
import { useAppServices } from '@/providers/app-providers';

type ExpansionDetailScreenProps = {
  expansionId: string;
  expansionName: string;
  /** The set's game — `set_id` is only unique within one. Absent means Pokémon. */
  game?: CardGame;
  onClose: () => void;
  onOpenCard: (result: CatalogSearchResult) => void;
};

/** The whole set in one call (the backend's ceiling); search + chips filter it locally. */
export const SET_PAGE_CARD_LIMIT = 1000;

// Figma 6597:3819 geometry: the centred set logo 62 below the status bar
// (under the 44pt toolbar); the wash fills the whole hero, ending where the
// white search band starts.
const LOGO_WIDTH = 167;
const LOGO_HEIGHT = 80;
const LOGO_TOP_BELOW_SAFE_AREA = 62;

type CopiesSheetState = { card: CatalogSearchResult; copies: InventoryCardEntry[] } | null;

/** The chip row's pick: ALL (null), SEALED, or one rarity bucket. */
export type SetPageFilter = RarityBucket | 'sealed' | null;

export type SetPageItem =
  | { kind: 'row'; key: string; items: CatalogSearchResult[] }
  | { kind: 'sealed-heading'; key: string };

function chunkPairs<T>(items: readonly T[]): T[][] {
  const rows: T[][] = [];
  for (let index = 0; index < items.length; index += 2) {
    rows.push(items.slice(index, index + 2));
  }
  return rows;
}

function pairRows(items: readonly CatalogSearchResult[]): SetPageItem[] {
  return chunkPairs(items).map((row) => ({ kind: 'row', key: row[0].id, items: row }));
}

/**
 * The grid's rows. SEALED: only the set's sealed products. A rarity: only
 * those cards. ALL: every card, then the sealed products under a SEALED
 * heading at the very bottom.
 */
export function buildSetPageItems(
  cards: readonly CatalogSearchResult[],
  sealed: readonly CatalogSearchResult[],
  filter: SetPageFilter,
): SetPageItem[] {
  if (filter === 'sealed') {
    return pairRows(sealed);
  }
  if (filter !== null || sealed.length === 0) {
    return pairRows(cards);
  }
  return [...pairRows(cards), { kind: 'sealed-heading', key: 'sealed-heading' }, ...pairRows(sealed)];
}

const SEALED_LABEL = 'SEALED';

const NEAR_MINT = deckConditionOptions.find((option) => option.code === 'near_mint') ?? null;

/**
 * A set's page with completion (Figma 6597:3819): back + share, logo on a
 * warm wash, a floating card with name, release date, a 20pt progress bar,
 * the FULL set's value and "X of Y CARDS", a card search and
 * rarity chips, then EVERY card in the set two-up — full colour, the ones you
 * own marked ✓ / ×N on the art — each with − QTY +.
 *
 * SEALED: when the set's TCGplayer group has sealed products, a SEALED chip
 * follows ALL (only sealed), and ALL lists them under a SEALED heading after
 * every card. They never count toward "X of Y" or the set's value.
 *
 * + adds one copy (default printing, Near Mint, raw; sealed: no printing or
 *   condition, as the sealed product page adds it) through the same
 *   `createInventoryEntry` the card page's ADD ITEM uses.
 * − removes one copy. Owned in exactly one form → that entry is decremented
 *   (deleted at 0). Owned in more than one form → a sheet asks which copy; the
 *   rule is no guessing.
 *
 * Both are optimistic (tile + header progress move at once) and roll back with
 * a toast on failure. The shared Collection caches get the same optimistic
 * entry the card page writes; leaving the page bumps `refreshData()` once so
 * the Collection, the dashboard and the sets list's progress reconcile to the
 * server — one refetch per visit, not per tap.
 */
export function ExpansionDetailScreen({
  expansionId,
  expansionName,
  game = DEFAULT_CARD_GAME,
  onClose,
  onOpenCard,
}: ExpansionDetailScreenProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const {
    activeCollectionID,
    dataVersion,
    inventoryEntriesCache,
    prependOptimisticInventoryEntry,
    refreshData,
    removeOptimisticInventoryEntries,
    spotlightRepository,
  } = useAppServices();
  const { gate } = useGuestGate();

  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const dirtyRef = useRef(false);
  // On FOCUS: this screen stays mounted under the card page, so the "Added to
  // your collection" handoff has to be read when it comes back. On BLUR (and
  // unmount): one refresh if anything changed here.
  useFocusEffect(
    useCallback(() => {
      const notice = consumeCardAddedNotice();
      if (notice) {
        setToastMessage(notice);
      }
      return () => {
        if (dirtyRef.current) {
          dirtyRef.current = false;
          refreshData();
        }
      };
    }, [refreshData]),
  );

  const [expansion, setExpansion] = useState<ExpansionRecord | null>(null);
  const [cards, setCards] = useState<CatalogSearchResult[]>([]);
  // The set's sealed products: beside the card list, never in its completion.
  const [sealed, setSealed] = useState<CatalogSearchResult[]>([]);
  const [hasLoadedCards, setHasLoadedCards] = useState(false);
  const [cardsError, setCardsError] = useState<string | null>(null);
  const [cardsLoadedAt, setCardsLoadedAt] = useState<number | null>(null);
  const [cardsReloadToken, setCardsReloadToken] = useState(0);
  const reloadCards = useCallback(() => setCardsReloadToken((token) => token + 1), []);
  const [entries, setEntries] = useState<InventoryCardEntry[] | null>(null);
  const entriesRef = useRef<InventoryCardEntry[] | null>(null);
  entriesRef.current = entries;
  const inventoryCacheRef = useRef(inventoryEntriesCache);
  inventoryCacheRef.current = inventoryEntriesCache;

  const [cardQuery, setCardQuery] = useState('');
  const [filter, setFilter] = useState<SetPageFilter>(null);
  const [pendingCardIds, setPendingCardIds] = useState<ReadonlySet<string>>(new Set());
  const pendingRef = useRef(new Set<string>());
  const [copiesSheet, setCopiesSheet] = useState<CopiesSheetState>(null);

  // The set's own record carries the totals (`cardCount`, `setValue`) and logo.
  useEffect(() => {
    let cancelled = false;
    void spotlightRepository.listExpansions(game)
      .then((records) => {
        if (!cancelled) {
          setExpansion(records.find((record) => record.id === expansionId) ?? null);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [expansionId, game, spotlightRepository]);

  // Cards + the user's copies. Re-read on `dataVersion` so a card added from
  // the card page shows here on return; no loading flash once cards exist.
  useEffect(() => {
    let cancelled = false;
    // Bounded: a hung read ends in the error card + Retry, never an endless spinner.
    void withLoadDeadline(spotlightRepository.listCardsInExpansion(expansionId, '', SET_PAGE_CARD_LIMIT, game))
      .then((results) => {
        if (!cancelled) {
          setCards(results);
          setCardsError(null);
          setCardsLoadedAt(Date.now());
          setHasLoadedCards(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCardsError('Could not load this set right now. Check your connection and try again.');
          setHasLoadedCards(true);
        }
      });
    void spotlightRepository.listSealedInExpansion(expansionId, game)
      .then((results) => {
        if (!cancelled) {
          setSealed(results);
        }
      })
      .catch(() => undefined);
    void spotlightRepository.getInventoryEntries()
      .then((loaded) => {
        if (!cancelled) {
          setEntries(loaded);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [cardsReloadToken, dataVersion, expansionId, game, spotlightRepository]);

  useForegroundRefetch({
    failed: cardsError !== null,
    isLoading: !hasLoadedCards,
    lastLoadedAt: cardsLoadedAt,
    onRefetch: reloadCards,
  });

  const handleRetryCards = useCallback(() => {
    setHasLoadedCards(false);
    setCardsError(null);
    reloadCards();
  }, [reloadCards]);

  const setPending = useCallback((cardId: string, pending: boolean) => {
    if (pending) {
      pendingRef.current.add(cardId);
    } else {
      pendingRef.current.delete(cardId);
    }
    setPendingCardIds(new Set(pendingRef.current));
  }, []);

  const shiftOwned = useCallback((cardId: string, delta: number) => {
    const shift = (current: CatalogSearchResult[]) => current.map((card) => (
      card.cardId === cardId
        ? { ...card, ownedQuantity: Math.max(0, (card.ownedQuantity ?? 0) + delta) }
        : card
    ));
    setCards(shift);
    setSealed(shift);
  }, []);

  const upsertEntry = useCallback((entry: InventoryCardEntry) => {
    setEntries((current) => {
      const list = current ?? [];
      return list.some((candidate) => candidate.id === entry.id)
        ? list.map((candidate) => (candidate.id === entry.id ? entry : candidate))
        : [entry, ...list];
    });
  }, []);

  const dropEntry = useCallback((entryId: string) => {
    setEntries((current) => (current ? current.filter((entry) => entry.id !== entryId) : current));
  }, []);

  const handleIncrement = useCallback((card: CatalogSearchResult) => {
    if (pendingRef.current.has(card.cardId)) {
      return;
    }
    setPending(card.cardId, true);
    shiftOwned(card.cardId, 1);
    const addedAt = new Date().toISOString();
    // Sealed is one unopened line, exactly as the sealed product page adds it:
    // no printing, no condition.
    const isSealed = card.productKind === 'sealed';
    const variantName = isSealed ? null : card.defaultVariantLabel ?? null;
    const conditionOption = isSealed ? null : NEAR_MINT;
    void spotlightRepository.createInventoryEntry({
      cardID: card.cardId,
      slabContext: null,
      variantName,
      condition: isSealed ? null : 'near_mint',
      quantity: 1,
      sourceScanID: null,
      selectionSource: 'manual_search',
      addedAt,
      // Same target as the card page's ADD ITEM: the collection on screen in
      // the Collection tab ("All" lets the backend pick the default).
      collectionID: activeCollectionID,
    })
      .then((response) => {
        // The backend merges into an existing identical copy, returning its id.
        const existing = entriesRef.current?.find((entry) => entry.id === response.deckEntryID) ?? null;
        const next: InventoryCardEntry = existing
          ? { ...existing, quantity: existing.quantity + 1 }
          : {
            id: response.deckEntryID,
            cardId: card.cardId,
            name: card.name,
            cardNumber: card.cardNumber,
            setName: card.setName,
            imageUrl: card.imageUrl,
            smallImageUrl: card.smallImageUrl ?? null,
            marketPrice: card.marketPrice ?? 0,
            hasMarketPrice: card.marketPrice != null,
            currencyCode: card.currencyCode ?? 'USD',
            quantity: 1,
            addedAt: response.addedAt || addedAt,
            kind: 'raw',
            variantName: response.variantName ?? variantName,
            conditionCode: conditionOption?.code ?? null,
            conditionLabel: conditionOption?.label ?? null,
            conditionShortLabel: conditionOption?.shortLabel ?? null,
            slabContext: null,
            rarityBucket: card.rarityBucket,
            game: card.game,
            catalogSource: card.catalogSource,
          };
        upsertEntry(next);
        // A merged copy only replaces a row the active collection's cache
        // already holds; a new one is prepended exactly like the card page's add.
        if (!existing || inventoryCacheRef.current?.some((entry) => entry.id === next.id)) {
          prependOptimisticInventoryEntry(next);
        }
        invalidateCardDetailCache(card.cardId);
        dirtyRef.current = true;
      })
      .catch(() => {
        shiftOwned(card.cardId, -1);
        setToastMessage(`Couldn't add ${card.name}. Try again.`);
      })
      .finally(() => setPending(card.cardId, false));
  }, [
    activeCollectionID,
    prependOptimisticInventoryEntry,
    setPending,
    shiftOwned,
    spotlightRepository,
    upsertEntry,
  ]);

  const removeOneFrom = useCallback((card: CatalogSearchResult, entry: InventoryCardEntry) => {
    if (pendingRef.current.has(card.cardId)) {
      return;
    }
    setPending(card.cardId, true);
    shiftOwned(card.cardId, -1);
    const nextQuantity = entry.quantity - 1;
    if (nextQuantity > 0) {
      upsertEntry({ ...entry, quantity: nextQuantity });
    } else {
      dropEntry(entry.id);
    }
    const write = nextQuantity > 0
      ? spotlightRepository.setPortfolioEntryQuantity({ deckEntryID: entry.id, quantity: nextQuantity })
      : spotlightRepository.deletePortfolioEntry({ deckEntryID: entry.id });
    void Promise.resolve(write)
      .then(() => {
        if (nextQuantity > 0) {
          if (inventoryCacheRef.current?.some((cached) => cached.id === entry.id)) {
            prependOptimisticInventoryEntry({ ...entry, quantity: nextQuantity });
          }
        } else {
          removeOptimisticInventoryEntries([entry.id]);
        }
        invalidateCardDetailCache(card.cardId);
        dirtyRef.current = true;
      })
      .catch(() => {
        shiftOwned(card.cardId, 1);
        upsertEntry(entry);
        setToastMessage(`Couldn't remove ${card.name}. Try again.`);
      })
      .finally(() => setPending(card.cardId, false));
  }, [
    dropEntry,
    prependOptimisticInventoryEntry,
    removeOptimisticInventoryEntries,
    setPending,
    shiftOwned,
    spotlightRepository,
    upsertEntry,
  ]);

  const handleDecrement = useCallback(async (card: CatalogSearchResult) => {
    if (pendingRef.current.has(card.cardId)) {
      return;
    }
    let all = entriesRef.current;
    if (!all || !all.some((entry) => entry.cardId === card.cardId)) {
      // Not loaded yet, or stale: ask once before deciding.
      all = await spotlightRepository.getInventoryEntries().catch(() => all ?? []);
      setEntries(all);
    }
    const copies = all.filter((entry) => entry.cardId === card.cardId && entry.quantity > 0);
    if (copies.length === 0) {
      setToastMessage(`Couldn't find your copy of ${card.name}.`);
      return;
    }
    if (copies.length === 1) {
      removeOneFrom(card, copies[0]);
      return;
    }
    setCopiesSheet({ card, copies });
  }, [removeOneFrom, spotlightRepository]);

  const onIncrement = useMemo(() => gate(handleIncrement), [gate, handleIncrement]);
  const onDecrement = useCallback((card: CatalogSearchResult) => {
    void handleDecrement(card);
  }, [handleDecrement]);

  const chips = useMemo(() => rarityChipsForCards(cards, game), [cards, game]);
  const hasSealed = sealed.length > 0;
  // A chip that vanished (its last match is gone) drops back to ALL.
  const activeFilter: SetPageFilter = filter === 'sealed'
    ? (hasSealed ? 'sealed' : null)
    : filter && chips.some((chip) => chip.bucket === filter) ? filter : null;
  const activeRarity = activeFilter === 'sealed' ? null : activeFilter;
  const visibleCards = useMemo(
    () => filterSetCards(cards, cardQuery, activeRarity),
    [activeRarity, cardQuery, cards],
  );
  const visibleSealed = useMemo(() => filterSetCards(sealed, cardQuery, null), [cardQuery, sealed]);
  const items = useMemo(
    () => buildSetPageItems(visibleCards, visibleSealed, activeFilter),
    [activeFilter, visibleCards, visibleSealed],
  );

  // Y = the set's served total (secret rares included); before an older
  // backend sends one, the whole set we loaded is the same list.
  const completion = setCompletion(
    expansion?.cardCount ?? (hasLoadedCards && cards.length > 0 ? cards.length : null),
    countOwnedCards(cards),
  );
  const totalValueLabel = expansion?.setValue != null ? formatCurrency(expansion.setValue, 'USD') : null;
  const logoUrl = expansion?.imageUrl ?? null;
  // The wash takes the set's own colour from its logo (token accent until then).
  const washStops = eventGradientStops(useSetPageAccent(logoUrl));
  const [hasLogoError, setHasLogoError] = useState(false);
  const setName = expansion?.name ?? expansionName;

  const handleShare = useCallback(() => {
    const lines = [`${setName} on Ekalight`];
    if (completion) {
      lines.push(`I have ${completion.owned} of ${completion.total} cards`);
    }
    void Share.share({ message: lines.join('\n') }).catch(() => undefined);
  }, [completion, setName]);

  const renderCardsState = () => {
    if (!hasLoadedCards) {
      return (
        <StateCard centered loading message="Loading cards from this set." style={styles.stateCard} title="Loading" />
      );
    }
    // Already-loaded cards stay on screen through a failed refresh.
    if (cardsError && cards.length === 0) {
      return (
        <StateCard
          actionLabel="Retry"
          actionTestID="expansion-detail-retry"
          centered
          message={cardsError}
          onActionPress={handleRetryCards}
          style={styles.stateCard}
          testID="expansion-detail-error"
          title="Could not load cards"
        />
      );
    }
    if (items.length === 0) {
      return (
        <StateCard
          centered
          message={cards.length > 0 || hasSealed ? 'Try a different name or number.' : 'No cards found in this set yet.'}
          style={styles.stateCard}
          title={activeFilter === 'sealed' ? 'No sealed products' : 'No cards'}
        />
      );
    }
    return null;
  };

  const header = (
    <View>
      <View style={[styles.hero, { paddingTop: insets.top + LOGO_TOP_BELOW_SAFE_AREA }]}>
        <Svg height="100%" pointerEvents="none" style={StyleSheet.absoluteFill} testID="set-page-wash" width="100%">
          <Defs>
            <LinearGradient id="setPageWash" x1="0" x2="0" y1="0" y2="1">
              {washStops.map((stop) => (
                <Stop key={stop.offset} offset={stop.offset} stopColor={stop.color} stopOpacity="1" />
              ))}
            </LinearGradient>
          </Defs>
          <Rect fill="url(#setPageWash)" height="100%" width="100%" x="0" y="0" />
        </Svg>
        <View style={styles.logoSlot}>
          {logoUrl && !hasLogoError ? (
            <Image
              onError={() => setHasLogoError(true)}
              resizeMode="contain"
              source={{ uri: logoUrl }}
              style={styles.logo}
              testID="set-page-logo"
            />
          ) : null}
        </View>
        <SetProgressCard
          completion={completion}
          name={setName}
          releaseDate={expansion?.releaseDate ?? null}
          testID="set-page-header"
          totalValueLabel={totalValueLabel}
          variant="header"
        />
      </View>
      <View style={[styles.controls, { backgroundColor: theme.colors.gray0 }]}>
        <SearchField
          autoCapitalize="none"
          autoCorrect={false}
          containerStyle={{ backgroundColor: theme.colors.gray100 }}
          onChangeText={setCardQuery}
          placeholder="Search card"
          returnKeyType="search"
          testID="set-page-search"
          uppercasePlaceholder
          value={cardQuery}
        />
        {chips.length > 0 || hasSealed ? (
          <ScrollView
            contentContainerStyle={styles.chips}
            horizontal
            keyboardShouldPersistTaps="handled"
            showsHorizontalScrollIndicator={false}
            style={styles.chipScroller}
            testID="set-page-rarity-chips"
          >
            <PillButton
              label="ALL"
              labelRole="caption"
              onPress={() => setFilter(null)}
              selected={activeFilter === null}
              testID="set-page-rarity-all"
              tone="filled"
            />
            {hasSealed ? (
              <PillButton
                label={SEALED_LABEL}
                labelRole="caption"
                onPress={() => setFilter('sealed')}
                selected={activeFilter === 'sealed'}
                testID="set-page-sealed-chip"
                tone="filled"
              />
            ) : null}
            {chips.map((chip) => (
              <PillButton
                key={chip.bucket}
                label={chip.label}
                labelRole="caption"
                onPress={() => setFilter(chip.bucket)}
                selected={activeFilter === chip.bucket}
                testID={`set-page-rarity-${chip.bucket}`}
                tone="filled"
              />
            ))}
          </ScrollView>
        ) : null}
        {renderCardsState()}
      </View>
    </View>
  );

  return (
    <View style={[styles.screen, { backgroundColor: cardGrid.background }]}>
      <FlatList
        ListHeaderComponent={header}
        contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + spacing.lg }]}
        data={items}
        keyExtractor={(item) => item.key}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) => (item.kind === 'sealed-heading' ? (
          <View style={styles.sealedHeading}>
            <SectionHeader size="compact" testID="set-page-sealed-heading" title={SEALED_LABEL} uppercase />
          </View>
        ) : (
          <View style={styles.row}>
            {item.items.map((card, index) => (
              <SetCardTile
                card={card}
                column={index === 0 ? 'left' : 'right'}
                isPending={pendingCardIds.has(card.cardId)}
                key={card.id}
                onDecrement={onDecrement}
                onIncrement={onIncrement}
                onPress={onOpenCard}
              />
            ))}
            {item.items.length < 2 ? <View style={styles.rowSpacer} /> : null}
          </View>
        ))}
        showsVerticalScrollIndicator={false}
        testID="set-page-grid"
      />

      <View pointerEvents="box-none" style={[styles.toolbar, { top: insets.top }]}>
        <GlassNavBubble accessibilityLabel="Back" material="frost" onPress={onClose} size="medium" testID="set-page-back">
          <NavArrowLeft
            color={theme.colors.gray900}
            height={glassNavBubbleGlyphSize}
            strokeWidth={glassNavBubbleGlyphStrokeWidth}
            width={glassNavBubbleGlyphSize}
          />
        </GlassNavBubble>
        <GlassNavBubble
          accessibilityLabel="Share set"
          material="frost"
          onPress={handleShare}
          size="medium"
          testID="set-page-share"
        >
          <ShareIos
            color={theme.colors.gray900}
            height={glassNavBubbleGlyphSize}
            strokeWidth={glassNavBubbleGlyphStrokeWidth}
            width={glassNavBubbleGlyphSize}
          />
        </GlassNavBubble>
      </View>

      <OwnedCopiesSheet
        cardName={copiesSheet?.card.name ?? ''}
        copies={copiesSheet?.copies ?? []}
        onClose={() => setCopiesSheet(null)}
        onSelect={(entry) => {
          const card = copiesSheet?.card;
          setCopiesSheet(null);
          if (card) {
            removeOneFrom(card, entry);
          }
        }}
        visible={copiesSheet !== null}
      />

      <Toast
        message={toastMessage ?? ''}
        onDismiss={() => setToastMessage(null)}
        // Inset carried on `bottom` itself — Yoga's absolute layout ignores
        // parent padding, so without it Android's nav bar covered the toast.
        style={[styles.toast, { bottom: insets.bottom + spacing.lg }]}
        testID="expansion-added-toast"
        visible={toastMessage !== null}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  chipScroller: {
    marginHorizontal: -layout.pageGutter,
  },
  chips: {
    gap: 10,
    paddingHorizontal: layout.pageGutter,
  },
  // Figma 6597:3820: white band, 16 in, 10 between search and chips.
  controls: {
    gap: 10,
    paddingBottom: spacing.sm,
    paddingHorizontal: layout.pageGutter,
    paddingTop: spacing.sm,
  },
  // Logo → card 32 (Figma 6597:3837 → 6597:3931); card → band 16.
  hero: {
    alignItems: 'center',
    gap: spacing.xxl,
    paddingBottom: spacing.sm,
    paddingHorizontal: layout.pageGutter,
  },
  listContent: {
    gap: cardGrid.gap,
  },
  logo: {
    height: '100%',
    width: '100%',
  },
  logoSlot: {
    height: LOGO_HEIGHT,
    width: LOGO_WIDTH,
  },
  row: {
    alignItems: 'stretch',
    flexDirection: 'row',
    gap: cardGrid.gap,
  },
  rowSpacer: {
    flex: 1,
  },
  screen: {
    flex: 1,
  },
  // Small-caps heading over the set's sealed products, below every card.
  sealedHeading: {
    paddingHorizontal: layout.pageGutter,
    paddingTop: spacing.lg,
  },
  stateCard: {
    gap: spacing.sm,
    paddingVertical: spacing.lg,
  },
  toast: {
    left: layout.pageGutter,
    position: 'absolute',
    right: layout.pageGutter,
  },
  toolbar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    left: 0,
    paddingHorizontal: layout.pageGutter,
    position: 'absolute',
    right: 0,
  },
});
