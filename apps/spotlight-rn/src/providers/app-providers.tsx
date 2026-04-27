import {
  PropsWithChildren,
  createContext,
  useContext,
  useMemo,
  useState,
  useCallback,
} from 'react';
import Constants from 'expo-constants';

import {
  HttpSpotlightRepository,
  MockSpotlightRepository,
  type SpotlightRepository,
} from '@spotlight/api-client';

import { resolveRuntimeValue } from '@/lib/runtime-config';

export const DEFAULT_LOCAL_API_BASE_URL = 'http://127.0.0.1:8788';

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

export function resolveRepositoryBaseUrls() {
  if (process.env.NODE_ENV === 'test') {
    const explicitTestUrl = normalizeBaseUrl(process.env.EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL);
    return explicitTestUrl ? [explicitTestUrl] : [];
  }

  const candidates = [
    normalizeBaseUrl(process.env.EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL),
    normalizeBaseUrl(resolveRuntimeValue([], ['spotlightApiBaseUrl'])),
    resolveDevServerApiBaseUrl(),
    DEFAULT_LOCAL_API_BASE_URL,
  ];

  return candidates.filter((value, index) => {
    return value.length > 0 && candidates.indexOf(value) === index;
  });
}

export function resolveRepositoryBaseUrl() {
  return resolveRepositoryBaseUrls()[0] ?? null;
}

export function createDefaultSpotlightRepository(): SpotlightRepository {
  const repositoryBaseUrls = resolveRepositoryBaseUrls();
  if (repositoryBaseUrls.length > 0) {
    return new HttpSpotlightRepository(repositoryBaseUrls);
  }

  return new MockSpotlightRepository();
}

type AppServices = {
  spotlightRepository: SpotlightRepository;
  dataVersion: number;
  refreshData: () => void;
};

const AppServicesContext = createContext<AppServices | null>(null);

type AppProvidersProps = PropsWithChildren<{
  spotlightRepository?: SpotlightRepository | null;
}>;

export function AppProviders({
  children,
  spotlightRepository: repositoryOverride,
}: AppProvidersProps) {
  const [dataVersion, setDataVersion] = useState(0);

  const spotlightRepository = useMemo<SpotlightRepository>(() => {
    return repositoryOverride ?? createDefaultSpotlightRepository();
  }, [repositoryOverride]);

  const refreshData = useCallback(() => {
    setDataVersion((value) => value + 1);
  }, []);

  const services = useMemo<AppServices>(() => {
    return {
      spotlightRepository,
      dataVersion,
      refreshData,
    };
  }, [dataVersion, refreshData, spotlightRepository]);

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
