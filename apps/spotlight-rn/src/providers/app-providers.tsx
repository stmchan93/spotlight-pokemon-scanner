import {
  PropsWithChildren,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useCallback,
  type Dispatch,
  type SetStateAction,
} from 'react';
import Constants from 'expo-constants';

import {
  HttpSpotlightRepository,
  MockSpotlightRepository,
  type InventoryCardEntry,
  type PortfolioDashboard,
  type PortfolioPerformance,
  type SpotlightRepository,
} from '@spotlight/api-client';

import { TabBarChromeProvider } from '@/contexts/tab-bar-chrome-context';
import {
  prependDashboardInventoryEntry,
  prependInventoryEntry,
  removeDashboardInventoryEntries,
  removeInventoryEntries,
} from '@/features/portfolio/optimistic-inventory';
import { prefetchCardImages } from '@/lib/card-images';
import { resolveRuntimeValue } from '@/lib/runtime-config';

export const DEFAULT_LOCAL_API_BASE_URL = 'http://127.0.0.1:8788';
const MISSING_PRODUCTION_API_BASE_URL = 'https://spotlight-api-base-url-missing.invalid';

type ExpoApplicationModule = typeof import('expo-application');

let cachedExpoApplicationModule: ExpoApplicationModule | null | undefined;

function getExpoApplicationModule(): ExpoApplicationModule | null {
  if (cachedExpoApplicationModule !== undefined) {
    return cachedExpoApplicationModule;
  }

  try {
    cachedExpoApplicationModule = require('expo-application') as ExpoApplicationModule;
  } catch {
    cachedExpoApplicationModule = null;
  }

  return cachedExpoApplicationModule;
}

function normalizeBaseUrl(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\/+$/, '') : '';
}

function resolveDevServerApiBaseUrl() {
  const hostUri = normalizeBaseUrl(Constants.expoConfig?.hostUri);
  if (!hostUri) {
    return '';
  }

  try {
    const normalizedHostUrl = hostUri.includes('://') ? hostUri : `http://${hostUri}`;
    const parsed = new URL(normalizedHostUrl);
    const hostname = parsed.hostname.trim();
    if (!hostname) {
      return '';
    }

    return `http://${hostname}:8788`;
  } catch {
    return '';
  }
}

function resolveRepositoryRuntimeAppEnv() {
  return normalizeBaseUrl(resolveRuntimeValue([], ['spotlightAppEnv']));
}

function resolveRepositoryClientContext() {
  const applicationModule = getExpoApplicationModule();
  const configuredBuildNumber = typeof Constants.expoConfig?.ios?.buildNumber === 'string'
    ? Constants.expoConfig.ios.buildNumber
    : typeof Constants.expoConfig?.android?.versionCode === 'number'
      ? String(Constants.expoConfig.android.versionCode)
      : null;

  return {
    appVersion: applicationModule?.nativeApplicationVersion ?? Constants.expoConfig?.version ?? '0',
    buildNumber: applicationModule?.nativeBuildVersion ?? configuredBuildNumber ?? '0',
  };
}

export function resolveRepositoryBaseUrls() {
  if (process.env.NODE_ENV === 'test') {
    const explicitTestUrl = normalizeBaseUrl(process.env.EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL);
    return explicitTestUrl ? [explicitTestUrl] : [];
  }

  const runtimeApiBaseUrl = normalizeBaseUrl(resolveRuntimeValue([], ['spotlightApiBaseUrl']));
  const candidates = [
    runtimeApiBaseUrl,
    normalizeBaseUrl(process.env.EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL),
  ];

  const runtimeAppEnv = resolveRepositoryRuntimeAppEnv();
  if (process.env.NODE_ENV === 'production' || runtimeAppEnv === 'staging' || runtimeAppEnv === 'production') {
    return candidates.filter((value, index) => {
      return value.length > 0 && candidates.indexOf(value) === index;
    });
  }

  const developmentCandidates = [
    ...candidates,
    resolveDevServerApiBaseUrl(),
    DEFAULT_LOCAL_API_BASE_URL,
  ];

  return developmentCandidates.filter((value, index) => {
    return value.length > 0 && developmentCandidates.indexOf(value) === index;
  });
}

export function resolveRepositoryBaseUrl() {
  return resolveRepositoryBaseUrls()[0] ?? null;
}

