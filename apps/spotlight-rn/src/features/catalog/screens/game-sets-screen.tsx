import { NavArrowLeft, Xmark } from 'iconoir-react-native';
import { useCallback, useMemo, useRef, useState } from 'react';
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
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { EkalightAiRing, EkalightAiSparkle } from '@/components/ekalight-ai-glyph';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import {
  gameDisplayName,
  type CardGame,
  type CatalogSearchResult,
  type ExpansionRecord,
} from '@spotlight/api-client';
import {
  GlassNavBubble,
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

import { CatalogResultsGrid } from '@/features/catalog/components/catalog-results-grid';
import { SealedResultsSection } from '@/features/catalog/components/sealed-results-section';
import { SetProgressCard } from '@/features/catalog/components/set-progress-card';
import { useCatalogCardSearch } from '@/features/catalog/hooks/use-catalog-card-search';
import { useSealedSearchPreview } from '@/features/catalog/hooks/use-sealed-search-preview';
import { useGameExpansions } from '@/features/catalog/hooks/use-game-expansions';
import { useSetProgress } from '@/features/catalog/hooks/use-set-progress';
import { groupSetsByEra, setCompletion, type SetListRow } from '@/features/catalog/set-progress';
import { capturePostHogEvent } from '@/lib/observability/posthog';

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
};

/** Sealed matches under the card results: a section, not another paged list. */
const SEALED_RESULTS_LIMIT = 20;

// Figma 6552:1914 header wash height.
const WASH_HEIGHT = 323;
const SETS_BANNER = require('../../../../assets/images/catalog/sets-banner.jpg');

/**
 * Sets list with set progress (Figma 6552:1913): the title is the game, GAME
 * CHIPS switch games in place, and every set of that game is a card — logo,
 * name, release date, a progress bar, "X of Y CARDS" and the percent —
 * newest first, 0% sets included.
 *
 * GROUPED BY ERA when the backend sends one (Pokémon: "MEGA EVOLUTION",
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
}: GameSetsScreenProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  const [game, setGame] = useState<CardGame>(initialGame);
  const { byGame, error, games, hasLoaded, isLoading } = useGameExpansions();
  const { ownedByExpansion } = useSetProgress(game);
  const search = useCatalogCardSearch({ scope: game });
  const sealedSearch = useSealedSearchPreview({
    enabled: true,
    limit: SEALED_RESULTS_LIMIT,
    query: search.query,
    scope: game,
  });
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
  // The route's game stays a chip even before its sets load, so the row never
  // jumps under the selected chip.
  const chipGames = games.includes(game) ? games : [game, ...games];

  const openResult = useCallback(
    (result: CatalogSearchResult) => {
      const isSealed = result.productKind === 'sealed';
      capturePostHogEvent('catalog_search_result_opened', {
        has_rarity_filter: false,
        is_sealed: isSealed,
        result_count: isSealed ? sealedResults.length : search.results.length,
        scope: game,
      });
      searchFieldRef.current?.blur();
      Keyboard.dismiss();
      setOpeningResultId(result.id);
      onOpenCard(result);
    },
    [game, onOpenCard, sealedResults.length, search.results.length],
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
    if (error) {
      return <StateCard centered message={error} style={styles.stateCard} title="Could not load sets" />;
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
    if (search.hasActiveQuery) {
      if (search.errorMessage || (search.results.length === 0 && sealedResults.length === 0)) {
        return null;
      }
      return (
        <CatalogResultsGrid
          footer={(
            <SealedResultsSection
              onOpenResult={openResult}
              openingResultId={openingResultId}
              results={sealedResults}
              testID="game-sets-sealed"
            />
          )}
          isLoadingMore={search.isLoadingMore}
          onEndReached={search.loadMore}
          onOpenResult={openResult}
          openingResultId={openingResultId}
          results={search.results}
          testID="game-sets-results"
        />
      );
    }
    return (
      <FlatList
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
            <SetProgressCard
              completion={setCompletion(row.expansion.cardCount, ownedByExpansion[row.expansion.id] ?? 0)}
              logoUrl={row.expansion.imageUrl}
              name={row.expansion.name}
              onPress={() => onSelectExpansion(row.expansion, game)}
              releaseDate={row.expansion.releaseDate}
              testID={`game-sets-expansion-${row.expansion.id}`}
            />
          )
        }
        showsVerticalScrollIndicator={false}
        style={styles.body}
        testID="game-sets-list"
      />
    );
  };

  return (
    <View style={[styles.screen, { backgroundColor: theme.colors.gray50 }]}>
      {/* Header banner (Figma 6552:1915) under its wash (6552:1916): clear at
          the top, purple at the middle, into the gray-50 page. */}
      <Image
        resizeMode="cover"
        source={SETS_BANNER}
        style={[styles.wash, { height: WASH_HEIGHT, width: windowWidth }]}
        testID="game-sets-banner"
      />
      <Svg height={WASH_HEIGHT} pointerEvents="none" style={styles.wash} width={windowWidth}>
        <Defs>
          <LinearGradient id="gameSetsWash" x1="0" x2="0" y1="0" y2="1">
            <Stop offset="0" stopColor={theme.colors.gray500} stopOpacity="0" />
            <Stop offset="0.5" stopColor={theme.colors.setsBannerWash} stopOpacity="0.8" />
            <Stop offset="1" stopColor={theme.colors.gray50} stopOpacity="1" />
          </LinearGradient>
        </Defs>
        <Rect fill="url(#gameSetsWash)" height={WASH_HEIGHT} width={windowWidth} x="0" y="0" />
      </Svg>

      <View style={[styles.header, { paddingTop: insets.top + spacing.xxs }]}>
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
              {/* Same gradient flare + ring as the Social header (Figma 6552:1913). */}
              <EkalightAiSparkle />
              <EkalightAiRing size={glassNavBubbleSizes.medium} />
            </GlassNavBubble>
          ) : null}
        </View>
        <Text style={[styles.title, theme.typography.titleLarge, { color: theme.colors.gray0 }]}>
          {gameDisplayName(game)}
        </Text>
        <View style={styles.controls}>
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
        </View>
        {search.hasActiveQuery ? renderSearchState() : renderSetsState()}
      </View>
      {body()}
    </View>
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
  controls: {
    gap: 10,
  },
  // The list's own gap sits under the heading; extra air above separates eras.
  eraHeader: {
    marginTop: spacing.sm,
  },
  header: {
    paddingBottom: spacing.sm,
    paddingHorizontal: layout.pageGutter,
  },
  listContent: {
    gap: spacing.sm,
    paddingHorizontal: layout.pageGutter,
  },
  screen: {
    flex: 1,
  },
  stateCard: {
    gap: spacing.sm,
    marginTop: spacing.sm,
    paddingVertical: spacing.lg,
  },
  title: {
    marginBottom: layout.titleBodyGap,
    marginTop: spacing.sm,
  },
  toolbar: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  wash: {
    left: 0,
    position: 'absolute',
    top: 0,
  },
});
