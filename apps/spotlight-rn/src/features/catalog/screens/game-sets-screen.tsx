import { useRouter } from 'expo-router';
import { Bell, NavArrowLeft, Xmark } from 'iconoir-react-native';
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
  InlineLoader,
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
  spacing,
  useSpotlightTheme,
} from '@spotlight/design-system';

import type { UserProfile } from '@/features/auth/auth-models';
import { AskEkalightRow } from '@/features/catalog/components/ask-ekalight-row';
import { CatalogResultsGrid } from '@/features/catalog/components/catalog-results-grid';
import { SealedResultsSection } from '@/features/catalog/components/sealed-results-section';
import { SearchRailTile } from '@/features/catalog/components/search-rail-tile';
import { BadgedBubble } from '@/components/home-header';
import { SearchPersonRow } from '@/features/catalog/components/search-person-row';
import { SearchSectionHeader } from '@/features/catalog/components/search-section-header';
import { SearchSetCard } from '@/features/catalog/components/search-set-card';
import { SmartSearchChips } from '@/features/catalog/components/smart-search-chips';
import { useCatalogCardSearch, type CatalogSearchScope } from '@/features/catalog/hooks/use-catalog-card-search';
import { useSmartCatalogSearch } from '@/features/catalog/hooks/use-smart-catalog-search';
import { useSealedSearchPreview } from '@/features/catalog/hooks/use-sealed-search-preview';
import { GAME_EXPANSIONS_ERROR, useGameExpansions } from '@/features/catalog/hooks/use-game-expansions';
import { useSealedRail, useSinglesRail } from '@/features/catalog/hooks/use-search-landing-previews';
import { useSetProgress } from '@/features/catalog/hooks/use-set-progress';
import { resultsCountLabel, singlesSourceSets, totalCardCount } from '@/features/catalog/search-landing';
import { groupSetsByEra, setCompletion, sortNewestFirst, type SetListRow } from '@/features/catalog/set-progress';
import { PeopleSearchResults } from '@/features/profile/components/people-search-results';
import { usePeopleSearch } from '@/features/profile/hooks/use-people-search';
import { EventsPage } from '@/features/events/screens/events-screen';
import type { CollapsiblePageProps } from '@/components/page-tab-pager';
import { AssistantChatPill } from '@/features/assistant/components/assistant-chat-pill';
import { useAssistantPageContext } from '@/features/assistant/page-context/assistant-page-context';
import { useGuestGate } from '@/features/auth/use-guest-gate';
import type { PeopleRelation } from '@/features/profile/hooks/use-follow-people';
import { useUnreadNotificationCount } from '@/features/social/use-unread-notification-count';
import { AnalyticsEvent } from '@/lib/observability/analytics-events';
import { capturePostHogEvent } from '@/lib/observability/posthog';
import { useAuth } from '@/providers/auth-provider';

type GameSetsScreenProps = {
  /** The game the chips start on. The chips switch games in place. */
  game: CardGame;
  onClose: () => void;
  onSelectExpansion: (expansion: ExpansionRecord, game: CardGame) => void;
  onOpenCard: (result: CatalogSearchResult) => void;
  /** Ask Ekalight (the sparkle). Absent hides the button rather than leaving it dead. */
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
  /** VIEW ALL on SETS / SEALED. Absent hides those two links. `all` = every game (the ALL chip). */
  onViewAll?: (section: 'sets' | 'sealed', game: CardGame | 'all') => void;
  /** Open on the ALL scope (every game) — VIEW ALL from Search while ALL is selected. */
  allGamesScope?: boolean;
  /**
   * Present = this is SEARCH (Figma 6725:9509): a white header with CARDS |
   * PEOPLE tabs, the field (+ filter on CARDS) and a chip row under it — game
   * chips on CARDS, ALL / FOLLOWERS / FOLLOWING on PEOPLE. No banner or title.
   * `tab` = the bottom-bar Search tab: the Chat pill and the bell in the toolbar.
   * `sheet` = the /catalog/search sheet: its close (X) in the Chat pill's slot.
   */
  searchMode?: SearchMode;
  /** PEOPLE: a person's header or bio was tapped. */
  onOpenProfile?: (profile: UserProfile) => void;
  /** PEOPLE: one of a person's most valuable cards was tapped. */
  onOpenHolding?: (profile: UserProfile, entry: InventoryCardEntry) => void;
  /** Search tab to open on (dev screens / deep links); CARDS by default. */
  initialSearchTab?: SearchTab;
  /** A question typed into CARDS: open the chat with it sent. Absent hides the Ask row. */
  onAskAssistant?: (question: string, game: CardGame | null) => void;
};