export function createDefaultSpotlightRepository(accessToken?: string | null): SpotlightRepository {
  const repositoryBaseUrls = resolveRepositoryBaseUrls();
  if (process.env.NODE_ENV !== 'test') {
    console.info(
      `[SPOTLIGHT API] resolvedBaseUrls=${repositoryBaseUrls.length > 0 ? repositoryBaseUrls.join(',') : '<mock>'}`,
    );
  }
  if (repositoryBaseUrls.length > 0) {
    return new HttpSpotlightRepository(repositoryBaseUrls, {
      clientContext: resolveRepositoryClientContext(),
      getAccessToken: () => accessToken ?? null,
    });
  }

  const runtimeAppEnv = resolveRepositoryRuntimeAppEnv();
  if (process.env.NODE_ENV === 'production' || runtimeAppEnv === 'staging' || runtimeAppEnv === 'production') {
    return new HttpSpotlightRepository(MISSING_PRODUCTION_API_BASE_URL);
  }

  return new MockSpotlightRepository();
}

type AppServices = {
  spotlightRepository: SpotlightRepository;
  dataVersion: number;
  /**
   * Stable per-account owner key (Supabase user id, or 'signed-out'/'anonymous').
   * Consumers MUST use this to scope any PERSISTED (AsyncStorage) account data so
   * one account's data can never hydrate another account's session on login.
   */
  sessionOwnerKey: string;
  refreshData: () => void;
  inventoryEntriesCache: InventoryCardEntry[] | null;
  setInventoryEntriesCache: Dispatch<SetStateAction<InventoryCardEntry[] | null>>;
  portfolioDashboardCache: PortfolioDashboard | null;
  setPortfolioDashboardCache: Dispatch<SetStateAction<PortfolioDashboard | null>>;
  /**
   * Last successful Insights performance read, scoped to the active account.
   * Lets the Insights screen paint cached rows on revisit instead of flashing
   * the empty/loading state while the fresh read is in flight.
   */
  portfolioPerformanceCache: PortfolioPerformance | null;
  setPortfolioPerformanceCache: Dispatch<SetStateAction<PortfolioPerformance | null>>;
  /**
   * Optimistically surface a just-added card at the top of the Collection
   * without waiting on the slow portfolio dashboard refetch. Prepends (deduping
   * by id) into both the shared inventory cache and the dashboard cache, and
   * bumps the dashboard summary/count so totals aren't briefly stale. Pass the
   * REAL entry id from the create response so the background refetch reconciles
   * by id (replacing the optimistic row instead of duplicating it).
   */
  prependOptimisticInventoryEntry: (entry: InventoryCardEntry) => void;
  /**
   * Optimistically drop just-deleted cards from the Collection without waiting
   * on the slow portfolio dashboard refetch. Removes the ids (the deck-entry
   * ids) from both the shared inventory cache and the dashboard cache, and
   * decrements the dashboard summary/count so totals aren't briefly stale. The
   * background refetch — which no longer carries the deleted ids — then
   * reconciles to the server truth.
   */
  removeOptimisticInventoryEntries: (ids: string[]) => void;
};

const AppServicesContext = createContext<AppServices | null>(null);

type ScopedCache<T> = {
  ownerKey: string;
  value: T;
};

type AppProvidersProps = PropsWithChildren<{
  accessToken?: string | null;
  sessionOwnerKey?: string | null;
  spotlightRepository?: SpotlightRepository | null;
}>;

