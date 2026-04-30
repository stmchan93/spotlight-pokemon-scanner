import type { ComponentType, PropsWithChildren } from 'react';
import { render } from '@testing-library/react-native';
import { renderRouter } from 'expo-router/testing-library';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as mockApiClient from './mock-api-client';
import {
  MockSpotlightRepository as RealMockSpotlightRepository,
  type SpotlightRepository,
} from './mock-api-client';
import { SpotlightThemeProvider } from '@spotlight/design-system';

import { AppProviders } from '@/providers/app-providers';

jest.mock('@spotlight/api-client', () => mockApiClient);

const safeAreaMetrics = {
  frame: { height: 852, width: 393, x: 0, y: 0 },
  insets: { top: 59, right: 0, bottom: 34, left: 0 },
};

type TestProviderOptions = {
  spotlightRepository?: SpotlightRepository | null;
};

function Providers({
  children,
  spotlightRepository,
}: PropsWithChildren<TestProviderOptions>) {
  return (
    <SafeAreaProvider initialMetrics={safeAreaMetrics}>
      <SpotlightThemeProvider>
        <AppProviders spotlightRepository={spotlightRepository}>{children}</AppProviders>
      </SpotlightThemeProvider>
    </SafeAreaProvider>
  );
}

export function createTestSpotlightRepository(
  overrides: Partial<SpotlightRepository> = {},
): SpotlightRepository {
  const baseRepository = new RealMockSpotlightRepository();

  return {
    loadPortfolioDashboard: (...args) => {
      return overrides.loadPortfolioDashboard?.(...args)
        ?? baseRepository.loadPortfolioDashboard(...args);
    },
    getPortfolioDashboard: (...args) => {
      return overrides.getPortfolioDashboard?.(...args)
        ?? baseRepository.getPortfolioDashboard(...args);
    },
    loadInventoryEntries: (...args) => {
      return overrides.loadInventoryEntries?.(...args)
        ?? baseRepository.loadInventoryEntries(...args);
    },
    getInventoryEntries: (...args) => {
      return overrides.getInventoryEntries?.(...args)
        ?? baseRepository.getInventoryEntries(...args);
    },
    loadCatalogCards: (...args) => {
      return overrides.loadCatalogCards?.(...args)
        ?? baseRepository.loadCatalogCards(...args);
    },
    searchCatalogCards: (...args) => {
      return overrides.searchCatalogCards?.(...args)
        ?? baseRepository.searchCatalogCards(...args);
    },
    matchScannerCapture: (...args) => {
      return overrides.matchScannerCapture?.(...args)
        ?? baseRepository.matchScannerCapture(...args);
    },
    getScannerCandidates: (...args) => {
      return overrides.getScannerCandidates?.(...args)
        ?? baseRepository.getScannerCandidates(...args);
    },
    submitScanFeedback: (...args) => {
      return overrides.submitScanFeedback?.(...args)
        ?? baseRepository.submitScanFeedback(...args);
    },
    loadCardDetail: (...args) => {
      return overrides.loadCardDetail?.(...args)
        ?? baseRepository.loadCardDetail(...args);
    },
    getCardDetail: (...args) => {
      return overrides.getCardDetail?.(...args)
        ?? baseRepository.getCardDetail(...args);
    },
    getCardMarketHistory: (...args) => {
      return overrides.getCardMarketHistory?.(...args)
        ?? baseRepository.getCardMarketHistory(...args);
    },
    getCardEbayListings: (...args) => {
      return overrides.getCardEbayListings?.(...args)
        ?? baseRepository.getCardEbayListings(...args);
    },
    getAddToCollectionOptions: (...args) => {
      return overrides.getAddToCollectionOptions?.(...args)
        ?? baseRepository.getAddToCollectionOptions(...args);
    },
    createInventoryEntry: (...args) => {
      return overrides.createInventoryEntry?.(...args)
        ?? baseRepository.createInventoryEntry(...args);
    },
    createPortfolioBuy: (...args) => {
      return overrides.createPortfolioBuy?.(...args)
        ?? baseRepository.createPortfolioBuy(...args);
    },
    replacePortfolioEntry: (...args) => {
      return overrides.replacePortfolioEntry?.(...args)
        ?? baseRepository.replacePortfolioEntry(...args);
    },
    createPortfolioSale: (...args) => {
      return overrides.createPortfolioSale?.(...args)
        ?? baseRepository.createPortfolioSale(...args);
    },
    createPortfolioSalesBatch: (...args) => {
      return overrides.createPortfolioSalesBatch?.(...args)
        ?? baseRepository.createPortfolioSalesBatch(...args);
    },
    previewPortfolioImport: (...args) => {
      return overrides.previewPortfolioImport?.(...args)
        ?? baseRepository.previewPortfolioImport(...args);
    },
    fetchPortfolioImportJob: (...args) => {
      return overrides.fetchPortfolioImportJob?.(...args)
        ?? baseRepository.fetchPortfolioImportJob(...args);
    },
    resolvePortfolioImportRow: (...args) => {
      return overrides.resolvePortfolioImportRow?.(...args)
        ?? baseRepository.resolvePortfolioImportRow(...args);
    },
    commitPortfolioImportJob: (...args) => {
      return overrides.commitPortfolioImportJob?.(...args)
        ?? baseRepository.commitPortfolioImportJob(...args);
    },
    createLabelingSession: async (...args) => {
      return overrides.createLabelingSession?.(...args)
        ?? baseRepository.createLabelingSession(...args);
    },
    uploadLabelingSessionArtifact: async (...args) => {
      return overrides.uploadLabelingSessionArtifact?.(...args)
        ?? baseRepository.uploadLabelingSessionArtifact(...args);
    },
    completeLabelingSession: async (...args) => {
      return overrides.completeLabelingSession?.(...args)
        ?? baseRepository.completeLabelingSession(...args);
    },
    abortLabelingSession: async (...args) => {
      return overrides.abortLabelingSession?.(...args)
        ?? baseRepository.abortLabelingSession(...args);
    },
  };
}