export type GameSetsView = 'landing' | 'sets' | 'sealed';
export type SearchMode = 'tab' | 'sheet';
export type SearchTab = 'cards' | 'people' | 'events';
/** Figma 6711:4679: CARDS | COLLECTORS | EVENTS (COLLECTORS is the people search). */
const SEARCH_TABS = [
  { label: 'Cards', value: 'cards' },
  { label: 'Collectors', value: 'people' },
  { label: 'Events', value: 'events' },
] as const;
/** Figma 6722:8526. */
const CARDS_SEARCH_PLACEHOLDER = 'Search by cards, sets, people';
/** Figma 6725:9756. */
const PEOPLE_SEARCH_PLACEHOLDER = 'Search by name, profile';
/** Figma 6725:9757: ALL / FOLLOWERS / FOLLOWING, equal widths. */
const PEOPLE_RELATIONS: readonly { label: string; value: PeopleRelation }[] = [
  { label: 'All', value: 'all' },
  { label: 'Followers', value: 'followers' },
  { label: 'Following', value: 'following' },
];

/** Sealed matches under the card results: a section, not another paged list. */
const SEALED_RESULTS_LIMIT = 20;

// Figma 6597:5655 header: a 393×264 wash over the banner, which is drawn at
// its own ratio (786×646) from the top and clipped at the wash's bottom.
const FIGMA_FRAME_WIDTH = 393;
const WASH_FIGMA_HEIGHT = 264;
const BANNER_ASPECT = 786 / 646;
const SETS_BANNER = require('../../../../assets/images/catalog/sets-banner.jpg');
/** A typed CARDS search leads with this many collectors and sets; VIEW ALL shows the rest. */
const MIXED_PREVIEW_COUNT = 3;

