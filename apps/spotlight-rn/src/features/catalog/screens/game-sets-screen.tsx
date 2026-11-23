import { FilterList, NavArrowLeft, Xmark } from 'iconoir-react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Image,
  Keyboard,
  ScrollView,
  StyleSheet,
  type TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { EkalightAiFlare, EkalightAiRing } from '@/components/ekalight-ai-glyph';
import { PullDownToDismiss, usePullDownToDismiss } from '@/components/pull-down-to-dismiss';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import {
  gameDisplayName,
  type CardGame,
  type CatalogSearchResult,
  type ExpansionRecord,
  type InventoryCardEntry,
} from '@spotlight/api-client';
import {
  GlassNavBubble,
  IconButton,
  PageTabs,
  PillButton,
  SearchField,
  SectionHeader,
  StateCard,
  Text,
  glassNavBubbleGlyphSize,
  glassNavBubbleSizes,
  glassNavBubbleGlyphStrokeWidth,
  layout,
  radii,
  searchFieldCollectionHeight,
  spacing,
  useSpotlightTheme,
} from '@spotlight/design-system';

import type { UserProfile } from '@/features/auth/auth-models';
import {
  catalogSearchFilterLabel,
  catalogSearchFilterParams,
  useCatalogSearchFilter,
} from '@/features/catalog/catalog-search-filter';
import { CatalogResultsGrid } from '@/features/catalog/components/catalog-results-grid';
import { CatalogSearchFilterSheet } from '@/features/catalog/components/catalog-search-filter-sheet';
import { SealedResultsSection } from '@/features/catalog/components/sealed-results-section';
import { SearchRailTile } from '@/features/catalog/components/search-rail-tile';
import { SearchSectionHeader } from '@/features/catalog/components/search-section-header';
import { SearchSetCard } from '@/features/catalog/components/search-set-card';
import { useCatalogCardSearch } from '@/features/catalog/hooks/use-catalog-card-search';
import { useSealedSearchPreview } from '@/features/catalog/hooks/use-sealed-search-preview';
import { GAME_EXPANSIONS_ERROR, useGameExpansions } from '@/features/catalog/hooks/use-game-expansions';
import { useSealedRail, useSinglesRail } from '@/features/catalog/hooks/use-search-landing-previews';
import { useSetProgress } from '@/features/catalog/hooks/use-set-progress';
import { resultsCountLabel, singlesSourceSets, totalCardCount } from '@/features/catalog/search-landing';
import { groupSetsByEra, setCompletion, type SetListRow } from '@/features/catalog/set-progress';
import { PeopleSearchResults } from '@/features/profile/components/people-search-results';
import { capturePostHogEvent } from '@/lib/observability/posthog';
import { useAuth } from '@/providers/auth-provider';

type GameSetsScreenProps = {
  /** The game the chips start on. The chips switch games in place. */
  game: CardGame;
  onClose: () => void;
  onSelectExpansion: (expansion: ExpansionRecord, game: CardGame) => void;
  onOpenCard: (result: CatalogSearchResult) => void;
  /** Ask Ekalight (the sparkle). Absent hides the button rather than leaving it dead. */
  onOpenAssistant?: () => void;
  /**
   * `close` (X) when this screen opened by sliding UP (Search's landing): a
   * slide-up screen closes with X, a side push goes back with ‹ (owner, 2026-11-20).
   */
  dismissStyle?: 'back' | 'close';
  /**
   * `landing` (default): the Search landing (Figma 6597:5654) — SINGLES and
   * SEALED rails and the newest sets, each with VIEW ALL. `sets`: every set,
   * grouped by era. `sealed`: every sealed product of the game, paged.
   */
  view?: GameSetsView;
  /** VIEW ALL on SETS / SEALED. Absent hides those two links. */
  onViewAll?: (section: 'sets' | 'sealed', game: CardGame) => void;
  /**
   * Present = this is SEARCH (Figma 6642:12483 / 6642:14400): CARDS | PEOPLE
   * tabs on the banner, a filter button beside the field, the game chips under
   * the tabs. `tab` = the bottom-bar Search tab: no close and no Ask button.
   * `sheet` = the /catalog/search sheet: keeps its close (X).
   */
  searchMode?: SearchMode;
  /** PEOPLE: a person's header or bio was tapped. */
  onOpenProfile?: (profile: UserProfile) => void;
  /** PEOPLE: one of a person's most valuable cards was tapped. */
  onOpenHolding?: (profile: UserProfile, entry: InventoryCardEntry) => void;
  /** Search tab to open on (dev screens / deep links); CARDS by default. */
  initialSearchTab?: SearchTab;
};

