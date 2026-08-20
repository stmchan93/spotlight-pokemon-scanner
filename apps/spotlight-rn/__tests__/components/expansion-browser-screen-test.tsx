import { screen, waitFor } from '@testing-library/react-native';

import { MockSpotlightRepository } from '@spotlight/api-client';

import { ExpansionBrowserScreen } from '@/features/catalog/screens/expansion-browser-screen';

import { renderWithProviders } from '../test-utils';

/**
 * The screen asks for ONE game's sets, and it takes that game as a prop rather
 * than deciding for itself. `/expansions` is scoped server-side, so a screen
 * that hardcodes Pokémon shows a One Piece lane 449 Pokémon expansions — the
 * exact bug the `expansions.game` column exists to fix.
 */

const ONE_PIECE_SETS = [
  { id: 'onepiece-OP01', name: 'Romance Dawn', series: null, code: 'OP01', releaseDate: '2022-12-02', imageUrl: '' },
];

describe('ExpansionBrowserScreen', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('lists the sets for the lane it was given', async () => {
    const listExpansions = jest
      .spyOn(MockSpotlightRepository.prototype, 'listExpansions')
      .mockResolvedValue(ONE_PIECE_SETS);

    renderWithProviders(
      <ExpansionBrowserScreen game="onepiece" onClose={jest.fn()} onSelectExpansion={jest.fn()} />,
    );

    await waitFor(() => expect(listExpansions).toHaveBeenCalledWith('onepiece'));
    expect((await screen.findAllByText('Romance Dawn')).length).toBeGreaterThan(0);
  });

  it('falls back to Pokémon when no lane is given', async () => {
    // Absent means Pokémon everywhere — an older caller that passes nothing
    // must keep getting the set list it has always had.
    const listExpansions = jest
      .spyOn(MockSpotlightRepository.prototype, 'listExpansions')
      .mockResolvedValue([]);

    renderWithProviders(
      <ExpansionBrowserScreen onClose={jest.fn()} onSelectExpansion={jest.fn()} />,
    );

    await waitFor(() => expect(listExpansions).toHaveBeenCalledWith('pokemon'));
  });
});
