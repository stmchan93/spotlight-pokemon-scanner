import { useEffect } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';
import Constants from 'expo-constants';

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
});
