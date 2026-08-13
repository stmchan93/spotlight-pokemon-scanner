import { useEffect } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';
import Constants from 'expo-constants';

import { ALL_COLLECTIONS_ID } from '../../../../packages/api-client/src/spotlight/types';
import {
  HttpSpotlightRepository,
  MockSpotlightRepository,
  type SpotlightRepository,
} from '../../../../packages/api-client/src/spotlight/repository';

import {
  AppProviders,
  DEFAULT_LOCAL_API_BASE_URL,
  createDefaultSpotlightRepository,
  resolveRepositoryBaseUrl,
  resolveRepositoryBaseUrls,
  useAppServices,
} from '@/providers/app-providers';

function RepositoryProbe({
  repositoryOverride,
}: {
  repositoryOverride?: SpotlightRepository;
}) {
  return (
    <AppProviders spotlightRepository={repositoryOverride}>
      <ProbeText repositoryOverride={repositoryOverride} />
    </AppProviders>
  );
}

function ProbeText({
  repositoryOverride,
}: {
  repositoryOverride?: SpotlightRepository;
}) {
  const { spotlightRepository } = useAppServices();

  if (repositoryOverride && spotlightRepository === repositoryOverride) {
    return <Text>override</Text>;
  }

  return (
    <Text>
      {spotlightRepository instanceof HttpSpotlightRepository ? 'http' : 'mock'}
    </Text>
  );
}

function CacheProbe({
  seedInventory,
  seedPortfolio,
}: {
  seedInventory?: Awaited<ReturnType<MockSpotlightRepository['getInventoryEntries']>>;
  seedPortfolio?: Awaited<ReturnType<MockSpotlightRepository['getPortfolioDashboard']>>;
}) {
  const {
    inventoryEntriesCache,
    portfolioDashboardCache,
    setInventoryEntriesCache,
    setPortfolioDashboardCache,
  } = useAppServices();

  useEffect(() => {
    if (seedInventory) {
      setInventoryEntriesCache(seedInventory);
    }

    if (seedPortfolio) {
      setPortfolioDashboardCache(seedPortfolio);
    }
  }, [seedInventory, seedPortfolio, setInventoryEntriesCache, setPortfolioDashboardCache]);

  return (
    <Text testID="cache-state">
      {inventoryEntriesCache?.[0]?.name ?? 'no-inventory'}
      {'|'}
      {portfolioDashboardCache?.inventoryCount ?? 'no-dashboard'}
    </Text>
  );
}

function OwnerScopeProbe() {
  const { activeCollectionID, sessionOwnerKey, setActiveCollectionID } = useAppServices();

  return (
    <>
      <Text testID="owner-scope">{`owner:${sessionOwnerKey}|collection:${activeCollectionID}`}</Text>
      <Text testID="choose-collection" onPress={() => setActiveCollectionID('collection-a')}>
        choose
      </Text>
    </>
  );
}

function CollectionRefreshProbe() {
  const { refreshData, setActiveCollectionID } = useAppServices();

  return (
    <>
      <Text testID="choose-collection-b" onPress={() => setActiveCollectionID('collection-b')}>
        choose
      </Text>
      <Text testID="refresh-data" onPress={() => refreshData()}>
        refresh
      </Text>
    </>
  );
}

