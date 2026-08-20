import {
  CARD_GAME_CAPABILITIES,
  CARD_GAMES,
  type CardGame,
  cardGameCapabilities,
  DEFAULT_CARD_GAME,
  ebayKeywordForGame,
  gameDisplayName,
  gameHasGradedData,
  gameHasLanguageLanes,
  gameHasListingsData,
  gradersForGame,
  marketplaceKeywordForGame,
} from '@spotlight/api-client';

/**
 * The client half of the backend's game descriptor table.
 *
 * The rule under test is not "what does One Piece have" — it is that UI code can
 * find that out by asking a CAPABILITY. A screen that compares game names has to
 * be revisited for every new game; a screen that asks "does this have listings?"
 * does not. These tests fail if the table loses a game or a field.
 */

const ALL_GAMES: CardGame[] = ['pokemon', 'onepiece', 'lorcana', 'riftbound', 'gundam'];

describe('card game capability table', () => {
  it('covers all five games', () => {
    expect(Object.keys(CARD_GAME_CAPABILITIES).sort()).toEqual([...ALL_GAMES].sort());
  });

  it('gives every game a display name and a marketplace keyword', () => {
    for (const game of ALL_GAMES) {
      const capabilities = cardGameCapabilities(game);
      expect(capabilities.displayName).toBeTruthy();
      expect(capabilities.marketplaceKeyword).toBeTruthy();
    }
  });

  it('resolves an absent game to Pokémon rather than to "unknown"', () => {
    // Payloads from a backend that predates multi-game carry no `game`. Reading
    // that as unknown would strip PSA pricing off every Pokémon card the moment
    // an older backend served the request.
    expect(cardGameCapabilities(undefined)).toBe(CARD_GAME_CAPABILITIES.pokemon);
    expect(DEFAULT_CARD_GAME).toBe('pokemon');
  });

  it('resolves a game this build has never heard of to Pokémon too', () => {
    // A newer backend can serve a game id this app predates. Same reasoning:
    // fall back to the default rather than blanking the screen.
    expect(cardGameCapabilities('kaiju' as CardGame)).toBe(CARD_GAME_CAPABILITIES.pokemon);
  });

  it('grants graded pricing to Pokémon AND Lorcana, and to nobody else', () => {
    // MEASURED against the synced catalogs, not assumed: 1,525 of 3,170 priced
    // Lorcana cards carry graded contexts (AOTV-224 has a PSA 10 Holofoil at
    // $140 market), while One Piece, Riftbound and Gundam are flatly zero. The
    // earlier assumption that only Pokémon had graded data was wrong; this test
    // is what stops it coming back.
    expect(gameHasGradedData('pokemon')).toBe(true);
    expect(gameHasGradedData('lorcana')).toBe(true);
    expect(gameHasGradedData('onepiece')).toBe(false);
    expect(gameHasGradedData('riftbound')).toBe(false);
    expect(gameHasGradedData('gundam')).toBe(false);
  });

  it('grants population data to Pokémon only, Lorcana included in the exclusion', () => {
    // Lorcana has graded PRICES but zero population rows — our population
    // source (GemRate via PokemonPriceTracker) is Pokémon-only.
    expect(cardGameCapabilities('pokemon').hasPopulationData).toBe(true);
    for (const game of ALL_GAMES.filter((id) => id !== 'pokemon')) {
      expect(cardGameCapabilities(game).hasPopulationData).toBe(false);
    }
  });

  it('proves the capability flags are separate claims, via Lorcana', () => {
    // Lorcana is why these cannot be one flag: real graded prices AND a real
    // eBay sold comp (measured 2026-08-14 via
    // tools/probe_scrydex_lorcana_listings.py), but zero population rows.
    // Collapsing them would have hung an always-empty population panel under
    // real graded lanes.
    expect(gameHasGradedData('lorcana')).toBe(true);
    expect(gameHasListingsData('lorcana')).toBe(true);
    expect(cardGameCapabilities('lorcana').hasPopulationData).toBe(false);
  });

  it('hides the recent-sales surface wherever there are no listings to show', () => {
    // Scrydex's `/onepiece/v1/cards/{id}/listings` returns ZERO rows, while the
    // same endpoint served a real eBay sold row for Lorcana (AOTV-224, probed
    // 2026-08-14 via tools/probe_scrydex_lorcana_listings.py). Riftbound and
    // Gundam are unmeasured and therefore claim nothing. Where there is nothing
    // to show, both comps panels would otherwise render empty states plus a
    // "See more on eBay" footer leading somewhere equally empty — the block
    // must be ABSENT, not empty.
    expect(gameHasListingsData('pokemon')).toBe(true);
    expect(gameHasListingsData(undefined)).toBe(true);
    expect(gameHasListingsData('lorcana')).toBe(true);
    expect(gameHasListingsData('onepiece')).toBe(false);
    expect(gameHasListingsData('riftbound')).toBe(false);
    expect(gameHasListingsData('gundam')).toBe(false);
  });

  it('gives a Japanese catalog to Pokémon only', () => {
    // Mirrors the backend descriptor's `has_language_paths`: only Pokémon is
    // served under per-language sub-paths (`/pokemon/v1/ja/cards`), and only
    // Pokémon has a Japanese catalog synced. This is what the scanner asks
    // before offering an EN/JP choice — a JP lane for a game with no Japanese
    // catalog would scan against an index that does not exist.
    expect(gameHasLanguageLanes('pokemon')).toBe(true);
    expect(gameHasLanguageLanes(undefined)).toBe(true);
    for (const game of ALL_GAMES.filter((id) => id !== 'pokemon')) {
      expect(gameHasLanguageLanes(game)).toBe(false);
    }
  });

  it('names every game for the UI so no component spells one out', () => {
    expect(gameDisplayName('pokemon')).toBe('Pokémon');
    expect(gameDisplayName('onepiece')).toBe('One Piece');
    expect(gameDisplayName('lorcana')).toBe('Disney Lorcana');
    expect(gameDisplayName('riftbound')).toBe('Riftbound');
    expect(gameDisplayName('gundam')).toBe('Gundam');
    expect(gameDisplayName(undefined)).toBe('Pokémon');
  });

  it('lists every game once, in picker order, with Pokémon first', () => {
    expect([...CARD_GAMES]).toEqual(['pokemon', 'onepiece', 'lorcana', 'riftbound', 'gundam']);
    expect([...CARD_GAMES].sort()).toEqual([...ALL_GAMES].sort());
  });

  it('keeps the helpers in step with the table they read', () => {
    for (const game of ALL_GAMES) {
      expect(gameHasGradedData(game)).toBe(cardGameCapabilities(game).hasGradedData);
      expect(gameHasListingsData(game)).toBe(cardGameCapabilities(game).hasListingsData);
      expect(gameHasLanguageLanes(game)).toBe(cardGameCapabilities(game).hasLanguageLanes);
      expect(gameDisplayName(game)).toBe(cardGameCapabilities(game).displayName);
      expect(gradersForGame(game)).toBe(cardGameCapabilities(game).graders);
    }
  });
});

