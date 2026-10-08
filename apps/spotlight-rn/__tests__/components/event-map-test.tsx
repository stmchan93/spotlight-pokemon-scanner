import { fireEvent, render, screen } from '@testing-library/react-native';
import { Platform, UIManager } from 'react-native';

const mockOpenURL = jest.fn((_url: string) => Promise.resolve(true));

jest.mock('expo-linking', () => ({
  openURL: (url: string) => mockOpenURL(url),
}));

function mockMapsModule() {
  const { View } = require('react-native');
  const MapView = ({ children, ...props }: { children?: React.ReactNode }) => (
    <View testID="mock-map-view" {...props}>
      {children}
    </View>
  );
  const Marker = (props: Record<string, unknown>) => <View testID="mock-map-marker" {...props} />;
  return { __esModule: true, default: MapView, Marker };
}

jest.mock('react-native-maps', () => mockMapsModule());

type EventMapModule = typeof import('@/features/events/components/event-map');

const props = {
  latitude: 34.0522,
  longitude: -118.2437,
  title: 'Pomona Card Show',
  address: '1101 W McKinley Ave, Pomona, CA',
  testID: 'event-map',
};

// The module caches the native check, so each case loads a fresh copy.
function loadEventMap(hasNativeMap: boolean): EventMapModule {
  const hasViewManagerConfig = jest.fn((name: string) => hasNativeMap && name === 'RNMapsMapView');
  (UIManager as unknown as { hasViewManagerConfig: unknown }).hasViewManagerConfig =
    hasViewManagerConfig;
  let loaded: EventMapModule | undefined;
  jest.isolateModules(() => {
    loaded = require('@/features/events/components/event-map') as EventMapModule;
  });
  return loaded!;
}

describe('EventMap', () => {
  const originalOS = Platform.OS;
  const originalHasViewManagerConfig = UIManager.hasViewManagerConfig;

  beforeEach(() => {
    mockOpenURL.mockClear();
  });

  afterEach(() => {
    Platform.OS = originalOS;
  });

  afterAll(() => {
    UIManager.hasViewManagerConfig = originalHasViewManagerConfig;
  });

  it('falls back to a pressable address card when the native map is missing (pre-maps binary via OTA)', () => {
    Platform.OS = 'ios';
    const { EventMap } = loadEventMap(false);
    render(<EventMap {...props} />);

    expect(screen.queryByTestId('mock-map-view')).toBeNull();
    expect(screen.getByTestId('iconoir-map-pin')).toBeTruthy();
    expect(screen.getByText(props.address)).toBeTruthy();

    fireEvent.press(screen.getByTestId('event-map-fallback'));
    expect(mockOpenURL).toHaveBeenCalledWith(
      'http://maps.apple.com/?daddr=34.0522,-118.2437&q=Pomona%20Card%20Show',
    );
  });

  it('falls back when requiring the module throws', () => {
    jest.doMock('react-native-maps', () => {
      throw new Error("TurboModuleRegistry.getEnforcing(...): 'RNMapsAirModule' could not be found");
    });
    try {
      const { EventMap } = loadEventMap(true);
      render(<EventMap {...props} />);
      expect(screen.getByTestId('event-map-fallback')).toBeTruthy();
    } finally {
      jest.doMock('react-native-maps', () => mockMapsModule());
    }
  });

  it('opens a geo: intent on Android', () => {
    Platform.OS = 'android';
    const { EventMap } = loadEventMap(false);
    render(<EventMap {...props} />);

    fireEvent.press(screen.getByTestId('event-map-fallback'));
    expect(mockOpenURL).toHaveBeenCalledWith(
      'geo:34.0522,-118.2437?q=34.0522,-118.2437(Pomona%20Card%20Show)',
    );
  });

  it('renders an interactive map with one marker when the native view exists', () => {
    Platform.OS = 'ios';
    const { EventMap } = loadEventMap(true);
    render(<EventMap {...props} />);

    const map = screen.getByTestId('mock-map-view');
    expect(map.props.initialRegion).toEqual({
      latitude: props.latitude,
      longitude: props.longitude,
      latitudeDelta: 0.05,
      longitudeDelta: 0.05,
    });
    expect(map.props.scrollEnabled).toBe(true);
    expect(map.props.zoomEnabled).toBe(true);
    expect(map.props.pitchEnabled).toBe(false);
    expect(map.props.rotateEnabled).toBe(false);

    const marker = screen.getByTestId('mock-map-marker');
    expect(marker.props.title).toBe(props.title);
    expect(marker.props.description).toBe(props.address);

    fireEvent(marker, 'calloutPress');
    expect(mockOpenURL).toHaveBeenCalledWith(
      'http://maps.apple.com/?daddr=34.0522,-118.2437&q=Pomona%20Card%20Show',
    );
  });
});