describe('AppProviders', () => {
  const mockedConstants = Constants as { expoConfig?: { extra?: Record<string, unknown>; hostUri?: string } };
  const originalNodeEnv = process.env.NODE_ENV;
  const originalApiBaseUrl = process.env.EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL;
  const originalExtra = mockedConstants.expoConfig?.extra
    ? { ...mockedConstants.expoConfig.extra }
    : undefined;
  const originalHostUri = mockedConstants.expoConfig?.hostUri;

  function setNodeEnv(value: string) {
    (process.env as Record<string, string | undefined>).NODE_ENV = value;
  }

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete (process.env as Record<string, string | undefined>).NODE_ENV;
    } else {
      setNodeEnv(originalNodeEnv);
    }
    if (originalApiBaseUrl === undefined) {
      delete process.env.EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL;
    } else {
      process.env.EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL = originalApiBaseUrl;
    }
    if (!mockedConstants.expoConfig) {
      mockedConstants.expoConfig = { extra: {} };
    }
    mockedConstants.expoConfig.extra = originalExtra ? { ...originalExtra } : {};
    mockedConstants.expoConfig.hostUri = originalHostUri;
  });

  it('resolves the live local backend by default outside test runtime', () => {
    setNodeEnv('development');
    delete process.env.EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL;

    expect(resolveRepositoryBaseUrl()).toBe(DEFAULT_LOCAL_API_BASE_URL);
    expect(createDefaultSpotlightRepository()).toBeInstanceOf(HttpSpotlightRepository);
  });

  it('respects an explicit API base URL override and trims the trailing slash', () => {
    setNodeEnv('development');
    process.env.EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL = 'http://10.0.2.2:8788///';

    expect(resolveRepositoryBaseUrl()).toBe('http://10.0.2.2:8788');
    expect(createDefaultSpotlightRepository()).toBeInstanceOf(HttpSpotlightRepository);
  });

  it('prefers the runtime Expo API base URL over the bundled EXPO_PUBLIC fallback in development', () => {
    setNodeEnv('development');
    process.env.EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL = 'https://looty.34.59.188.129.sslip.io///';
    if (!mockedConstants.expoConfig) {
      mockedConstants.expoConfig = { extra: {} };
    }
    mockedConstants.expoConfig.extra = {
      spotlightApiBaseUrl: 'http://192.168.0.225:8788///',
    };

    expect(resolveRepositoryBaseUrls()).toEqual([
      'http://192.168.0.225:8788',
      'https://looty.34.59.188.129.sslip.io',
      DEFAULT_LOCAL_API_BASE_URL,
    ]);
    expect(resolveRepositoryBaseUrl()).toBe('http://192.168.0.225:8788');
  });

  it('keeps the default test runtime deterministic when no API base URL is configured', () => {
    setNodeEnv('test');
    delete process.env.EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL;

    expect(resolveRepositoryBaseUrl()).toBeNull();
    expect(createDefaultSpotlightRepository()).toBeInstanceOf(MockSpotlightRepository);
  });

  it('adds the Expo dev host as a fallback local backend candidate outside test runtime', () => {
    setNodeEnv('development');
    delete process.env.EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL;
    if (!mockedConstants.expoConfig) {
      mockedConstants.expoConfig = { extra: {} };
    }
    mockedConstants.expoConfig.hostUri = '192.168.1.146:8081';

    expect(resolveRepositoryBaseUrls()).toEqual([
      'http://192.168.1.146:8788',
      DEFAULT_LOCAL_API_BASE_URL,
    ]);
  });

  it('uses the Expo extra API base URL in production builds', () => {
    setNodeEnv('production');
    delete process.env.EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL;
    if (!mockedConstants.expoConfig) {
      mockedConstants.expoConfig = { extra: {} };
    }
    mockedConstants.expoConfig.hostUri = '192.168.1.146:8081';
    mockedConstants.expoConfig.extra = {
      spotlightApiBaseUrl: 'https://looty.34.59.188.129.sslip.io///',
    };

    expect(resolveRepositoryBaseUrls()).toEqual(['https://looty.34.59.188.129.sslip.io']);
    expect(createDefaultSpotlightRepository()).toBeInstanceOf(HttpSpotlightRepository);
  });

  it('does not fall back to local backend URLs in production builds', () => {
    setNodeEnv('production');
    delete process.env.EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL;
    if (!mockedConstants.expoConfig) {
      mockedConstants.expoConfig = { extra: {} };
    }
    mockedConstants.expoConfig.hostUri = '192.168.1.146:8081';
    mockedConstants.expoConfig.extra = {};

    expect(resolveRepositoryBaseUrls()).toEqual([]);
    expect(resolveRepositoryBaseUrl()).toBeNull();
    expect(createDefaultSpotlightRepository()).toBeInstanceOf(HttpSpotlightRepository);
  });

  it('does not fall back to local backend URLs in staging app env builds', () => {
    setNodeEnv('development');
    delete process.env.EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL;
    if (!mockedConstants.expoConfig) {
      mockedConstants.expoConfig = { extra: {} };
    }
    mockedConstants.expoConfig.hostUri = '192.168.1.146:8081';
    mockedConstants.expoConfig.extra = {
      spotlightApiBaseUrl: 'https://looty.34.59.188.129.sslip.io///',
      spotlightAppEnv: 'staging',
    };

    expect(resolveRepositoryBaseUrls()).toEqual(['https://looty.34.59.188.129.sslip.io']);
  });

  it('does not fall back to a mock repository in staging app env builds when the API base URL is missing', () => {
    setNodeEnv('development');
    delete process.env.EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL;
    if (!mockedConstants.expoConfig) {
      mockedConstants.expoConfig = { extra: {} };
    }
    mockedConstants.expoConfig.hostUri = '192.168.1.146:8081';
    mockedConstants.expoConfig.extra = {
      spotlightAppEnv: 'staging',
    };

    expect(resolveRepositoryBaseUrls()).toEqual([]);
    expect(createDefaultSpotlightRepository()).toBeInstanceOf(HttpSpotlightRepository);
  });

  it('uses the supplied repository override instead of creating a default client', () => {
    setNodeEnv('test');
    const repositoryOverride = new MockSpotlightRepository();

    render(<RepositoryProbe repositoryOverride={repositoryOverride} />);

    expect(screen.getByText('override')).toBeTruthy();
  });

  it('clears user-scoped caches immediately when the session owner changes', async () => {
    setNodeEnv('test');
    const repository = new MockSpotlightRepository();
    const seedInventory = await repository.getInventoryEntries();
    const seedPortfolio = await repository.getPortfolioDashboard();

    const view = render(
      <AppProviders sessionOwnerKey="user-a">
        <CacheProbe seedInventory={seedInventory} seedPortfolio={seedPortfolio} />
      </AppProviders>,
    );

    await waitFor(() => {
      expect(screen.getByText(/Scorbunny\|/)).toBeTruthy();
    });

    await act(async () => {
      view.rerender(
        <AppProviders sessionOwnerKey="user-b">
          <CacheProbe />
        </AppProviders>,
      );
    });

    expect(screen.getByText('no-inventory|no-dashboard')).toBeTruthy();
  });

  // Isolation must come from the owner key we are PASSED, never from the caller
  // remounting us. `_layout` deliberately keeps ONE tree across the guest mint
  // (an in-flight scan is riding on it), so this rerenders the SAME provider
  // instance — no `key`, no unmount — and the previous account's data still has
  // to be unreachable.
  it('isolates account data on an owner-key change alone, with no remount', async () => {
    setNodeEnv('test');
    const repository = new MockSpotlightRepository();
    const seedInventory = await repository.getInventoryEntries();
    const seedPortfolio = await repository.getPortfolioDashboard();

    const view = render(
      <AppProviders sessionOwnerKey="user-a">
        <CacheProbe seedInventory={seedInventory} seedPortfolio={seedPortfolio} />
        <OwnerScopeProbe />
      </AppProviders>,
    );

    await waitFor(() => {
      expect(screen.getByText(/Scorbunny\|/)).toBeTruthy();
    });

    // Account A picks a collection; it is persisted under A's key.
    await act(async () => {
      screen.getByTestId('choose-collection').props.onPress();
    });
    await waitFor(() => {
      expect(screen.getByText('owner:user-a|collection:collection-a')).toBeTruthy();
    });

    await act(async () => {
      view.rerender(
        <AppProviders sessionOwnerKey="user-b">
          <CacheProbe />
          <OwnerScopeProbe />
        </AppProviders>,
      );
    });

    // Same mounted provider, different owner: no inventory, no dashboard, and
    // the collection scope falls back to "all" rather than inheriting A's.
    expect(screen.getByText('no-inventory|no-dashboard')).toBeTruthy();
    expect(screen.getByText(`owner:user-b|collection:${ALL_COLLECTIONS_ID}`)).toBeTruthy();
  });

  // The warm/refresh inventory read writes into the holdings cache, which is
  // keyed by owner AND collection — so the read itself must carry the active
  // collection. Unscoped, a refreshData() bump (the actions-menu Wishlist
  // toggle) fetched the whole account's cards and wrote them under the scoped
  // key, flooding the on-screen collection with cards that don't belong to it.
  it('scopes the warm inventory read to the active collection, including after refreshData', async () => {
    setNodeEnv('development');
    const repository = new MockSpotlightRepository();
    const loadSpy = jest
      .spyOn(repository, 'loadInventoryEntries')
      .mockResolvedValue({ state: 'empty', data: [], errorMessage: null });

    render(
      <AppProviders sessionOwnerKey="user-a" spotlightRepository={repository}>
        <CollectionRefreshProbe />
      </AppProviders>,
    );

    await waitFor(() => {
      expect(loadSpy).toHaveBeenCalledWith({ collectionID: ALL_COLLECTIONS_ID });
    });

    await act(async () => {
      screen.getByTestId('choose-collection-b').props.onPress();
    });
    await act(async () => {
      screen.getByTestId('refresh-data').props.onPress();
    });

    await waitFor(() => {
      expect(loadSpy).toHaveBeenCalledWith({ collectionID: 'collection-b' });
    });
    // Every read carried a scope — none fell back to the unscoped default.
    expect(loadSpy.mock.calls.every(([query]) => Boolean(query?.collectionID))).toBe(true);

    loadSpy.mockRestore();
  });

  // The guest mint lands a token mid-scan, after the closure that dispatches the
  // request was already built. A snapshot token would send that first guest scan
  // out unauthenticated, so the repository reads the token per request.
  it('reads the access token per request so a mid-flight sign-in still authenticates', async () => {
    setNodeEnv('development');
    process.env.EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL = 'http://example.test';

    const authorizationHeaders: (string | null)[] = [];
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      authorizationHeaders.push(new Headers(init?.headers ?? undefined).get('Authorization'));
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ entries: [] }),
      } as Response;
    }) as typeof fetch;

    try {
      let accessToken: string | null = null;
      const repository = createDefaultSpotlightRepository(() => accessToken);

      await repository.loadInventoryEntries();
      // …the guest scans, the anonymous user is minted, the token lands.
      accessToken = 'minted-anon-token';
      await repository.loadInventoryEntries();

      expect(authorizationHeaders[0]).toBeNull();
      expect(authorizationHeaders[authorizationHeaders.length - 1]).toBe('Bearer minted-anon-token');
    } finally {
      global.fetch = originalFetch;
    }
  });
});
