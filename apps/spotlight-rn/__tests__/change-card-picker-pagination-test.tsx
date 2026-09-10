import { fireEvent, screen } from '@testing-library/react-native';

import type { CatalogSearchResult } from '@spotlight/api-client';

import { ChangeCardPicker } from '@/features/scanner/screens/change-card-picker';

import { renderWithProviders } from './test-utils';

jest.mock('expo-blur', () => ({ BlurView: 'BlurView' }));

function candidate(index: number): CatalogSearchResult {
  return {
    id: `cand-${index}`,
    cardId: `sv1-${index}`,
    name: `Card ${index}`,
    cardNumber: `${index}`,
    setName: 'Scarlet & Violet',
    imageUrl: `https://example.com/${index}.png`,
    matchScore: 1 - index / 100,
  };
}

const CANDIDATES = Array.from({ length: 25 }, (_, index) => candidate(index));

/*
  Picking a row changes `activeCandidateIndex` while the sheet stays open. That
  used to reset the paged list to the first 10 rows, throwing away the user's
  "load more" (reported 2026-09-10). The list resets only when the sheet opens.
*/
describe('change card picker pagination', () => {
  it('keeps the loaded pages after a candidate is picked', () => {
    const onSelectCandidate = jest.fn();
    const view = renderWithProviders(
      <ChangeCardPicker
        visible
        candidates={CANDIDATES}
        activeCandidateIndex={0}
        mode="slabs"
        onClose={jest.fn()}
        onSelectCandidate={onSelectCandidate}
      />,
    );

    expect(screen.getByTestId('change-card-picker-row-9')).toBeTruthy();
    expect(screen.queryByTestId('change-card-picker-row-10')).toBeNull();

    fireEvent.press(screen.getByTestId('change-card-picker-load-more'));
    expect(screen.getByTestId('change-card-picker-row-19')).toBeTruthy();

    // The parent echoes the pick back as the new active index.
    fireEvent.press(screen.getByTestId('change-card-picker-row-15'));
    expect(onSelectCandidate).toHaveBeenCalledWith(15);
    view.rerender(
      <ChangeCardPicker
        visible
        candidates={CANDIDATES}
        activeCandidateIndex={15}
        mode="slabs"
        onClose={jest.fn()}
        onSelectCandidate={onSelectCandidate}
      />,
    );

    expect(screen.getByTestId('change-card-picker-row-19')).toBeTruthy();
    expect(screen.getByTestId('change-card-picker-load-more')).toBeTruthy();
  });

  it('starts from the first page again when the sheet is reopened', () => {
    const props = {
      candidates: CANDIDATES,
      activeCandidateIndex: 0,
      mode: 'slabs' as const,
      onClose: jest.fn(),
      onSelectCandidate: jest.fn(),
    };
    const view = renderWithProviders(<ChangeCardPicker visible {...props} />);

    fireEvent.press(screen.getByTestId('change-card-picker-load-more'));
    expect(screen.getByTestId('change-card-picker-row-19')).toBeTruthy();

    view.rerender(<ChangeCardPicker visible={false} {...props} />);
    view.rerender(<ChangeCardPicker visible {...props} />);

    expect(screen.getByTestId('change-card-picker-row-9')).toBeTruthy();
    expect(screen.queryByTestId('change-card-picker-row-10')).toBeNull();
  });
});