export type GameSetsView = 'landing' | 'sets' | 'sealed';
export type SearchMode = 'tab' | 'sheet';
export type SearchTab = 'cards' | 'people';
const SEARCH_TABS = [
  { label: 'Cards', value: 'cards' },
  { label: 'People', value: 'people' },
] as const;
/** Figma 6642:12511. */
const SEARCH_PLACEHOLDER = 'Search cards, people, sets';

/** Sealed matches under the card results: a section, not another paged list. */
const SEALED_RESULTS_LIMIT = 20;

// Figma 6597:5655 header: a 393×264 wash over the banner, which is drawn at
// its own ratio (786×646) from the top and clipped at the wash's bottom.
const FIGMA_FRAME_WIDTH = 393;
const WASH_FIGMA_HEIGHT = 264;
const BANNER_ASPECT = 786 / 646;
const SETS_BANNER = require('../../../../assets/images/catalog/sets-banner.jpg');
/** Figma 6597:5711 shows three sets on the landing; VIEW ALL opens the rest. */
const LANDING_SET_COUNT = 3;

/**
 * Search (Figma 6597:5654): the title is the game and GAME CHIPS switch games
 * in place. The landing shows three sections, each with a "(N RESULTS)" count
 * and VIEW ALL:
 * - SINGLES: a rail of the game's newest set's priciest cards; the count is
 *   every card in the game (the sum of its sets' card counts).
 * - SEALED: a rail of the game's sealed product (no count: nothing returns a
 *   game-level sealed total).
 * - SETS: the first few sets as progress cards — logo, name, date, a bar with
 *   the percent, TOTAL VALUE and "X of Y CARDS".
 *
 * The full sets list (`view="sets"`) is GROUPED BY ERA when the backend sends one (Pokémon: "MEGA EVOLUTION",
 * "SCARLET & VIOLET", …): eras newest first, each era's promos after its main
 * sets. Games with no eras stay one flat list, promos last. Online-only sets
 * (TCG Pocket) never arrive — the backend drops them.
 *
 * THE SEARCH FOLLOWS YOU DOWN. It is the same card search the catalog has,
 * scoped to the game on screen; set names are searchable, so "obsidian flames"
 * still finds that set's cards. While a query is live the results replace the
 * set list. Matching SEALED product (same game) follows at the very bottom,
 * once every card result has loaded — cards first, sealed after.
 *
 * The header is FIXED and only the body below swaps: the search field must
 * never sit in a subtree a state change replaces, or it remounts and drops the
 * keyboard mid-word (user, 2026-09-10 — "luffy" searched "lu").
 */
