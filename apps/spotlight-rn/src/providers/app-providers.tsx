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
  type SpotlightRepository,
} from '@spotlight/api-client';

import { prefetchCardImages } from '@/lib/card-images';
import { resolveRuntimeValue } from '@/lib/runtime-config';

export const DEFAULT_LOCAL_API_BASE_URL = 'http://127.0.0.1:8788';
const MISSING_PRODUCTION_API_BASE_URL = 'https://spotlight-api-base-url-missing.invalid';

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
  refreshData: () => void;
  inventoryEntriesCache: InventoryCardEntry[] | null;
  setInventoryEntriesCache: Dispatch<SetStateAction<InventoryCardEntry[] | null>>;
  portfolioDashboardCache: PortfolioDashboard | null;
  setPortfolioDashboardCache: Dispatch<SetStateAction<PortfolioDashboard | null>>;
};

const AppServicesContext = createContext<AppServices | null>(null);

type AppProvidersProps = PropsWithChildren<{
  accessToken?: string | null;
  spotlightRepository?: SpotlightRepository | null;
}>;

export function AppProviders({
  accessToken,
  children,
  spotlightRepository: repositoryOverride,
}: AppProvidersProps) {
  const [dataVersion, setDataVersion] = useState(0);
  const [inventoryEntriesCache, setInventoryEntriesCache] = useState<InventoryCardEntry[] | null>(null);
  const [portfolioDashboardCache, setPortfolioDashboardCache] = useState<PortfolioDashboard | null>(null);

  const spotlightRepository = useMemo<SpotlightRepository>(() => {
    return repositoryOverride ?? createDefaultSpotlightRepository(accessToken);
  }, [accessToken, repositoryOverride]);

  const refreshData = useCallback(() => {
    setDataVersion((value) => value + 1);
  }, []);

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
      refreshData,
      inventoryEntriesCache,
      setInventoryEntriesCache,
      portfolioDashboardCache,
      setPortfolioDashboardCache,
    };
  }, [dataVersion, inventoryEntriesCache, portfolioDashboardCache, refreshData, spotlightRepository]);

  return (
    <AppServicesContext.Provider value={services}>
      {children}
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
