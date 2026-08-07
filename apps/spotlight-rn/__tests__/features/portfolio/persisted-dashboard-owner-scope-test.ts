import type { PortfolioDashboard } from '@spotlight/api-client';

import { persistDashboard, readPersistedDashboard } from '@/features/portfolio/persisted-dashboard';

// In-memory AsyncStorage so the security boundary can be exercised in isolation.
// Named `mockStore` so jest permits it inside the (hoisted) jest.mock factory.
const mockStore = new Map<string, string>();

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn((key: string) => Promise.resolve(mockStore.get(key) ?? null)),
    setItem: jest.fn((key: string, value: string) => {
      mockStore.set(key, value);
      return Promise.resolve();
    }),
    removeItem: jest.fn((key: string) => {
      mockStore.delete(key);
      return Promise.resolve();
    }),
  },
}));

const STORAGE_KEY = '@spotlight/portfolio/dashboard-cache';

// Minimal dashboard stand-in — the owner-scoping never inspects its shape.
const dashboard = { summary: { currentValue: 12345 }, inventoryItems: [] } as unknown as PortfolioDashboard;

const COLLECTION = 'collection:main';

describe('persisted portfolio dashboard — owner scoping (cross-account leak guard)', () => {
  beforeEach(() => {
    mockStore.clear();
    jest.clearAllMocks();
  });

  it('returns the snapshot for the SAME owner that saved it', async () => {
    persistDashboard(dashboard, '2026-07-02T00:00:00Z', 'user-A', COLLECTION);
    const result = await readPersistedDashboard('user-A', COLLECTION);
    expect(result?.dashboard).toEqual(dashboard);
    expect(result?.savedAt).toBe('2026-07-02T00:00:00Z');
  });

  it("NEVER returns account A's snapshot to account B, and deletes it", async () => {
    persistDashboard(dashboard, '2026-07-02T00:00:00Z', 'user-A', COLLECTION);

    const leaked = await readPersistedDashboard('user-B', COLLECTION);

    expect(leaked).toBeNull(); // the core security guarantee
    // The mismatched snapshot is purged so it can't leak on a later read either.
    expect(mockStore.has(STORAGE_KEY)).toBe(false);
  });

  it('discards a legacy snapshot that has no ownerKey', async () => {
    // Simulate a pre-fix persisted blob (no ownerKey stamp).
    mockStore.set(STORAGE_KEY, JSON.stringify({ dashboard, savedAt: 'x' }));
    expect(await readPersistedDashboard('user-A', COLLECTION)).toBeNull();
    expect(mockStore.has(STORAGE_KEY)).toBe(false);
  });

  it('returns null (no throw) when nothing is persisted', async () => {
    expect(await readPersistedDashboard('user-A', COLLECTION)).toBeNull();
  });

  it("does NOT hydrate one collection's tab with another collection's snapshot", async () => {
    persistDashboard(dashboard, '2026-07-02T00:00:00Z', 'user-A', COLLECTION);

    // Same account, different collection: the balance and chart belong to the
    // collection they were computed for, so this must miss rather than paint
    // Main Collection's numbers under Grails' name.
    expect(await readPersistedDashboard('user-A', 'collection:grails')).toBeNull();
    // Unlike the cross-account case the snapshot is KEPT — it is still valid for
    // its own collection, so switching back serves it instantly.
    expect(mockStore.has(STORAGE_KEY)).toBe(true);
  });

  it('discards a snapshot saved before collections existed', async () => {
    mockStore.set(STORAGE_KEY, JSON.stringify({ dashboard, savedAt: 'x', ownerKey: 'user-A' }));
    expect(await readPersistedDashboard('user-A', COLLECTION)).toBeNull();
  });
});
