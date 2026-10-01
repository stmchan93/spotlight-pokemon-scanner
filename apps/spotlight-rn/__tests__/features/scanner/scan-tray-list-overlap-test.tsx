import { act, render } from '@testing-library/react-native';
import { type ReactElement, useRef } from 'react';

import type { RecentCapture } from '@/features/scanner/screens/scanner-screen-types';
import type { TrayStore } from '@/features/scanner/tray-store';

type ReactTestInstance = ReturnType<typeof render>['UNSAFE_root'];

/*
  Android regression (2026-09-30, Galaxy staging): tray rows drawn on top of
  each other in the first slot after binder-page scans + a single scan, and
  after deleting rows. FlashList v2 sizes cells by index, so the first commit
  after a change stacks rows onto a stale zero-height (exiting) or header-sized
  slot for one commit; a Reanimated layout glide started on that commit kept
  the stale frame on Android. Rows must settle without overlap, Android cells
  must never carry a layout transition, and an exiting row's expiry (the
  zero-height slot going away) must never glide anywhere.
*/

const ROW_HEIGHT = 126;
const HEADER_HEIGHT = 64;

type CellRecord = { commit: number; glide: boolean; height: number; key: string; top: number };

type Modules = {
  ScanTrayList: typeof import('@/features/scanner/screens/scan-tray-list').ScanTrayList;
  createTrayStore: typeof import('@/features/scanner/tray-store').createTrayStore;
  useTrayIds: typeof import('@/features/scanner/tray-store').useTrayIds;
  Gesture: typeof import('react-native-gesture-handler').Gesture;
  View: typeof import('react-native').View;
  measureItemLayout: jest.Mock;
};

function loadModules(os: 'ios' | 'android'): Modules {
  let modules: Modules | null = null;
  jest.isolateModules(() => {
    const reactNative = require('react-native') as typeof import('react-native');
    Object.defineProperty(reactNative.Platform, 'OS', { configurable: true, get: () => os });
    modules = {
      Gesture: require('react-native-gesture-handler').Gesture,
      ScanTrayList: require('@/features/scanner/screens/scan-tray-list').ScanTrayList,
      View: reactNative.View,
      createTrayStore: require('@/features/scanner/tray-store').createTrayStore,
      measureItemLayout: require('@shopify/flash-list/dist/recyclerview/utils/measureLayout').measureItemLayout,
      useTrayIds: require('@/features/scanner/tray-store').useTrayIds,
    };
  });
  return modules!;
}

function makeCapture(id: string, pageId?: string): RecentCapture {
  return {
    activeCandidateIndex: 0,
    binderPage: pageId ? { layoutId: '3x3', pageId, pocketIndex: 0 } : undefined,
    candidates: [],
    id,
    mode: 'raw',
  } as unknown as RecentCapture;
}

// Which list item a cell shows, from the element FlashList rendered into it.
function describeCell(children: unknown): { height: number; key: string } | null {
  const [content] = Array.isArray(children) ? children : [children];
  const element = content as ReactElement<{ children?: ReactElement<{ testID?: string }>; item?: { captureId: string; exitingCapture: unknown } }> | null;
  if (!element?.props) {
    return null;
  }
  if (element.props.item) {
    const { captureId, exitingCapture } = element.props.item;
    return exitingCapture
      ? { height: 0, key: `exiting:${captureId}` }
      : { height: ROW_HEIGHT, key: `row:${captureId}` };
  }
  const testID = element.props.children?.props?.testID;
  return testID ? { height: HEADER_HEIGHT, key: testID } : null;
}

