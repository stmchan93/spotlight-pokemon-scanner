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

import { AppDrawerProvider } from '@/providers/app-drawer-provider';
import { AppProviders } from '@/providers/app-providers';
import { AuthProvider } from '@/providers/auth-provider';

jest.mock('@spotlight/api-client', () => mockApiClient);

const safeAreaMetrics = {
  frame: { height: 852, width: 393, x: 0, y: 0 },
  insets: { top: 59, right: 0, bottom: 34, left: 0 },
};

type TestProviderOptions = {
  spotlightRepository?: SpotlightRepository | null;
};

function PassThrough({ children }: PropsWithChildren) {
  return <>{children}</>;
}

// Tests that `jest.mock('@/providers/auth-provider', () => ({ useAuth }))` make
// the real `AuthProvider` undefined — they supply `useAuth` via the mock, so no
// provider is needed. Fall back to a pass-through in that case; tests that don't
// mock the module get the real (test-bypass) AuthProvider so `useGuestGate` /
// `useAuth` resolve.
const AuthWrapper = AuthProvider ?? PassThrough;

function Providers({
  children,
  spotlightRepository,
}: PropsWithChildren<TestProviderOptions>) {
  return (
    <SafeAreaProvider initialMetrics={safeAreaMetrics}>
      <SpotlightThemeProvider>
        <AuthWrapper>
          <AppDrawerProvider>
            <AppProviders spotlightRepository={spotlightRepository}>{children}</AppProviders>
          </AppDrawerProvider>
        </AuthWrapper>
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
    getPortfolioRange: (...args) => {
      return overrides.getPortfolioRange?.(...args)
        ?? baseRepository.getPortfolioRange(...args);
    },
    getPortfolioPerformance: (...args) => {
      return overrides.getPortfolioPerformance?.(...args)
        ?? baseRepository.getPortfolioPerformance(...args);
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
    searchCatalogCardsPage: (...args) => {
      return overrides.searchCatalogCardsPage?.(...args)
        ?? baseRepository.searchCatalogCardsPage(...args);
    },
    matchScannerCapture: (...args) => {
      return overrides.matchScannerCapture?.(...args)
        ?? baseRepository.matchScannerCapture(...args);
    },
    fetchScanCandidates: (...args) => {
      return overrides.fetchScanCandidates?.(...args)
        ?? baseRepository.fetchScanCandidates(...args);
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
    getRawPricingMatrix: (...args) => {
      return overrides.getRawPricingMatrix?.(...args)
        ?? baseRepository.getRawPricingMatrix(...args);
    },
    getCardEbayListings: (...args) => {
      return overrides.getCardEbayListings?.(...args)
        ?? baseRepository.getCardEbayListings(...args);
    },
    getCardRecentSales: (...args) => {
      return overrides.getCardRecentSales?.(...args)
        ?? baseRepository.getCardRecentSales(...args);
    },
    getCardPriceTrends: (...args) => {
      return overrides.getCardPriceTrends?.(...args)
        ?? baseRepository.getCardPriceTrends(...args);
    },
    getCardConditionHistory: (...args) => {
      return overrides.getCardConditionHistory?.(...args)
        ?? baseRepository.getCardConditionHistory(...args);
    },
    setCardFavorite: (...args) => {
      return overrides.setCardFavorite?.(...args)
        ?? baseRepository.setCardFavorite(...args);
    },
    setCardLike: (...args) => {
      return overrides.setCardLike?.(...args)
        ?? baseRepository.setCardLike(...args);
    },
    getCardFavorites: (...args) => {
      return overrides.getCardFavorites?.(...args)
        ?? baseRepository.getCardFavorites(...args);
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
    deletePortfolioEntry: (...args) => {
      return overrides.deletePortfolioEntry?.(...args)
        ?? baseRepository.deletePortfolioEntry(...args);
    },
    deletePortfolioEntriesBulk: (...args) => {
      return overrides.deletePortfolioEntriesBulk?.(...args)
        ?? baseRepository.deletePortfolioEntriesBulk(...args);
    },
    deleteAccount: (...args) => {
      return overrides.deleteAccount?.(...args)
        ?? baseRepository.deleteAccount(...args);
    },
    exportDeckEntriesCsv: (...args) => {
      return overrides.exportDeckEntriesCsv?.(...args)
        ?? baseRepository.exportDeckEntriesCsv(...args);
    },
    setPortfolioEntryQuantity: (...args) => {
      return overrides.setPortfolioEntryQuantity?.(...args)
        ?? baseRepository.setPortfolioEntryQuantity(...args);
    },
    updateDeckEntryCostBasis: (...args) => {
      return overrides.updateDeckEntryCostBasis?.(...args)
        ?? baseRepository.updateDeckEntryCostBasis(...args);
    },
    createPortfolioSale: (...args) => {
      return overrides.createPortfolioSale?.(...args)
        ?? baseRepository.createPortfolioSale(...args);
    },
    createPortfolioSalesBatch: (...args) => {
      return overrides.createPortfolioSalesBatch?.(...args)
        ?? baseRepository.createPortfolioSalesBatch(...args);
    },
    createCardTransaction: (...args) => {
      return overrides.createCardTransaction?.(...args)
        ?? baseRepository.createCardTransaction(...args);
    },
    listCardTransactions: (...args) => {
      return overrides.listCardTransactions?.(...args)
        ?? baseRepository.listCardTransactions(...args);
    },
    loadTransactionInsights: (...args) => {
      return overrides.loadTransactionInsights?.(...args)
        ?? baseRepository.loadTransactionInsights(...args);
    },
    markSalePaid: (...args) => {
      return overrides.markSalePaid?.(...args)
        ?? baseRepository.markSalePaid(...args);
    },
    voidSale: (...args) => {
      return overrides.voidSale?.(...args)
        ?? baseRepository.voidSale(...args);
    },
    getVendorWalletHandles: (...args) => {
      return overrides.getVendorWalletHandles?.(...args)
        ?? baseRepository.getVendorWalletHandles(...args);
    },
    updateVendorWalletHandles: (...args) => {
      return overrides.updateVendorWalletHandles?.(...args)
        ?? baseRepository.updateVendorWalletHandles(...args);
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
    listExpansions: async (...args) => {
      return overrides.listExpansions?.(...args)
        ?? baseRepository.listExpansions(...args);
    },
    listCardsInExpansion: async (...args) => {
      return overrides.listCardsInExpansion?.(...args)
        ?? baseRepository.listCardsInExpansion(...args);
    },
    getAccessStatus: (...args) => {
      return overrides.getAccessStatus?.(...args)
        ?? baseRepository.getAccessStatus(...args);
    },
    redeemInviteCode: (...args) => {
      return overrides.redeemInviteCode?.(...args)
        ?? baseRepository.redeemInviteCode(...args);
    },
    joinAccessWaitlist: (...args) => {
      return overrides.joinAccessWaitlist?.(...args)
        ?? baseRepository.joinAccessWaitlist(...args);
    },
    setCardShowMode: (...args) => {
      return overrides.setCardShowMode?.(...args)
        ?? baseRepository.setCardShowMode(...args);
    },
    getAccessWhitelist: (...args) => {
      return overrides.getAccessWhitelist?.(...args)
        ?? baseRepository.getAccessWhitelist(...args);
    },
    addAccessWhitelistEmail: (...args) => {
      return overrides.addAccessWhitelistEmail?.(...args)
        ?? baseRepository.addAccessWhitelistEmail(...args);
    },
    removeAccessWhitelistEmail: (...args) => {
      return overrides.removeAccessWhitelistEmail?.(...args)
        ?? baseRepository.removeAccessWhitelistEmail(...args);
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
