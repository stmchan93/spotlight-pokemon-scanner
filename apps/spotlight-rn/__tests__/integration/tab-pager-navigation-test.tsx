import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { useIsFocused } from '@react-navigation/native';
import { router } from 'expo-router';
import { Text } from 'react-native';
import * as Reanimated from 'react-native-reanimated';

import { useTabsPage } from '@/contexts/tabs-page-context';

import { renderAppRouter } from '../test-utils';

// The root's floating Ekalight bubble animates with Reanimated too; these tests
// assert on the PAGER's withTiming calls, so the bubble stays out of them.
jest.mock('@/features/assistant/components/floating-assistant-bubble', () => ({
  FloatingAssistantBubble: () => null,
}));

/** A tab stub that reports what the pager tells it: navigation focus + activePage. */
function makeStub(name: string) {
  return function TabStub() {
    const focused = useIsFocused();
    const { activePage } = useTabsPage();
    return (
      <Text testID={`stub-${name}`}>
        {`${focused ? 'focused' : 'blurred'}:${activePage}`}
      </Text>
    );
  };
}

const STUBS = {
  '(tabs)/index': makeStub('index'),
  '(tabs)/search': makeStub('search'),
  '(tabs)/scan': makeStub('scan'),
  '(tabs)/events': makeStub('events'),
  '(tabs)/social': makeStub('social'),
};

// Off-screen pages are hidden from accessibility, so include hidden elements.
const stubText = (name: string) =>
  screen.getByTestId(`stub-${name}`, { includeHiddenElements: true }).props.children as string;

