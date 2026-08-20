import {
  type CardGame,
  DEFAULT_CARD_GAME,
  gameHasGradedData,
  graderOptions,
  gradersForGame,
} from '@spotlight/api-client';

/**
 * Which grading lanes a card may offer is decided by its GAME, not by whether a
 * particular card happens to have graded prices today.
 *
 * Probing Scrydex on 2026-08-13 found no graded prices and empty pop_reports for
 * One Piece across the newest set (OP16) and the oldest (OP01), plus a
 * single-card read and a PSA-10 price-history query. Our population source
 * (GemRate via PokemonPriceTracker) is Pokémon-only too. So a PSA/BGS/CGC chip
 * on a One Piece card would be a control leading to a permanently empty chart.
 */
describe('graded data availability by game', () => {
  it('treats Pokémon as having graded data', () => {
    expect(gameHasGradedData('pokemon')).toBe(true);
  });

  it('treats One Piece as having NO graded data', () => {
    expect(gameHasGradedData('onepiece')).toBe(false);
  });

  it('treats an absent game as Pokémon, not as unknown', () => {
    // Payloads from a backend that predates multi-game carry no `game`. Reading
    // that as "unknown" and hiding the graded lanes would strip PSA pricing from
    // every Pokémon card the moment an older backend served the request.
    expect(gameHasGradedData(undefined)).toBe(true);
    expect(DEFAULT_CARD_GAME).toBe('pokemon');
  });

  it('offers grader lanes only where graded data exists', () => {
    // Mirrors what card-detail-screen derives for its configurator + add sheet.
    // Note it reads `gradersForGame`, NOT the `graderOptions` constant: that
    // constant is the POKÉMON list, and a game's lanes are its own (Lorcana's
    // span eight companies). See game-capabilities-test for the full ladders.
    const gradersFor = (game: CardGame | undefined) => [...gradersForGame(game)];

    expect(gradersFor('pokemon')).toEqual([...graderOptions]);
    expect(gradersFor(undefined)).toEqual([...graderOptions]);
    // Raw stays, so the card is still addable to a collection — it just can't
    // claim a grade.
    expect(gradersFor('onepiece')).toEqual(['Raw']);
  });
});