export function GameSetsScreen({
  game: initialGame,
  onClose,
  onOpenCard,
  onSelectExpansion,
  onOpenAssistant,
  dismissStyle = 'back',
  view = 'landing',
  onViewAll,
  searchMode,
  onOpenProfile,
  onOpenHolding,
  initialSearchTab = 'cards',
}: GameSetsScreenProps) {
  const theme = useSpotlightTheme();
  const isSearch = searchMode != null && view === 'landing';
  const isTabMode = isSearch && searchMode === 'tab';
  const viewerId = useAuth().currentUser?.id ?? null;
  const [searchTab, setSearchTab] = useState<SearchTab>(initialSearchTab);
  const onPeopleTab = isSearch && searchTab === 'people';
  // The PEOPLE list (and its suggestions read) mounts on first visit, then stays.
  const [peopleVisited, setPeopleVisited] = useState(initialSearchTab === 'people');
  const [peopleQuery, setPeopleQuery] = useState('');
  // Rarity / Sealed, from the filter sheet (Search only).
  const filter = useCatalogSearchFilter();
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
  const filterParams = catalogSearchFilterParams(isSearch ? filter.activeFilter : null);
  const activeFilterLabel = isSearch ? catalogSearchFilterLabel(filter.activeFilter) : null;
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  const washHeight = Math.round((windowWidth * WASH_FIGMA_HEIGHT) / FIGMA_FRAME_WIDTH);
  const [game, setGame] = useState<CardGame>(initialGame);
  const { byGame, error, failedGames, games, hasLoaded, isLoading, reload } = useGameExpansions();
  const { ownedByExpansion } = useSetProgress(game);
  const search = useCatalogCardSearch({ scope: game, ...filterParams });
  const sealedSearch = useSealedSearchPreview({
    // A filter replaces the sealed footer: Sealed IS the results, a rarity has no sealed.
    enabled: filter.activeFilter == null || !isSearch,
    limit: SEALED_RESULTS_LIMIT,
    query: search.query,
    scope: game,
  });
  // VIEW ALL on SEALED: every sealed product of the game, paged (the Sealed chip's browse).
  const sealedBrowse = useCatalogCardSearch({ scope: game, sealed: view === 'sealed' });
  // Bottom of the list = after the LAST card page, so it waits for paging.
  const sealedResults = search.hasMore ? [] : sealedSearch.results;
  // Blurred when a result opens, so no focus survives to be restored when the
  // card page pops back to this screen.
  const searchFieldRef = useRef<TextInput>(null);
  const [openingResultId, setOpeningResultId] = useState<string | null>(null);

  // The backend returns `release_date DESC NULLS LAST, name ASC` — newest first;
  // grouping keeps that order inside each era.
  const expansions = useMemo(() => byGame[game] ?? [], [byGame, game]);
  const rows = useMemo(() => groupSetsByEra(expansions), [expansions]);
  // Sets in list order (era'd: newest era first, promos after its mains).
  const orderedSets = useMemo(
    () => rows.flatMap((row) => (row.kind === 'set' ? [row.expansion] : [])),
    [rows],
  );
  const isLanding = view === 'landing';
  const singlesSources = useMemo(
    () => (isLanding ? singlesSourceSets(orderedSets) : []),
    [isLanding, orderedSets],
  );
  const singles = useSinglesRail(game, singlesSources);
  const sealedRail = useSealedRail(game, isLanding);
  // The route's game stays a chip even before its sets load, so the row never
  // jumps under the selected chip.
  const chipGames = games.includes(game) ? games : [game, ...games];

  // Slid up (Search's landing): swipe down anywhere closes it once the list is at the top.
  const pullDown = usePullDownToDismiss({ enabled: dismissStyle === 'close', onDismiss: onClose });
  const showsResults =
    search.hasActiveQuery && !search.errorMessage && (search.results.length > 0 || sealedResults.length > 0);
  const { resetScroll } = pullDown;
  // Switching lists mounts a fresh one at the top.
  useEffect(() => {
    resetScroll();
  }, [resetScroll, searchTab, showsResults, view]);

  const openResult = useCallback(
    (result: CatalogSearchResult) => {
      const isSealed = result.productKind === 'sealed';
      capturePostHogEvent('catalog_search_result_opened', {
        has_rarity_filter: filterParams.rarityBucket != null,
        is_sealed: isSealed,
        result_count: isSealed ? sealedResults.length : search.results.length,
        scope: game,
      });
      searchFieldRef.current?.blur();
      Keyboard.dismiss();
      setOpeningResultId(result.id);
      onOpenCard(result);
    },
    [filterParams.rarityBucket, game, onOpenCard, sealedResults.length, search.results.length],
  );

  const renderSetsState = () => {
    if (isLoading && !hasLoaded) {
      return (
        <StateCard
          centered
          loading
          message="Loading expansions from your card library."
          style={styles.stateCard}
          title="Loading sets"
        />
      );
    }
    // This game's own read failed even if others answered: never "No sets".
    const setsError = error || (failedGames.includes(game) && expansions.length === 0 ? GAME_EXPANSIONS_ERROR : '');
    if (setsError) {
      return (
        <StateCard
          actionLabel="Retry"
          actionTestID="game-sets-retry"
          centered
          message={setsError}
          onActionPress={reload}
          style={styles.stateCard}
          testID="game-sets-error"
          title="Could not load sets"
        />
      );
    }
    if (hasLoaded && expansions.length === 0) {
      return (
        <StateCard
          centered
          message="No expansions are loaded yet. Sync the catalog and try again."
          style={styles.stateCard}
          title="No sets available"
        />
      );
    }
    return null;
  };

  const renderSearchState = () => {
    if (search.isLoading && search.results.length === 0) {
      return (
        <StateCard
          centered
          loading
          message="Looking up matching cards and inventory quantities."
          style={styles.stateCard}
          title="Searching catalog"
        />
      );
    }
    if (search.errorMessage) {
      return (
        <StateCard
          actionLabel="Retry"
          actionTestID="game-sets-search-retry"
          centered
          message={search.errorMessage}
          onActionPress={search.retry}
          style={styles.stateCard}
          title="Search unavailable"
        />
      );
    }
    if (search.hasSearched && search.results.length === 0 && !search.errorMessage) {
      if (sealedResults.length > 0) {
        // No cards, but sealed matches: the sealed section stands in.
        return null;
      }
      if (sealedSearch.isLoading) {
        return (
          <StateCard
            centered
            loading
            message="Looking up matching sealed products."
            style={styles.stateCard}
            title="Searching catalog"
          />
        );
      }
      return (
        <StateCard
          centered
          message={`Nothing in ${gameDisplayName(game)} matched. Try a shorter query or just the collector number.`}
          style={styles.stateCard}
          title="No matching cards"
        />
      );
    }
    return null;
  };

  const body = () => {
    if (!isSearch || !peopleVisited) {
      return cardsBody();
    }
    // PEOPLE stays mounted once visited (hidden on CARDS), so its list and the
    // holdings it read survive a tab flip.
    return (
      <>
        <View style={[styles.body, onPeopleTab ? null : styles.hidden]}>
          <GestureDetector gesture={pullDown.scrollGesture}>
            <PeopleSearchResults
              enabled
              onOpenHolding={(profile, entry) => {
                searchFieldRef.current?.blur();
                Keyboard.dismiss();
                onOpenHolding?.(profile, entry);
              }}
              onOpenProfile={(profile) => {
                searchFieldRef.current?.blur();
                Keyboard.dismiss();
                onOpenProfile?.(profile);
              }}
              query={peopleQuery}
              scrollProps={pullDown.scrollProps}
              testID="search-people"
              viewerId={viewerId}
            />
          </GestureDetector>
        </View>
        {onPeopleTab ? null : cardsBody()}
      </>
    );
  };

  const cardsBody = () => {
    if (search.hasActiveQuery) {
      if (search.errorMessage || (search.results.length === 0 && sealedResults.length === 0)) {
        return null;
      }
      return (
        <GestureDetector gesture={pullDown.scrollGesture}>
        <CatalogResultsGrid
          footer={(
            <SealedResultsSection
              onOpenResult={openResult}
              openingResultId={openingResultId}
              results={sealedResults}
              testID="game-sets-sealed"
            />
          )}
          // The Sealed filter's results are product shots, not cards.
          artAspect={filterParams.sealed ? 'square' : undefined}
          isLoadingMore={search.isLoadingMore}
          onEndReached={search.loadMore}
          onOpenResult={openResult}
          openingResultId={openingResultId}
          results={search.results}
          scrollProps={pullDown.scrollProps}
          testID="game-sets-results"
        />
        </GestureDetector>
      );
    }
    if (view === 'sealed') {
      return renderSealedBrowse();
    }
    if (view === 'sets') {
      return renderAllSets();
    }
    return renderLanding();
  };

  const renderSetCard = (expansion: ExpansionRecord) => (
    <SearchSetCard
      completion={setCompletion(expansion.cardCount, ownedByExpansion[expansion.id] ?? 0)}
      key={expansion.id}
      logoUrl={expansion.imageUrl}
      name={expansion.name}
      onPress={() => onSelectExpansion(expansion, game)}
      releaseDate={expansion.releaseDate}
      setValue={expansion.setValue ?? null}
      testID={`game-sets-expansion-${expansion.id}`}
    />
  );

  const renderAllSets = () => (
    <GestureDetector gesture={pullDown.scrollGesture}>
      <FlatList
        {...pullDown.scrollProps}
        contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + spacing.lg }]}
        data={rows}
        key="sets"
        keyExtractor={(row: SetListRow) => row.key}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item: row }: { item: SetListRow }) =>
          row.kind === 'era' ? (
            <View style={styles.eraHeader}>
              <SectionHeader size="compact" testID={`game-sets-era-${row.era}`} title={row.era} uppercase />
            </View>
          ) : (
            renderSetCard(row.expansion)
          )
        }
        showsVerticalScrollIndicator={false}
        style={styles.body}
        testID="game-sets-list"
      />
    </GestureDetector>
  );

  const renderSealedBrowse = () => {
    if (sealedBrowse.errorMessage) {
      return (
        <StateCard
          actionLabel="Retry"
          actionTestID="game-sets-sealed-retry"
          centered
          message={sealedBrowse.errorMessage}
          onActionPress={sealedBrowse.retry}
          style={[styles.stateCard, styles.bodyState]}
          title="Sealed unavailable"
        />
      );
    }
    if (sealedBrowse.results.length === 0) {
      return sealedBrowse.hasSearched ? (
        <StateCard
          centered
          message={`No sealed products for ${gameDisplayName(game)} yet.`}
          style={[styles.stateCard, styles.bodyState]}
          title="No sealed products"
        />
      ) : (
        <StateCard
          centered
          loading
          message="Loading sealed products."
          style={[styles.stateCard, styles.bodyState]}
          title="Loading sealed"
        />
      );
    }
    return (
      <GestureDetector gesture={pullDown.scrollGesture}>
        <CatalogResultsGrid
          artAspect="square"
          isLoadingMore={sealedBrowse.isLoadingMore}
          onEndReached={sealedBrowse.loadMore}
          onOpenResult={openResult}
          openingResultId={openingResultId}
          results={sealedBrowse.results}
          scrollProps={pullDown.scrollProps}
          testID="game-sets-sealed-list"
        />
      </GestureDetector>
    );
  };

  const renderRail = (results: CatalogSearchResult[], testID: string) => (
    <ScrollView
      contentContainerStyle={styles.railContent}
      horizontal
      keyboardShouldPersistTaps="handled"
      showsHorizontalScrollIndicator={false}
      style={styles.rail}
      testID={testID}
    >
      {results.map((result) => (
        <SearchRailTile
          key={result.id}
          onPress={(item) => {
            if (openingResultId !== item.id) {
              openResult(item);
            }
          }}
          result={result}
          testID={`${testID}-${result.cardId}`}
        />
      ))}
    </ScrollView>
  );

  const renderGameChips = () => (
    <ScrollView
      contentContainerStyle={styles.chips}
      horizontal
      keyboardShouldPersistTaps="handled"
      showsHorizontalScrollIndicator={false}
      style={styles.chipScroller}
      testID="game-sets-game-chips"
    >
      {chipGames.map((chipGame) => (
        <PillButton
          key={chipGame}
          label={gameDisplayName(chipGame)}
          labelRole="caption"
          onPress={() => setGame(chipGame)}
          selected={chipGame === game}
          testID={`game-sets-game-${chipGame}`}
          // Figma's "Secondary" chip, the same one News / Market Watch use.
          tone="secondary"
          uppercase
        />
      ))}
    </ScrollView>
  );

  const renderLanding = () => {
    const landingSets = orderedSets.slice(0, LANDING_SET_COUNT);
    const singlesSet = singles.set;
    return (
      <GestureDetector gesture={pullDown.scrollGesture}>
        <ScrollView
          {...pullDown.scrollProps}
          contentContainerStyle={[
            styles.landingContent,
            // Search: the chips above already pay 16 of it (Figma 6642:12697 → 12517).
            isSearch ? styles.searchLandingContent : null,
            { paddingBottom: insets.bottom + spacing.lg },
          ]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          style={styles.body}
          testID="game-sets-landing"
        >
          {singles.results.length > 0 ? (
            <View style={styles.section}>
              <SearchSectionHeader
                countLabel={resultsCountLabel(totalCardCount(expansions))}
                onViewAll={singlesSet ? () => onSelectExpansion(singlesSet, game) : undefined}
                testID="game-sets-singles-header"
                title="SINGLES"
              />
              {renderRail(singles.results, 'game-sets-singles')}
            </View>
          ) : null}
          {sealedRail.results.length > 0 ? (
            <View style={styles.section}>
              <SearchSectionHeader
                onViewAll={onViewAll ? () => onViewAll('sealed', game) : undefined}
                testID="game-sets-sealed-header"
                title="SEALED"
              />
              {renderRail(sealedRail.results, 'game-sets-sealed-rail')}
            </View>
          ) : null}
          {landingSets.length > 0 ? (
            <View style={[styles.section, styles.setsSection]}>
              <SearchSectionHeader
                countLabel={resultsCountLabel(orderedSets.length)}
                onViewAll={onViewAll ? () => onViewAll('sets', game) : undefined}
                testID="game-sets-sets-header"
                title="SETS"
              />
              {landingSets.map(renderSetCard)}
            </View>
          ) : null}
        </ScrollView>
      </GestureDetector>
    );
  };

  return (
    <PullDownToDismiss controller={pullDown} testID="game-sets-pull-down">
    <View style={[styles.screen, { backgroundColor: theme.colors.gray50 }]}>
      {/* Header banner (Figma 6597:5656) under its wash (6597:5657): clear at
          the top, purple through the middle, into the gray-50 page. */}
      <View pointerEvents="none" style={[styles.wash, { height: washHeight, width: windowWidth }]}>
        <Image
          resizeMode="cover"
          source={SETS_BANNER}
          style={{ height: windowWidth / BANNER_ASPECT, width: windowWidth }}
          testID="game-sets-banner"
        />
      </View>
      <Svg height={washHeight} pointerEvents="none" style={styles.wash} width={windowWidth}>
        <Defs>
          <LinearGradient id="gameSetsWash" x1="0" x2="0" y1="0" y2="1">
            <Stop offset="0" stopColor={theme.colors.gray500} stopOpacity="0" />
            <Stop offset="0.3488" stopColor={theme.colors.setsBannerWashSoft} stopOpacity="0.4" />
            <Stop offset="0.6" stopColor={theme.colors.setsBannerWash} stopOpacity="0.8" />
            <Stop offset="1" stopColor={theme.colors.gray50} stopOpacity="1" />
          </LinearGradient>
        </Defs>
        <Rect fill="url(#gameSetsWash)" height={washHeight} width={windowWidth} x="0" y="0" />
      </Svg>

      <View style={[styles.header, isSearch ? styles.searchHeader : null, { paddingTop: insets.top }]}>
        {isTabMode ? (
          // The Search TAB has no close and no Ask button; the empty bar keeps
          // the banner's composition (Figma 6642:12487).
          <View style={styles.toolbarSpacer} testID="game-sets-toolbar-spacer" />
        ) : (
          <View style={styles.toolbar}>
            <GlassNavBubble
              accessibilityLabel={dismissStyle === 'close' ? 'Close' : 'Back'}
              material="frost"
              onPress={onClose}
              size="medium"
              testID="game-sets-back"
            >
              {dismissStyle === 'close' ? (
                <Xmark
                  color={theme.colors.gray900}
                  height={glassNavBubbleGlyphSize}
                  strokeWidth={glassNavBubbleGlyphStrokeWidth}
                  width={glassNavBubbleGlyphSize}
                />
              ) : (
                <NavArrowLeft
                  color={theme.colors.gray900}
                  height={glassNavBubbleGlyphSize}
                  strokeWidth={glassNavBubbleGlyphStrokeWidth}
                  width={glassNavBubbleGlyphSize}
                />
              )}
            </GlassNavBubble>
            {onOpenAssistant ? (
              <GlassNavBubble
                accessibilityLabel="Ask Ekalight"
                material="frost"
                onPress={onOpenAssistant}
                size="medium"
                testID="game-sets-assistant"
              >
                {/* Same gradient flare + ring as the Social header (Figma 6597:5672). */}
                <EkalightAiFlare />
                <EkalightAiRing size={glassNavBubbleSizes.medium} />
              </GlassNavBubble>
            ) : null}
          </View>
        )}
        <View style={styles.controls}>
          <Text style={[theme.typography.titleLarge, { color: theme.colors.gray0 }]}>
            {gameDisplayName(game)}
          </Text>
          {isSearch ? (
            // Figma 6642:12675: a 40pt field and a 40pt filter button, 8 apart.
            <View style={styles.searchRow}>
              <View style={styles.searchFieldSlot}>
                <SearchField
                  ref={searchFieldRef}
                  autoCapitalize="none"
                  autoCorrect={false}
                  containerStyle={[styles.searchFieldBox, { backgroundColor: theme.colors.gray0 }]}
                  onChangeText={onPeopleTab ? setPeopleQuery : search.setQuery}
                  placeholder={SEARCH_PLACEHOLDER}
                  returnKeyType="search"
                  size="collection"
                  testID="game-sets-search"
                  uppercasePlaceholder
                  value={onPeopleTab ? peopleQuery : search.query}
                />
              </View>
              {onPeopleTab ? null : (
                <IconButton
                  accessibilityLabel={activeFilterLabel ? `Filters, ${activeFilterLabel}` : 'Filters'}
                  onPress={() => {
                    Keyboard.dismiss();
                    setFilterSheetOpen(true);
                  }}
                  selected={activeFilterLabel != null}
                  shape="rounded"
                  size={searchFieldCollectionHeight}
                  style={[styles.filterButton, { backgroundColor: theme.colors.gray0 }]}
                  testID="game-sets-filter"
                  variant="outlined"
                >
                  <FilterList
                    color={activeFilterLabel ? theme.colors.purple500 : theme.colors.gray900}
                    height={20}
                    width={20}
                  />
                  {activeFilterLabel ? (
                    <View
                      style={[styles.filterDot, { backgroundColor: theme.colors.purple500 }]}
                      testID="game-sets-filter-active"
                    />
                  ) : null}
                </IconButton>
              )}
            </View>
          ) : (
            <SearchField
              ref={searchFieldRef}
              autoCapitalize="none"
              autoCorrect={false}
              containerStyle={{ backgroundColor: theme.colors.gray0 }}
              onChangeText={search.setQuery}
              placeholder="Search card"
              returnKeyType="search"
              testID="game-sets-search"
              uppercasePlaceholder
              value={search.query}
            />
          )}
          {isSearch ? null : renderGameChips()}
        </View>
        {isSearch ? (
          // Underline + hairline rail, left on the 16 gutter (Figma 6642:12483).
          <View style={styles.searchTabs}>
            <PageTabs
              onChange={(next) => {
                if (next === searchTab) {
                  return;
                }
                // The text follows you across: "gengar" on CARDS is "gengar" on PEOPLE.
                if (next === 'people') {
                  setPeopleQuery(search.query);
                  setPeopleVisited(true);
                } else {
                  search.setQuery(peopleQuery);
                }
                setSearchTab(next);
              }}
              tabs={SEARCH_TABS}
              testID="search-tabs"
              uppercase
              value={searchTab}
              variant="underline"
            />
          </View>
        ) : null}
        {isSearch ? null : search.hasActiveQuery ? renderSearchState() : renderSetsState()}
      </View>
      {isSearch && !onPeopleTab ? (
        // CARDS only searches cards: the game chips sit under the tabs (Figma 6642:12697).
        <View style={styles.searchBodyHeader}>
          {renderGameChips()}
          {search.hasActiveQuery ? renderSearchState() : renderSetsState()}
        </View>
      ) : null}
      {body()}
      {isSearch ? (
        <CatalogSearchFilterSheet
          activeFilter={filter.activeFilter}
          onApply={(next) => {
            filter.setActiveFilter(next);
            setFilterSheetOpen(false);
          }}
          onClose={() => setFilterSheetOpen(false)}
          testID="search-filter-sheet"
          visible={filterSheetOpen}
        />
      ) : null}
    </View>
    </PullDownToDismiss>
  );
}