/** Case, accents, punctuation and spacing ignored: "obsidian-flames" finds "Obsidian Flames". */
function normalizeForMatch(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

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
  dismissStyle = 'back',
  view = 'landing',
  onViewAll,
  allGamesScope = false,
  searchMode,
  onOpenProfile,
  onOpenHolding,
  initialSearchTab = 'cards',
  onAskAssistant,
}: GameSetsScreenProps) {
  const theme = useSpotlightTheme();
  const isSearch = searchMode != null && view === 'landing';
  const isTabMode = isSearch && searchMode === 'tab';
  const auth = useAuth();
  const viewerId = auth.currentUser?.id ?? null;
  // FOLLOWERS / FOLLOWING are the viewer's own lists: a guest has none.
  const showsPeopleRelations = viewerId != null && !auth.isGuest;
  const [peopleRelationChoice, setPeopleRelation] = useState<PeopleRelation>('all');
  const peopleRelation = showsPeopleRelations ? peopleRelationChoice : 'all';
  const [searchTab, setSearchTab] = useState<SearchTab>(initialSearchTab);
  const onPeopleTab = isSearch && searchTab === 'people';
  const onEventsTab = isSearch && searchTab === 'events';
  // EVENTS mounts on first visit, then stays (like PEOPLE).
  const [eventsVisited, setEventsVisited] = useState(initialSearchTab === 'events');
  const eventsPage = useMemo<CollapsiblePageProps>(
    () => ({
      contentContainerStyle: { minHeight: 0, paddingTop: 0 },
      onScroll: () => undefined,
      progressViewOffset: 0,
      scrollEventThrottle: 16,
      scrollToOverflowEnabled: false,
    }),
    [],
  );
  // The PEOPLE list (and its suggestions read) mounts on first visit, then stays.
  const [peopleVisited, setPeopleVisited] = useState(initialSearchTab === 'people');
  const [peopleQuery, setPeopleQuery] = useState('');
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  const washHeight = Math.round((windowWidth * WASH_FIGMA_HEIGHT) / FIGMA_FRAME_WIDTH);
  // Search opens on ALL (Figma 6711:4679): every game at once. A game page keeps its game.
  const [scope, setScope] = useState<CatalogSearchScope>(isSearch || allGamesScope ? 'all' : initialGame);
  // The ALL chip leads the game row on Search and on pages opened from it under ALL.
  const showsAllChip = isSearch || allGamesScope;
  const allGames = scope === 'all';
  // The game for game-only surfaces (VIEW ALL routes, copy); ALL never reaches them.
  const game: CardGame = allGames ? initialGame : scope;
  const { byGame, error, failedGames, games, hasLoaded, isLoading, reload } = useGameExpansions();
  const { ownedByExpansion } = useSetProgress(allGames ? games : game);
  const search = useCatalogCardSearch({ scope });
  // Sentence-like queries ("eevee alt arts under $50"); a rarity/Sealed filter keeps the plain path.
  const smart = useSmartCatalogSearch({
    enabled: isSearch && !onPeopleTab && !onEventsTab,
    query: search.query,
    scope,
  });
  // Floating Ekalight bubble: the game chip, typed query, and CARDS|PEOPLE tab (read at tap time).
  useAssistantPageContext(() => ({
    kind: 'search',
    game: allGames ? null : game,
    params: {
      query: search.query,
      tab: isSearch ? searchTab : 'cards',
    },
    label: search.query.trim() ? `Search: ${search.query.trim()}` : null,
  }));
  const sealedSearch = useSealedSearchPreview({
    enabled: true,
    limit: SEALED_RESULTS_LIMIT,
    query: search.query,
    scope,
  });
  // VIEW ALL on SEALED: every sealed product of the game, paged (the Sealed chip's browse).
  const sealedBrowse = useCatalogCardSearch({ scope: allGames ? 'all' : game, sealed: view === 'sealed' });
  // Bottom of the list = after the LAST card page, so it waits for paging.
  const sealedResults = search.hasMore ? [] : sealedSearch.results;
  // A smart search's results stand in for the normal ones (no sealed footer: the filter is cards).
  const cardResults = smart.isActive ? smart.results : search.results;
  const footerSealed = smart.isActive ? [] : sealedResults;
  // Blurred when a result opens, so no focus survives to be restored when the
  // card page pops back to this screen.
  const searchFieldRef = useRef<TextInput>(null);
  const [openingResultId, setOpeningResultId] = useState<string | null>(null);

  // The backend returns `release_date DESC NULLS LAST, name ASC` — newest first;
  // grouping keeps that order inside each era.
  // ALL: every game's sets, newest first (eras are per game, so no era headers).
  const expansions = useMemo(
    () => (allGames ? sortNewestFirst(games.flatMap((each) => byGame[each] ?? [])) : byGame[game] ?? []),
    [allGames, byGame, game, games],
  );
  const gameBySet = useMemo(() => {
    const map: Record<string, CardGame> = {};
    for (const each of games) {
      for (const expansion of byGame[each] ?? []) {
        map[expansion.id] = each;
      }
    }
    return map;
  }, [byGame, games]);
  const gameOf = (expansion: ExpansionRecord) => gameBySet[expansion.id] ?? game;
  const rows = useMemo<SetListRow[]>(
    () =>
      allGames
        ? expansions.map((expansion) => ({ kind: 'set', key: expansion.id, expansion }))
        : groupSetsByEra(expansions),
    [allGames, expansions],
  );
  // Sets in list order (era'd: newest era first, promos after its mains).
  const orderedSets = useMemo(
    () => rows.flatMap((row) => (row.kind === 'set' ? [row.expansion] : [])),
    [rows],
  );
  // A typed CARDS search also finds COLLECTORS and SETS (owner, 2026-11-24),
  // shown above the cards. Not for a smart (sentence) search: that is a card filter.
  const mixedEnabled = isSearch && search.hasActiveQuery && !smart.isActive && !smart.isLoading;
  const [setsExpanded, setSetsExpanded] = useState(false);
  useEffect(() => setSetsExpanded(false), [search.query, scope]);
  const matchingSets = useMemo(() => {
    const needle = normalizeForMatch(search.query.trim());
    if (!mixedEnabled || needle.length < 2) {
      return [];
    }
    return orderedSets.filter((expansion) => normalizeForMatch(expansion.name).includes(needle));
  }, [mixedEnabled, orderedSets, search.query]);
  const mixedPeople = usePeopleSearch(search.query, { enabled: mixedEnabled, viewerId });
  const matchingPeople = mixedEnabled ? mixedPeople.results : [];
  const hasMixedMatches = matchingSets.length > 0 || matchingPeople.length > 0;
  const isLanding = view === 'landing';
  const singlesSources = useMemo(
    () => (isLanding ? singlesSourceSets(orderedSets) : []),
    [isLanding, orderedSets],
  );
  const singles = useSinglesRail(game, singlesSources, allGames ? gameBySet : undefined);
  const sealedRail = useSealedRail(scope, isLanding);
  // The route's game stays a chip even before its sets load, so the row never
  // jumps under the selected chip.
  const chipGames = games.includes(game) ? games : [game, ...games];

  // Slid up (Search's landing): swipe down anywhere closes it once the list is at the top.
  const pullDown = usePullDownToDismiss({ enabled: dismissStyle === 'close', onDismiss: onClose });
  const showsResults =
    search.hasActiveQuery
    && !smart.isLoading
    && (smart.isActive || !search.errorMessage)
    && (cardResults.length > 0 || footerSealed.length > 0 || hasMixedMatches);
  const { resetScroll } = pullDown;
  // Switching lists mounts a fresh one at the top.
  useEffect(() => {
    resetScroll();
  }, [resetScroll, searchTab, showsResults, view]);

  const openResult = useCallback(
    (result: CatalogSearchResult) => {
      const isSealed = result.productKind === 'sealed';
      capturePostHogEvent('catalog_search_result_opened', {
        is_sealed: isSealed,
        result_count: isSealed ? footerSealed.length : cardResults.length,
        scope,
      });
      searchFieldRef.current?.blur();
      Keyboard.dismiss();
      setOpeningResultId(result.id);
      onOpenCard(result);
    },
    [cardResults.length, footerSealed.length, onOpenCard, scope],
  );

  const askAssistant = useCallback(() => {
    const question = search.query.trim();
    if (!question || !onAskAssistant) {
      return;
    }
    capturePostHogEvent(AnalyticsEvent.smartSearchAskTapped, { scope });
    searchFieldRef.current?.blur();
    Keyboard.dismiss();
    onAskAssistant(question, allGames ? null : game);
  }, [allGames, game, onAskAssistant, scope, search.query]);

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
    const setsError = error || ((allGames ? failedGames.length > 0 : failedGames.includes(game)) && expansions.length === 0 ? GAME_EXPANSIONS_ERROR : '');
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
    // Light and inline: the interpretation is usually back in about a second.
    if (smart.isLoading) {
      return <InlineLoader style={styles.inlineLoader} testID="game-sets-smart-loading" />;
    }
    if (smart.isActive) {
      return smart.results.length === 0 ? (
        <StateCard
          centered
          message="Nothing matched all of those. Remove a filter to widen the search."
          style={styles.stateCard}
          testID="game-sets-smart-empty"
          title="No matching cards"
        />
      ) : null;
    }
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
      if (sealedResults.length > 0 || hasMixedMatches) {
        // No cards, but sealed / collector / set matches: those stand in.
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
          message={`Nothing${allGames ? '' : ` in ${gameDisplayName(game)}`} matched. Try a shorter query or just the collector number.`}
          style={styles.stateCard}
          title="No matching cards"
        />
      );
    }
    return null;
  };

  const body = () => {
    if (!isSearch) {
      return cardsBody();
    }
    // COLLECTORS and EVENTS stay mounted once visited (hidden elsewhere), so
    // their lists and what they read survive a tab flip.
    return (
      <>
        {eventsVisited ? (
          <View style={[styles.body, onEventsTab ? null : styles.hidden]} testID="search-events">
            <EventsPage page={eventsPage} />
          </View>
        ) : null}
        {peopleVisited ? (
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
              relation={peopleRelation}
              scrollProps={pullDown.scrollProps}
              testID="search-people"
              viewerId={viewerId}
            />
          </GestureDetector>
        </View>
        ) : null}
        {onPeopleTab || onEventsTab ? null : cardsBody()}
      </>
    );
  };

  const selectSearchTab = (next: SearchTab) => {
    if (next === searchTab) {
      return;
    }
    // The text follows you across: "gengar" on CARDS is "gengar" on COLLECTORS.
    if (next === 'people' && searchTab === 'cards') {
      setPeopleQuery(search.query);
    } else if (next === 'cards' && searchTab === 'people') {
      search.setQuery(peopleQuery);
    }
    if (next === 'people') {
      setPeopleVisited(true);
    } else if (next === 'events') {
      Keyboard.dismiss();
      setEventsVisited(true);
    }
    setSearchTab(next);
  };

  // COLLECTORS and SETS that match the typed query, above the card grid.
  const renderMixedSections = () => {
    if (!hasMixedMatches) {
      return null;
    }
    const shownSets = setsExpanded ? matchingSets : matchingSets.slice(0, MIXED_PREVIEW_COUNT);
    return (
      <View style={styles.mixedSections} testID="game-sets-mixed">
        {matchingPeople.length > 0 ? (
          <View style={styles.setsSection}>
            <SearchSectionHeader
              onViewAll={() => selectSearchTab('people')}
              testID="game-sets-mixed-people-header"
              title="COLLECTORS"
            />
            {matchingPeople.slice(0, MIXED_PREVIEW_COUNT).map((profile) => (
              <SearchPersonRow
                key={profile.userID}
                onPress={(picked) => {
                  searchFieldRef.current?.blur();
                  Keyboard.dismiss();
                  onOpenProfile?.(picked);
                }}
                profile={profile}
                testID={`game-sets-mixed-person-${profile.userID}`}
              />
            ))}
          </View>
        ) : null}
        {matchingSets.length > 0 ? (
          <View style={styles.setsSection}>
            <SearchSectionHeader
              countLabel={resultsCountLabel(matchingSets.length)}
              onViewAll={
                matchingSets.length > MIXED_PREVIEW_COUNT && !setsExpanded ? () => setSetsExpanded(true) : undefined
              }
              testID="game-sets-mixed-sets-header"
              title="SETS"
            />
            {shownSets.map(renderSetCard)}
          </View>
        ) : null}
        {cardResults.length > 0 ? (
          <SearchSectionHeader testID="game-sets-mixed-cards-header" title="CARDS" />
        ) : null}
      </View>
    );
  };

  const cardsBody = () => {
    if (search.hasActiveQuery) {
      if (!showsResults) {
        return null;
      }
      return (
        <GestureDetector gesture={pullDown.scrollGesture}>
        <CatalogResultsGrid
          header={renderMixedSections()}
          footer={(
            <SealedResultsSection
              onOpenResult={openResult}
              openingResultId={openingResultId}
              results={footerSealed}
              testID="game-sets-sealed"
            />
          )}
          isLoadingMore={smart.isActive ? smart.isLoadingMore : search.isLoadingMore}
          onEndReached={smart.isActive ? smart.loadMore : search.loadMore}
          onOpenResult={openResult}
          openingResultId={openingResultId}
          results={cardResults}
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
      onPress={() => onSelectExpansion(expansion, gameOf(expansion))}
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
          message={allGames ? 'No sealed products yet.' : `No sealed products for ${gameDisplayName(game)} yet.`}
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
      {showsAllChip ? (
        // Figma 6722:8531: ALL leads the row on Search.
        <PillButton
          label="All"
          labelRole="caption"
          onPress={() => setScope('all')}
          selected={allGames}
          testID="game-sets-game-all"
          tone="filled"
          uppercase
        />
      ) : null}
      {chipGames.map((chipGame) => (
        <PillButton
          key={chipGame}
          label={gameDisplayName(chipGame)}
          labelRole="caption"
          onPress={() => setScope(chipGame)}
          selected={chipGame === scope}
          testID={`game-sets-game-${chipGame}`}
          // Figma's "Secondary" chip, the same one News / Market Watch use. On
          // Search's white header the gray-50 resting fill vanishes, so it takes
          // the gray-100 one (the PEOPLE chips' fill, Figma 6725:9760).
          tone={isSearch ? 'filled' : 'secondary'}
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
                onViewAll={singlesSet ? () => onSelectExpansion(singlesSet, gameOf(singlesSet)) : undefined}
                testID="game-sets-singles-header"
                title="SINGLES"
              />
              {renderRail(singles.results, 'game-sets-singles')}
            </View>
          ) : null}
          {sealedRail.results.length > 0 ? (
            <View style={styles.section}>
              <SearchSectionHeader
                onViewAll={onViewAll ? () => onViewAll('sealed', allGames ? 'all' : game) : undefined}
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
                onViewAll={onViewAll ? () => onViewAll('sets', allGames ? 'all' : game) : undefined}
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

  const closeBubble = (
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
  );

  const renderPeopleRelations = () => (
    <View style={styles.peopleRelations} testID="search-people-relations">
      {PEOPLE_RELATIONS.map((option) => (
        <PillButton
          key={option.value}
          label={option.label}
          labelRole="caption"
          onPress={() => setPeopleRelation(option.value)}
          selected={peopleRelation === option.value}
          style={styles.peopleRelation}
          testID={`search-people-relation-${option.value}`}
          tone="filled"
          uppercase
        />
      ))}
    </View>
  );

  // Search (Figma 6725:9509): a white header — toolbar, CARDS | PEOPLE, the
  // field and its chip row — over the gray-50 page. The field keeps one place
  // in this tree whatever the tab, so it never remounts mid-word.
  const renderSearchHeader = () => (
    <View
      style={[styles.searchHeader, { backgroundColor: theme.colors.gray0, paddingTop: insets.top }]}
      testID="game-sets-search-header"
    >
      <View style={styles.searchToolbar}>
        {isTabMode ? <AssistantChatPill testID="game-sets-chat-pill" /> : closeBubble}
        {isTabMode ? <SearchNotificationsBell testID="game-sets-notifications" /> : null}
      </View>
      <PageTabs
        onChange={selectSearchTab}
        tabs={SEARCH_TABS}
        testID="search-tabs"
        uppercase
        value={searchTab}
        variant="underline"
      />
      {onEventsTab ? null : (
      <View style={styles.searchControls}>
        {/* Figma 6722:8523: a full-width 40pt gray-100 field. */}
        <View style={styles.searchRow}>
          <View style={styles.searchFieldSlot}>
            <SearchField
              ref={searchFieldRef}
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={onPeopleTab ? setPeopleQuery : search.setQuery}
              onSubmitEditing={onPeopleTab ? undefined : smart.submit}
              placeholder={onPeopleTab ? PEOPLE_SEARCH_PLACEHOLDER : CARDS_SEARCH_PLACEHOLDER}
              returnKeyType="search"
              size="collection"
              surface="muted"
              testID="game-sets-search"
              uppercasePlaceholder
              value={onPeopleTab ? peopleQuery : search.query}
            />
          </View>
        </View>
        {/* CARDS only searches cards: its game chips sit under the field. */}
        {onPeopleTab ? (showsPeopleRelations ? renderPeopleRelations() : null) : renderGameChips()}
      </View>
      )}
    </View>
  );

  if (isSearch) {
    return (
      <PullDownToDismiss controller={pullDown} testID="game-sets-pull-down">
      <View style={[styles.screen, { backgroundColor: theme.colors.gray50 }]}>
        {renderSearchHeader()}
        {onPeopleTab || onEventsTab ? null : (
          <View style={styles.searchBodyHeader}>
            {smart.isActive ? (
              <SmartSearchChips chips={smart.chips} onRemove={smart.removeChip} testID="game-sets-smart-chips" />
            ) : null}
            {smart.isQuestion && onAskAssistant ? (
              <AskEkalightRow onPress={askAssistant} question={search.query.trim()} testID="game-sets-ask-ekalight" />
            ) : null}
            {search.hasActiveQuery ? renderSearchState() : renderSetsState()}
          </View>
        )}
        {body()}
      </View>
      </PullDownToDismiss>
    );
  }

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

      <View style={[styles.header, { paddingTop: insets.top }]}>
        <View style={styles.toolbar}>{closeBubble}</View>
        <View style={styles.controls}>
          <Text style={[theme.typography.titleLarge, { color: theme.colors.gray0 }]}>
            {gameDisplayName(game)}
          </Text>
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
          {renderGameChips()}
        </View>
        {search.hasActiveQuery ? renderSearchState() : renderSetsState()}
      </View>
      {body()}
    </View>
    </PullDownToDismiss>
  );
}

/**
 * The Search tab's bell (Figma 6725:9525): a 44pt frost bubble with the unread
 * badge Social's header hangs off its bell. A guest has no notifications, so
 * it opens sign-in instead (as Social's guest header does).
 */
function SearchNotificationsBell({ testID }: { testID: string }) {
  const theme = useSpotlightTheme();
  const router = useRouter();
  const { isGuest, openLogin } = useGuestGate();
  const unread = useUnreadNotificationCount();
  const count = isGuest ? 0 : unread;
  return (
    <BadgedBubble
      accessibilityLabel={count > 0 ? `Notifications, ${count} unread` : 'Notifications'}
      badgeColor={theme.colors.dangerStrong}
      count={count}
      onPress={isGuest ? openLogin : () => router.push('/notifications' as never)}
      testID={testID}
    >
      <Bell
        color={theme.colors.gray900}
        height={glassNavBubbleGlyphSize}
        strokeWidth={glassNavBubbleGlyphStrokeWidth}
        width={glassNavBubbleGlyphSize}
      />
    </BadgedBubble>
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
  hidden: {
    display: 'none',
  },
  // Figma 6725:9758: three equal 32pt chips, 8 apart.
  peopleRelation: {
    flex: 1,
  },
  peopleRelations: {
    flexDirection: 'row',
    gap: spacing.xxs,
  },
  // Loading / error / empty cards for CARDS, on the page under the white header.
  inlineLoader: {
    marginTop: spacing.sm,
  },
  // Figma 6642:12697 / 12517: chips 16 under the tabs, the body 16 under the chips.
  searchBodyHeader: {
    paddingHorizontal: layout.pageGutter,
  },
  // Figma 6725:9752: the field 16 under the tab rail, its chips 8 under it, 16 to the header's edge.
  searchControls: {
    gap: spacing.xxs,
    paddingBottom: spacing.sm,
    paddingHorizontal: layout.pageGutter,
    paddingTop: spacing.sm,
  },
  searchHeader: {
    width: '100%',
  },
  searchLandingContent: {
    paddingTop: spacing.sm,
  },
  searchFieldSlot: {
    flex: 1,
  },
  searchRow: {
    flexDirection: 'row',
    gap: spacing.xxs,
  },
  // Figma 6725:9521: a 44pt row on the 16 gutter (Chat pill left, bell right);
  // its 10 bottom pad + 14 put the tab labels 24 under it (6725:9529 at y127).
  searchToolbar: {
    alignItems: 'center',
    flexDirection: 'row',
    height: glassNavBubbleSizes.medium,
    justifyContent: 'space-between',
    marginBottom: spacing.lg,
    paddingHorizontal: layout.pageGutter,
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
  // Collectors, then sets, then the CARDS heading over the grid.
  mixedSections: {
    gap: spacing.lg,
    paddingTop: spacing.xs,
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