describe('tab pager <-> expo-router', () => {
  it('hides the tab bar while the page asks (binder review covers its footer)', async () => {
    // Required lazily: importing the pager module at the top of this file loads
    // gesture-handler before the test environment's mock is in place.
    const { useTabPagerHideBar } = require('@/components/tab-pager/tab-pager-page-context');
    function HidingScan() {
      useTabPagerHideBar(true);
      return <Text testID="stub-scan">hiding</Text>;
    }
    const app = renderAppRouter('/scan', { ...STUBS, '(tabs)/scan': HidingScan });
    await waitFor(() => expect(app.getPathname()).toBe('/scan'));
    await waitFor(() => expect(screen.queryByTestId('app-tab-bar')).not.toBeOnTheScreen());
  });

  it('draws the same blur under the bar on every tab page, and none on Scan', async () => {
    renderAppRouter('/', STUBS);
    await waitFor(() => expect(screen.getByTestId('stub-index')).toBeTruthy());
    for (const path of ['/search', '/scan', '/events', '/social'] as const) {
      act(() => {
        router.push(path);
      });
    }
    await waitFor(() => expect(screen.getByTestId('stub-social', { includeHiddenElements: true })).toBeTruthy());
    const backdropOn = (page: string) =>
      screen.getByTestId(`tab-pager-page-${page}`, { includeHiddenElements: true })
        .findAll((node: { props: { testID?: string } }) => node.props.testID === 'tab-bar-backdrop-blur').length > 0;
    expect(['index', 'search', 'events', 'social'].map(backdropOn)).toEqual([true, true, true, true]);
    expect(backdropOn('scan')).toBe(false);
  });

  it('drops the blur on a page that asks (an edit bar sits above the tab bar)', async () => {
    const { useTabPagerHideBackdrop } = require('@/components/tab-pager/tab-pager-page-context');
    function EditingSearch() {
      useTabPagerHideBackdrop(true);
      return <Text testID="stub-search">editing</Text>;
    }
    renderAppRouter('/search', { ...STUBS, '(tabs)/search': EditingSearch });
    await waitFor(() => expect(screen.getByTestId('stub-search')).toBeTruthy());
    await waitFor(() =>
      expect(
        screen.getByTestId('tab-pager-page-search').findAll((node: { props: { testID?: string } }) => node.props.testID === 'tab-bar-backdrop-blur'),
      ).toHaveLength(0),
    );
    expect(screen.getByTestId('app-tab-bar')).toBeTruthy();
  });

  it('opens on the route the URL names, mounting only that page', async () => {
    const app = renderAppRouter('/events', STUBS);
    await waitFor(() => expect(app.getPathname()).toBe('/events'));
    expect(stubText('events')).toBe('focused:portfolio');
    // Lazy: nothing else has been visited.
    expect(screen.queryByTestId('stub-index')).toBeNull();
    expect(screen.queryByTestId('stub-scan')).toBeNull();
    // The bar is ours and says which page is selected.
    expect(screen.getByTestId('app-tab-events').props.accessibilityState).toEqual({ selected: true });
  });

  it('moves the strip when the route changes (router.push to a tab)', async () => {
    const app = renderAppRouter('/', STUBS);
    await waitFor(() => expect(screen.getByTestId('stub-index')).toBeTruthy());

    act(() => {
      router.push('/search');
    });
    await waitFor(() => expect(app.getPathname()).toBe('/search'));
    expect(stubText('search')).toBe('focused:portfolio');
    // Visited pages stay mounted, and lose focus.
    expect(stubText('index')).toBe('blurred:scanner');
    expect(screen.getByTestId('app-tab-search').props.accessibilityState).toEqual({ selected: true });
  });

  it('updates the route when a bar item is tapped', async () => {
    const app = renderAppRouter('/', STUBS);
    await waitFor(() => expect(screen.getByTestId('stub-index')).toBeTruthy());

    fireEvent.press(screen.getByTestId('app-tab-social'));
    await waitFor(() => expect(app.getPathname()).toBe('/social'));
    expect(stubText('social')).toBe('focused:portfolio');
  });

  it('jumps (no slide) for launch routing before the user has touched the strip', async () => {
    const app = renderAppRouter('/', STUBS);
    await waitFor(() => expect(screen.getByTestId('stub-index')).toBeTruthy());
    const withTiming = jest.spyOn(Reanimated, 'withTiming');

    // A redirect / deep link nobody tapped: the strip must not play a swipe.
    act(() => {
      router.navigate('/search');
    });
    await waitFor(() => expect(app.getPathname()).toBe('/search'));
    expect(withTiming).not.toHaveBeenCalled();
    withTiming.mockRestore();
  });

  it('keeps the camera off until the strip has SETTLED on Scan', async () => {
    const app = renderAppRouter('/', STUBS);
    await waitFor(() => expect(screen.getByTestId('stub-index')).toBeTruthy());

    // Hold the slide mid-flight: the route has changed, the strip has not arrived.
    let finishSlide: ((finished: boolean) => void) | undefined;
    const withTiming = jest
      .spyOn(Reanimated, 'withTiming')
      .mockImplementation(((toValue: number, _config: unknown, callback?: (finished: boolean) => void) => {
        finishSlide = callback;
        return toValue;
      }) as never);

    fireEvent.press(screen.getByTestId('app-tab-scan'));
    await waitFor(() => expect(app.getPathname()).toBe('/scan'));
    // Focused route, but not live: `activePage` is what gates the camera.
    expect(stubText('scan')).toBe('focused:portfolio');

    act(() => finishSlide?.(true));
    expect(stubText('scan')).toBe('focused:scanner');
    withTiming.mockRestore();
  });

  it('turns the bar dark on Scan by blending, not by swapping bars', async () => {
    renderAppRouter('/scan', STUBS);
    await waitFor(() => expect(screen.getByTestId('stub-scan')).toBeTruthy());
    // One bar everywhere; the scanner slab is a layer of it.
    expect(screen.getAllByTestId('app-tab-bar')).toHaveLength(1);
    expect(screen.getByTestId('app-tab-bar-dark')).toBeTruthy();
  });

  it('redirects /you onto the Home page', async () => {
    const app = renderAppRouter('/you', STUBS);
    await waitFor(() => expect(app.getPathname()).toBe('/'));
    expect(stubText('index')).toBe('focused:portfolio');
  });
});