describe('grader lanes by game', () => {
  it('gives Pokémon its historical four', () => {
    expect(gradersForGame('pokemon')).toEqual(['Raw', 'PSA', 'BGS', 'CGC']);
    expect(gradersForGame(undefined)).toEqual(['Raw', 'PSA', 'BGS', 'CGC']);
  });

  it('gives Lorcana the eight companies its data actually spans', () => {
    // Ordered by real coverage: PSA 1,488 cards, CGC 770, SGC 267, BGS 232,
    // TAG 202, ACE 82, AGS 11, CCIC 6. Reusing the Pokémon four here would hide
    // more than half of Lorcana's graded data behind lanes it doesn't have.
    expect(gradersForGame('lorcana')).toEqual([
      'Raw',
      'PSA',
      'CGC',
      'SGC',
      'BGS',
      'TAG',
      'ACE',
      'AGS',
      'CCIC',
    ]);
  });

  it('leaves Raw-only games with Raw', () => {
    // The card stays addable to a collection; it just cannot claim a grade.
    for (const game of ['onepiece', 'riftbound', 'gundam'] as const) {
      expect(gradersForGame(game)).toEqual(['Raw']);
    }
  });

  it('always leads with Raw, and offers lanes exactly where graded data exists', () => {
    for (const game of ALL_GAMES) {
      expect(gradersForGame(game)[0]).toBe('Raw');
      expect(gradersForGame(game).length > 1).toBe(gameHasGradedData(game));
    }
  });
});

describe('marketplace keywords by game', () => {
  it('gives each game the word a person would actually type', () => {
    expect(marketplaceKeywordForGame('pokemon')).toBe('pokemon');
    expect(marketplaceKeywordForGame('onepiece')).toBe('one piece');
    expect(marketplaceKeywordForGame('lorcana')).toBe('lorcana');
    expect(marketplaceKeywordForGame('riftbound')).toBe('riftbound');
    expect(marketplaceKeywordForGame('gundam')).toBe('gundam');
  });

  it('falls back to the Pokémon keyword for an absent game', () => {
    expect(marketplaceKeywordForGame(undefined)).toBe('pokemon');
  });

  it('adds no eBay keyword for Pokémon, and its own word for everyone else', () => {
    // eBay AND-requires every keyword, so a token is not free: Pokémon's queries
    // are tuned around not having one and vintage solds are sparse enough that
    // one more required word can zero the page.
    expect(ebayKeywordForGame('pokemon')).toBeNull();
    expect(ebayKeywordForGame(undefined)).toBeNull();
    expect(ebayKeywordForGame('onepiece')).toBe('one piece');
    expect(ebayKeywordForGame('lorcana')).toBe('lorcana');
    expect(ebayKeywordForGame('riftbound')).toBe('riftbound');
    expect(ebayKeywordForGame('gundam')).toBe('gundam');
  });
});