const styles = StyleSheet.create({
  body: {
    flex: 1,
  },
  chipScroller: {
    // Full-bleed: the chip row scrolls under the page gutter.
    marginHorizontal: -layout.pageGutter,
  },
  chips: {
    gap: 10,
    paddingHorizontal: layout.pageGutter,
  },
  filterButton: {
    borderColor: 'transparent',
  },
  filterDot: {
    borderCurve: 'continuous',
    borderRadius: radii.pill,
    height: 6,
    position: 'absolute',
    right: 6,
    top: 6,
    width: 6,
  },
  hidden: {
    display: 'none',
  },
  // Figma 6642:12697 / 12517: chips 16 under the tabs, the body 16 under the chips.
  searchBodyHeader: {
    paddingHorizontal: layout.pageGutter,
    paddingTop: spacing.sm,
  },
  // Search: the tabs ARE the banner's bottom edge (Figma 6642:12721 at y238 of 264).
  searchHeader: {
    paddingBottom: 0,
  },
  searchLandingContent: {
    paddingTop: spacing.sm,
  },
  searchFieldBox: {
    borderWidth: 0,
  },
  searchFieldSlot: {
    flex: 1,
  },
  searchRow: {
    flexDirection: 'row',
    gap: spacing.xxs,
  },
  // 32 from the field to the tab labels (Figma 6642:12675 → 6642:12721); full-bleed hairline.
  searchTabs: {
    marginHorizontal: -layout.pageGutter,
    marginTop: spacing.xxl,
  },
  toolbarSpacer: {
    height: glassNavBubbleSizes.medium,
  },
  // Figma 6597:5677: 24 under the toolbar (its 10 bottom pad + 14), 10 between rows.
  controls: {
    gap: 10,
    marginTop: spacing.lg,
  },
  // The list's own gap sits under the heading; extra air above separates eras.
  eraHeader: {
    marginTop: spacing.sm,
  },
  header: {
    paddingBottom: spacing.sm,
    paddingHorizontal: layout.pageGutter,
  },
  bodyState: {
    marginHorizontal: layout.pageGutter,
  },
  // With the header's 16 bottom pad, 40 from the chips to SINGLES (Figma 6597:5688).
  landingContent: {
    gap: spacing.xxxl,
    paddingHorizontal: layout.pageGutter,
    paddingTop: spacing.lg,
  },
  listContent: {
    gap: spacing.sm,
    paddingHorizontal: layout.pageGutter,
  },
  // Full-bleed: tiles scroll under the page gutter.
  rail: {
    marginHorizontal: -layout.pageGutter,
  },
  railContent: {
    gap: spacing.xs,
    paddingHorizontal: layout.pageGutter,
  },
  section: {
    gap: spacing.xs,
  },
  // Figma 6597:5712: the set list sits 8 apart, header included.
  setsSection: {
    gap: spacing.xxs,
  },
  screen: {
    flex: 1,
  },
  stateCard: {
    gap: spacing.sm,
    marginTop: spacing.sm,
    paddingVertical: spacing.lg,
  },
  toolbar: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  wash: {
    left: 0,
    overflow: 'hidden',
    position: 'absolute',
    top: 0,
  },
});