function setup(os: 'ios' | 'android') {
  const modules = loadModules(os);
  const { Gesture, ScanTrayList, View, createTrayStore, measureItemLayout, useTrayIds } = modules;
  const records: CellRecord[] = [];
  let commit = 0;
  let lastViews = new Set<unknown>();
  measureItemLayout.mockImplementation((view: { props: { children?: unknown; layout?: unknown; style?: { top?: number } } }) => {
    // FlashList measures every mounted cell once per commit, in order.
    if (lastViews.has(view)) {
      commit += 1;
      lastViews = new Set();
    }
    lastViews.add(view);
    const cell = describeCell(view.props.children);
    if (!cell) {
      return { height: 0, width: 400, x: 0, y: 0 };
    }
    records.push({
      commit,
      glide: view.props.layout != null,
      height: cell.height,
      key: cell.key,
      top: view.props.style?.top ?? 0,
    });
    return { height: cell.height, width: 400, x: 0, y: 0 };
  });

  function Harness({ store }: { store: TrayStore }) {
    const ids = useTrayIds(store);
    const items = store.getState().items;
    const pageIds = items.map((capture) => capture.binderPage?.pageId);
    const pageGroups = new Map<string, { firstCaptureId: string; rowCount: number }>();
    items.forEach((capture) => {
      const pageId = capture.binderPage?.pageId;
      if (!pageId) {
        return;
      }
      const group = pageGroups.get(pageId);
      if (group) {
        group.rowCount += 1;
      } else {
        pageGroups.set(pageId, { firstCaptureId: capture.id, rowCount: 1 });
      }
    });
    const listRef = useRef(null);
    const enterRef = useRef(true);
    return (
      <ScanTrayList
        contentOffset={{ x: 0, y: 0 }}
        drawDistance={4000}
        enterAnimationEnabledRef={enterRef}
        footer={null}
        height={900}
        ids={ids}
        listRef={listRef}
        nativeScrollGesture={Gesture.Native()}
        pageGroups={pageGroups}
        pageIds={pageIds}
        renderHeader={(pageId) => <View testID={`header:${pageId}`} />}
        renderRow={(captureId) => <View testID={`row-${captureId}`} />}
        scrollEnabled
        scrollOffset={{ value: 0 } as never}
        showsVerticalScrollIndicator={false}
        testID="tray"
        trayStore={store}
      />
    );
  }

  const store = createTrayStore([
    makeCapture('p1', 'page-1'),
    makeCapture('p2', 'page-1'),
    makeCapture('p3', 'page-1'),
    makeCapture('old'),
  ]);
  const screen = render(<Harness store={store} />);

  // Every live (non-exiting) cell as currently committed, top to bottom.
  const settled = (): CellRecord[] => (screen.UNSAFE_root as ReactTestInstance)
    .findAll((node: ReactTestInstance) => typeof node.type === 'string'
      && (node.props.style as { position?: string } | undefined)?.position === 'absolute'
      && typeof (node.props.style as { top?: number }).top === 'number')
    .flatMap((cell: ReactTestInstance): CellRecord[] => {
      const exiting = cell.findAll((node: ReactTestInstance) => node.props.pointerEvents === 'none').length > 0;
      const [content] = cell.findAll((node: ReactTestInstance) => typeof node.type === 'string'
        && typeof node.props.testID === 'string'
        && /^(row-|header:)/.test(node.props.testID));
      if (!content || exiting) {
        return [];
      }
      const testID = String(content.props.testID);
      const isHeader = testID.startsWith('header:');
      return [{
        commit: -1,
        glide: false,
        height: isHeader ? HEADER_HEIGHT : ROW_HEIGHT,
        key: isHeader ? testID : `row:${testID.slice('row-'.length)}`,
        top: Number((cell.props.style as { top: number }).top),
      }];
    })
    .sort((a: CellRecord, b: CellRecord) => a.top - b.top);

  return { records, screen, settled, store };
}

function expectNoOverlap(cells: CellRecord[]) {
  expect(cells.length).toBeGreaterThan(0);
  for (let i = 1; i < cells.length; i += 1) {
    expect(cells[i].top).toBeGreaterThanOrEqual(cells[i - 1].top + cells[i - 1].height);
  }
}

describe.each(['ios', 'android'] as const)('scan tray rows on %s', (os) => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('never stacks binder-pocket rows and a single scan on one slot (add, delete, expiry)', () => {
    const { records, settled, store } = setup(os);
    expectNoOverlap(settled());

    // A single card scanned after a binder page: lands above the page.
    act(() => {
      store.setItems((current) => [makeCapture('unown'), ...current]);
    });
    act(() => {
      jest.advanceTimersByTime(500);
    });
    expectNoOverlap(settled());
    expect(settled().map((cell) => cell.key)).toEqual([
      'row:unown', 'header:page-1', 'row:p1', 'row:p2', 'row:p3', 'row:old',
    ]);

    // Deleting rows (swipe delete / added to collection): they exit in place,
    // then their zero-height slots go away.
    const beforeDelete = records.length;
    act(() => {
      store.removeCaptures(new Set(['unown', 'p1']));
    });
    const expiryStart = records.length;
    // Small steps so the expiry lands inside the post-delete glide window.
    for (let step = 0; step < 50; step += 1) {
      act(() => {
        jest.advanceTimersByTime(10);
      });
    }
    expect(records.length).toBeGreaterThan(beforeDelete);
    expectNoOverlap(settled());
    expect(settled().map((cell) => cell.key)).toEqual(['header:page-1', 'row:p2', 'row:p3', 'row:old']);
    expect(settled()[0].top).toBe(0);

    // The expiry changes no row's final position: nothing may glide there.
    expect(records.slice(expiryStart).filter((record) => record.glide)).toEqual([]);

    if (os === 'android') {
      expect(records.filter((record) => record.glide)).toEqual([]);
    }
  });
});
