import { fireEvent, render, screen } from '@testing-library/react-native';

import { mockSpotlightEventMap, type SpotlightEventMap } from '@spotlight/api-client';
import { SpotlightThemeProvider } from '@spotlight/design-system';

import { EventFloorMap } from '@/features/events/components/event-floor-map';

const vectorMap: SpotlightEventMap = {
  ...mockSpotlightEventMap,
  vector: {
    baseImageUrl: 'https://example.com/api/v1/events/hawaii-2026-10/map-base-image',
    baseImage: { x: 0, y: 0, width: 1, height: 1 },
    areas: [{ shape: 'rect', x: 0.4, y: 0.3, width: 0.2, height: 0.3, color: '#FFE500', opacity: 0.7 }],
    labels: [{ text: 'Food/\nDrink', x: 0.45, y: 0.35, width: 0.1, height: 0.05, fontSize: 0.01, bold: true }],
    tableColor: '#BFFEAC',
    tableNumberSize: 0.004,
  },
};

function renderMap(map: SpotlightEventMap) {
  const view = render(
    <SpotlightThemeProvider>
      <EventFloorMap
        focusKey={null}
        map={map}
        matchedTableIds={new Set()}
        onTablePress={jest.fn()}
        selectedTableIds={new Set(['C14'])}
      />
    </SpotlightThemeProvider>,
  );
  fireEvent(screen.getByTestId('event-floor-map'), 'layout', {
    nativeEvent: { layout: { x: 0, y: 0, width: 360, height: 440 } },
  });
  return view;
}

describe('EventFloorMap', () => {
  it('draws tables, their numbers and labels itself over a walls-only image', () => {
    renderMap(vectorMap);
    expect(screen.getByTestId('event-floor-map-image').props.source).toMatchObject({
      uri: 'https://example.com/api/v1/events/hawaii-2026-10/map-base-image',
    });
    expect(screen.getByText('14')).toBeTruthy();
    expect(screen.getByText('Food/\nDrink')).toBeTruthy();
    expect(screen.getByTestId('event-floor-map-highlight-C14')).toBeTruthy();
  });

  it('falls back to the flat floor image when there is no drawn layer', () => {
    renderMap(mockSpotlightEventMap);
    expect(screen.getByTestId('event-floor-map-image').props.source).toMatchObject({
      uri: mockSpotlightEventMap.imageUrl,
    });
    expect(screen.queryByText('14')).toBeNull();
  });
});