export function renderWithProviders(
  node: React.ReactElement,
  options: TestProviderOptions = {},
) {
  return render(node, {
    wrapper: ({ children }) => (
      <Providers spotlightRepository={options.spotlightRepository}>{children}</Providers>
    ),
  });
}

export function renderAppRouter(
  initialUrl = '/',
  routeOverrides: Record<string, ComponentType<any>> = {},
) {
  const routeMap: Record<string, ComponentType<any>> = {};
  const routeAliases = new Map<string, string>();

  registerRoute(routeMap, routeAliases, {
    candidates: [
      { key: '_layout', modulePath: '@/app/_layout' },
    ],
  });
  registerRoute(routeMap, routeAliases, {
    candidates: [
      { key: '(tabs)/_layout', modulePath: '@/app/(tabs)/_layout' },
    ],
    optional: true,
  });
  registerRoute(routeMap, routeAliases, {
    candidates: [
      { key: '(stack)/_layout', modulePath: '@/app/(stack)/_layout' },
    ],
    optional: true,
  });
  registerRoute(routeMap, routeAliases, {
    candidates: [
      { key: '(sheet)/_layout', modulePath: '@/app/(sheet)/_layout' },
    ],
    optional: true,
  });
  registerRoute(routeMap, routeAliases, {
    candidates: [
      { key: '(modal)/_layout', modulePath: '@/app/(modal)/_layout' },
    ],
    optional: true,
  });

  registerRoute(routeMap, routeAliases, {
    candidates: [
      { key: '(tabs)/index', modulePath: '@/app/(tabs)/index' },
      { key: 'index', modulePath: '@/app/index' },
    ],
  });
  registerRoute(routeMap, routeAliases, {
    candidates: [
      { key: '(tabs)/portfolio', modulePath: '@/app/(tabs)/portfolio' },
      { key: 'portfolio', modulePath: '@/app/portfolio' },
    ],
  });
  registerRoute(routeMap, routeAliases, {
    candidates: [
      { key: '(stack)/sales-history', modulePath: '@/app/(stack)/sales-history' },
      { key: 'sales-history', modulePath: '@/app/sales-history' },
    ],
  });
  registerRoute(routeMap, routeAliases, {
    candidates: [
      { key: '(tabs)/scan', modulePath: '@/app/(tabs)/scan' },
      { key: 'scan', modulePath: '@/app/scan' },
    ],
    optional: true,
  });
  registerRoute(routeMap, routeAliases, {
    candidates: [
      { key: '(modal)/account', modulePath: '@/app/(modal)/account' },
      { key: 'account', modulePath: '@/app/account' },
    ],
    optional: true,
  });
  registerRoute(routeMap, routeAliases, {
    candidates: [
      { key: '(modal)/account/import', modulePath: '@/app/(modal)/account/import' },
      { key: 'account/import', modulePath: '@/app/account/import' },
    ],
    optional: true,
  });
  registerRoute(routeMap, routeAliases, {
    candidates: [
      {
        key: '(modal)/cards/[cardId]/scan-review',
        modulePath: '@/app/(modal)/cards/[cardId]/scan-review',
      },
      { key: 'cards/[cardId]/scan-review', modulePath: '@/app/cards/[cardId]/scan-review' },
    ],
    optional: true,
  });
  registerRoute(routeMap, routeAliases, {
    candidates: [
      { key: '(stack)/inventory/index', modulePath: '@/app/(stack)/inventory/index' },
      { key: 'inventory/index', modulePath: '@/app/inventory/index' },
    ],
    optional: true,
  });
  registerRoute(routeMap, routeAliases, {
    candidates: [
      { key: '(stack)/cards/[cardId]', modulePath: '@/app/(stack)/cards/[cardId]' },
      { key: 'cards/[cardId]', modulePath: '@/app/cards/[cardId]' },
    ],
    optional: true,
  });
  registerRoute(routeMap, routeAliases, {
    candidates: [
      { key: '(stack)/labeling/session', modulePath: '@/app/(stack)/labeling/session' },
      { key: 'labeling/session', modulePath: '@/app/labeling/session' },
    ],
    optional: true,
  });
  registerRoute(routeMap, routeAliases, {
    candidates: [
      { key: '(sheet)/catalog/search', modulePath: '@/app/(sheet)/catalog/search' },
      { key: 'catalog/search', modulePath: '@/app/catalog/search' },
    ],
    optional: true,
  });
  registerRoute(routeMap, routeAliases, {
    candidates: [
      {
        key: '(sheet)/collection/add/[cardId]',
        modulePath: '@/app/(sheet)/collection/add/[cardId]',
      },
      { key: 'collection/add/[cardId]', modulePath: '@/app/collection/add/[cardId]' },
    ],
    optional: true,
  });
  registerRoute(routeMap, routeAliases, {
    candidates: [
      { key: '(sheet)/sell/[entryId]', modulePath: '@/app/(sheet)/sell/[entryId]' },
      { key: 'sell/[entryId]', modulePath: '@/app/sell/[entryId]' },
    ],
    optional: true,
  });
  registerRoute(routeMap, routeAliases, {
    candidates: [
      { key: '(sheet)/sell/batch', modulePath: '@/app/(sheet)/sell/batch' },
      { key: 'sell/batch', modulePath: '@/app/sell/batch' },
    ],
    optional: true,
  });

  for (const [routeKey, component] of Object.entries(routeOverrides)) {
    routeMap[routeAliases.get(routeKey) ?? routeKey] = component;
  }

  return renderRouter(routeMap, {
    initialUrl,
  });
}

type RouteCandidate = {
  key: string;
  modulePath: string;
};

type RouteRegistration = {
  candidates: RouteCandidate[];
  optional?: boolean;
};

function registerRoute(
  routeMap: Record<string, ComponentType<any>>,
  routeAliases: Map<string, string>,
  registration: RouteRegistration,
) {
  for (const candidate of registration.candidates) {
    const component = tryLoadRouteComponent(candidate.modulePath);
    if (!component) {
      continue;
    }

    routeMap[candidate.key] = component;

    for (const alias of registration.candidates.map((entry) => entry.key)) {
      routeAliases.set(alias, candidate.key);
    }

    return;
  }

  if (!registration.optional) {
    throw new Error(
      `Unable to load route module for any of: ${registration.candidates
        .map((candidate) => candidate.modulePath)
        .join(', ')}`,
    );
  }
}

function tryLoadRouteComponent(modulePath: string): ComponentType<any> | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const module = require(modulePath);
    return module.default ?? module;
  } catch (error) {
    if (
      error instanceof Error
      && (error.message.includes('Cannot find module')
        || error.message.includes('Could not locate module'))
    ) {
      return null;
    }

    throw error;
  }
}
