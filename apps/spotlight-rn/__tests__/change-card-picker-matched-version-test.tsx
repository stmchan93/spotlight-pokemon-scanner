import { screen } from '@testing-library/react-native';

import type { CatalogSearchResult } from '@spotlight/api-client';

import { ChangeCardPicker } from '@/features/scanner/screens/change-card-picker';

import { createTestSpotlightRepository, renderWithProviders } from './test-utils';

jest.mock('expo-blur', () => ({ BlurView: 'BlurView' }));

const versionImage = 'https://tcgplayer-cdn.tcgplayer.com/product/541670_in_1000x1000.jpg';

const rebecca: CatalogSearchResult = {
  id: 'rebecca',
  cardId: 'onepiece~op05-091',
  name: 'Rebecca',
  cardNumber: 'OP05-091',
  setName: 'Awakening of the New Era',
  imageUrl: 'https://img/rebecca.png',
  smallImageUrl: 'https://img/rebecca-small.png',
  matchScore: 0.9,
  matchedVariant: {
    label: 'Special Alt Art',
    tcgplayerProductId: '541670',
    imageUrl: versionImage,
    source: 'tcgplayer',
  },
};

const other: CatalogSearchResult = {
  id: 'other',
  cardId: 'onepiece~op05-092',
  name: 'Other',
  cardNumber: 'OP05-092',
  setName: 'Awakening of the New Era',
  imageUrl: 'https://img/other.png',
  matchScore: 0.5,
};

function renderPicker(selectedVariantLabel: string | null) {
  return renderWithProviders(
    <ChangeCardPicker
      visible
      activeCandidateIndex={0}
      candidates={[rebecca, other]}
      mode="raw"
      onClose={jest.fn()}
      onSelectCandidate={jest.fn()}
      selectedVariantLabel={selectedVariantLabel}
    />,
    {
      spotlightRepository: createTestSpotlightRepository({
        getRawPricingMatrix: async () => ({ cardID: rebecca.cardId, currencyCode: 'USD', variants: [] }),
      }),
    },
  );
}

const uriOf = (testID: string) => screen.getByTestId(testID).props.source?.uri;

describe('change card picker: matched art version', () => {
  it('depicts and names the matched version on the hero and its row', () => {
    renderPicker(null);

    expect(uriOf('change-card-picker-hero')).toBe(versionImage);
    expect(uriOf('change-card-picker-row-0-thumb')).toBe(versionImage);
    expect(screen.getByTestId('change-card-picker-row-0-meta').props.children)
      .toBe('#OP05-091 · Special Alt Art · Awakening of the New Era');
    // A candidate without a matched version keeps its own art and number.
    expect(uriOf('change-card-picker-row-1-thumb')).toBe('https://img/other.png');
    expect(screen.getByTestId('change-card-picker-row-1-meta').props.children)
      .toBe('#OP05-092 · Awakening of the New Era');
  });

  it("follows the chosen printing: another printing shows the card's own art", () => {
    renderPicker('Normal');

    expect(uriOf('change-card-picker-hero')).toBe('https://img/rebecca.png');
    expect(uriOf('change-card-picker-row-0-thumb')).toBe('https://img/rebecca-small.png');
    expect(screen.getByTestId('change-card-picker-row-0-meta').props.children)
      .toBe('#OP05-091 · Awakening of the New Era');
  });

  it('keeps the version while its own printing is the chosen one', () => {
    renderPicker('special alt art');

    expect(uriOf('change-card-picker-hero')).toBe(versionImage);
  });
});
