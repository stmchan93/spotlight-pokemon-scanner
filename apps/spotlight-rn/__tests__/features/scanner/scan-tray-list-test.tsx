import { act, render } from '@testing-library/react-native';

import { useScanTrayItems, type ScanTrayListItem } from '@/features/scanner/screens/scan-tray-list';
import type { RecentCapture } from '@/features/scanner/screens/scanner-screen-types';
import { createTrayStore, useTrayIds, type TrayStore } from '@/features/scanner/tray-store';

function makeCapture(id: string, pageId?: string): RecentCapture {
  return {
    activeCandidateIndex: 0,
    binderPage: pageId ? { layoutId: '3x3', pageId, pocketIndex: 0 } : undefined,
    candidates: [],
    id,
    mode: 'raw',
  } as unknown as RecentCapture;
}

// Mirrors the screen: ids + page ids + first-row-per-page groups.
function describeItems(items: ScanTrayListItem[]): string[] {
  return items.map((item) => (
    item.kind === 'header'
      ? `header:${item.pageId}(${item.rowCount})`
      : `${item.captureId}${item.exitingCapture ? ' (exiting)' : ''}`
  ));
}

let latest: ScanTrayListItem[] = [];

function Harness({ animateRemovals = true, store }: { animateRemovals?: boolean; store: TrayStore }) {
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
  latest = useScanTrayItems({ animateRemovals, ids, pageGroups, pageIds, trayStore: store });
  return null;
}

describe('useScanTrayItems', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    latest = [];
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('holds a removed row in its old slot while it exits, then drops it', () => {
    const store = createTrayStore(['a', 'b', 'c'].map((id) => makeCapture(id)));
    render(<Harness store={store} />);
    expect(describeItems(latest)).toEqual(['a', 'b', 'c']);

    act(() => {
      store.removeCaptures(new Set(['b']));
    });
    expect(describeItems(latest)).toEqual(['a', 'b (exiting)', 'c']);
    // The row it shows is the capture as it was when removed.
    const exiting = latest[1];
    expect(exiting.kind === 'row' && exiting.exitingCapture?.id).toBe('b');

    act(() => {
      jest.advanceTimersByTime(400);
    });
    expect(describeItems(latest)).toEqual(['a', 'c']);
  });

  it('keeps an exiting first row under its binder page header', () => {
    const store = createTrayStore([
      makeCapture('new'),
      makeCapture('p1', 'page-1'),
      makeCapture('p2', 'page-1'),
    ]);
    render(<Harness store={store} />);
    expect(describeItems(latest)).toEqual(['new', 'header:page-1(2)', 'p1', 'p2']);

    act(() => {
      store.removeCaptures(new Set(['p1']));
    });
    expect(describeItems(latest)).toEqual(['new', 'header:page-1(1)', 'p1 (exiting)', 'p2']);
  });

  it('exits every row of a deleted page in place while its header goes at once', () => {
    const store = createTrayStore([
      makeCapture('p1', 'page-1'),
      makeCapture('p2', 'page-1'),
      makeCapture('q1', 'page-2'),
    ]);
    render(<Harness store={store} />);

    act(() => {
      store.removeCaptures(new Set(['p1', 'p2']));
    });
    expect(describeItems(latest)).toEqual(['p1 (exiting)', 'p2 (exiting)', 'header:page-2(1)', 'q1']);
  });

  it('places a new scan above rows that are still exiting', () => {
    const store = createTrayStore(['a', 'b'].map((id) => makeCapture(id)));
    render(<Harness store={store} />);

    act(() => {
      store.removeCaptures(new Set(['a']));
    });
    act(() => {
      store.setItems((current) => [makeCapture('z'), ...current]);
    });
    expect(describeItems(latest)).toEqual(['a (exiting)', 'z', 'b']);
  });

  it('clears instantly when the tray empties (clear all), as before', () => {
    const store = createTrayStore(['a', 'b'].map((id) => makeCapture(id)));
    render(<Harness store={store} />);

    act(() => {
      store.clear();
    });
    expect(latest).toEqual([]);
  });

  it('removes instantly with reduced motion', () => {
    const store = createTrayStore(['a', 'b'].map((id) => makeCapture(id)));
    render(<Harness animateRemovals={false} store={store} />);

    act(() => {
      store.removeCaptures(new Set(['a']));
    });
    expect(describeItems(latest)).toEqual(['b']);
  });

  it('reuses item objects while they are unchanged', () => {
    const store = createTrayStore(['a', 'b'].map((id) => makeCapture(id)));
    render(<Harness store={store} />);
    const [firstA, firstB] = latest;

    act(() => {
      store.patchCapture('a', (capture) => ({ ...capture, recentlyAdded: true }));
    });
    act(() => {
      store.setItems((current) => [makeCapture('c'), ...current]);
    });
    expect(latest[1]).toBe(firstA);
    expect(latest[2]).toBe(firstB);
  });
});