export function AppProviders({
  accessToken,
  children,
  sessionOwnerKey,
  spotlightRepository: repositoryOverride,
}: AppProvidersProps) {
  const activeSessionOwnerKey = sessionOwnerKey?.trim() || 'anonymous';
  const [dataVersion, setDataVersion] = useState(0);
  const [inventoryEntriesCacheState, setInventoryEntriesCacheState] = useState<ScopedCache<InventoryCardEntry[]> | null>(null);
  const [portfolioDashboardCacheState, setPortfolioDashboardCacheState] = useState<ScopedCache<PortfolioDashboard> | null>(null);
  const [portfolioPerformanceCacheState, setPortfolioPerformanceCacheState] = useState<ScopedCache<PortfolioPerformance> | null>(null);

  const spotlightRepository = useMemo<SpotlightRepository>(() => {
    return repositoryOverride ?? createDefaultSpotlightRepository(accessToken);
  }, [accessToken, repositoryOverride]);

  const inventoryEntriesCache = useMemo(() => {
    return inventoryEntriesCacheState?.ownerKey === activeSessionOwnerKey
      ? inventoryEntriesCacheState.value
      : null;
  }, [activeSessionOwnerKey, inventoryEntriesCacheState]);

  const portfolioDashboardCache = useMemo(() => {
    return portfolioDashboardCacheState?.ownerKey === activeSessionOwnerKey
      ? portfolioDashboardCacheState.value
      : null;
  }, [activeSessionOwnerKey, portfolioDashboardCacheState]);

  const setInventoryEntriesCache = useCallback<Dispatch<SetStateAction<InventoryCardEntry[] | null>>>((value) => {
    setInventoryEntriesCacheState((current) => {
      const currentValue = current?.ownerKey === activeSessionOwnerKey ? current.value : null;
      const nextValue = typeof value === 'function' ? value(currentValue) : value;
      return nextValue ? { ownerKey: activeSessionOwnerKey, value: nextValue } : null;
    });
  }, [activeSessionOwnerKey]);

  const setPortfolioDashboardCache = useCallback<Dispatch<SetStateAction<PortfolioDashboard | null>>>((value) => {
    setPortfolioDashboardCacheState((current) => {
      const currentValue = current?.ownerKey === activeSessionOwnerKey ? current.value : null;
      const nextValue = typeof value === 'function' ? value(currentValue) : value;
      return nextValue ? { ownerKey: activeSessionOwnerKey, value: nextValue } : null;
    });
  }, [activeSessionOwnerKey]);

  const portfolioPerformanceCache = useMemo(() => {
    return portfolioPerformanceCacheState?.ownerKey === activeSessionOwnerKey
      ? portfolioPerformanceCacheState.value
      : null;
  }, [activeSessionOwnerKey, portfolioPerformanceCacheState]);

  const setPortfolioPerformanceCache = useCallback<Dispatch<SetStateAction<PortfolioPerformance | null>>>((value) => {
    setPortfolioPerformanceCacheState((current) => {
      const currentValue = current?.ownerKey === activeSessionOwnerKey ? current.value : null;
      const nextValue = typeof value === 'function' ? value(currentValue) : value;
      return nextValue ? { ownerKey: activeSessionOwnerKey, value: nextValue } : null;
    });
  }, [activeSessionOwnerKey]);

  const refreshData = useCallback(() => {
    setDataVersion((value) => value + 1);
    // A mutation (PDP edit/add/delete/sale/import/scan-confirm) also makes the
    // Insights performance numbers stale — drop that cache so the Insights page
    // refetches fresh instead of painting the pre-edit snapshot. Every
    // refreshData() caller is a real mutation (never plain navigation), so this
    // won't thrash the cache on ordinary browsing.
    setPortfolioPerformanceCache(null);
  }, [setPortfolioPerformanceCache]);

  const prependOptimisticInventoryEntry = useCallback((entry: InventoryCardEntry) => {
    setInventoryEntriesCache((current) => prependInventoryEntry(current ?? [], entry));
    setPortfolioDashboardCache((current) => (
      current ? prependDashboardInventoryEntry(current, entry) : current
    ));
  }, [setInventoryEntriesCache, setPortfolioDashboardCache]);

  const removeOptimisticInventoryEntries = useCallback((ids: string[]) => {
    if (ids.length === 0) {
      return;
    }
    setInventoryEntriesCache((current) => (current ? removeInventoryEntries(current, ids) : current));
    setPortfolioDashboardCache((current) => (
      current ? removeDashboardInventoryEntries(current, ids) : current
    ));
  }, [setInventoryEntriesCache, setPortfolioDashboardCache]);

  useEffect(() => {
    if (process.env.NODE_ENV === 'test') {
      return undefined;
    }

    let cancelled = false;

    void spotlightRepository.loadInventoryEntries()
      .then((loadResult) => {
        if (!cancelled && loadResult.data && loadResult.state !== 'error') {
          setInventoryEntriesCache(loadResult.data);
          void prefetchCardImages(loadResult.data.slice(0, 12), 'small');
        }
      })
      .catch(() => {
        // Portfolio and inventory screens handle visible loading/error states.
      });

    return () => {
      cancelled = true;
    };
  }, [dataVersion, spotlightRepository]);

  const services = useMemo<AppServices>(() => {
    return {
      spotlightRepository,
      dataVersion,
      sessionOwnerKey: activeSessionOwnerKey,
      refreshData,
      inventoryEntriesCache,
      setInventoryEntriesCache,
      portfolioDashboardCache,
      setPortfolioDashboardCache,
      portfolioPerformanceCache,
      setPortfolioPerformanceCache,
      prependOptimisticInventoryEntry,
      removeOptimisticInventoryEntries,
    };
  }, [
    activeSessionOwnerKey,
    dataVersion,
    inventoryEntriesCache,
    portfolioDashboardCache,
    portfolioPerformanceCache,
    setPortfolioPerformanceCache,
    prependOptimisticInventoryEntry,
    removeOptimisticInventoryEntries,
    refreshData,
    setInventoryEntriesCache,
    setPortfolioDashboardCache,
    spotlightRepository,
  ]);

  return (
    <AppServicesContext.Provider value={services}>
      <TabBarChromeProvider>
        {children}
      </TabBarChromeProvider>
    </AppServicesContext.Provider>
  );
}

export function useAppServices() {
  const context = useContext(AppServicesContext);

  if (!context) {
    throw new Error('useAppServices must be used within AppProviders');
  }

  return context;
}
