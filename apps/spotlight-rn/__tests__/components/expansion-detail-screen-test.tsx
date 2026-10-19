import { act, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { MockSpotlightRepository, mockCatalogResults } from '@spotlight/api-client';

import { ExpansionDetailScreen } from '@/features/catalog/screens/expansion-detail-screen';

import { renderWithProviders } from '../test-utils';

// The screen reads the "Added to your collection" handoff on FOCUS; with no
// navigator above it, running the callback once on mount is the stand-in.
jest.mock('expo-router', () => ({
  useFocusEffect: (callback: () => void | (() => void)) => require('react').useEffect(callback, [callback]),
}));

describe('ExpansionDetailScreen', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sets the card number in caps under a name that keeps its own casing', async () => {
    const card = mockCatalogResults[0];
    jest.spyOn(MockSpotlightRepository.prototype, 'listCardsInExpansion').mockResolvedValue([card]);

    renderWithProviders(
      <ExpansionDetailScreen
        expansionId="sm7"
        expansionName="Celestial Storm"
        onClose={jest.fn()}
        onOpenCard={jest.fn()}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });

    // Casing is a style on the meta line, never a rewrite of the string.
    const number = await screen.findByText(card.cardNumber);
    expect(StyleSheet.flatten(number.props.style)).toMatchObject({ textTransform: 'uppercase' });
    // Two "Treecko"s: the display title is the set, the tile name is the card.
    for (const name of screen.getAllByText(card.name)) {
      expect(StyleSheet.flatten(name.props.style).textTransform).toBeUndefined();
    }
    expect(StyleSheet.flatten(screen.getByText('Celestial Storm').props.style).textTransform).toBeUndefined();
  });
});
