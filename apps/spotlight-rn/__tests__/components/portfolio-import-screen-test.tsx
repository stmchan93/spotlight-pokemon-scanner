import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import type {
  PortfolioImportCandidateRecord,
  PortfolioImportCommitResponsePayload,
  PortfolioImportJobRecord,
} from '@spotlight/api-client';

import { PortfolioImportScreen } from '@/features/portfolio-import/screens/portfolio-import-screen';
import { setPendingPortfolioImportFile } from '@/features/portfolio-import/portfolio-import-session';

import { createTestSpotlightRepository, renderWithProviders } from '../test-utils';

const matchedCandidate: PortfolioImportCandidateRecord = {
  id: 'card-treecko',
  cardId: 'card-treecko',
  name: 'Treecko',
  cardNumber: '#001/096',
  setName: 'Celestial Storm',
  subtitle: null,
  imageUrl: 'https://example.com/treecko.png',
  marketPrice: 0.31,
  currencyCode: 'USD',
  ownedQuantity: 0,
};

const searchCandidate: PortfolioImportCandidateRecord = {
  id: 'card-pikachu',
  cardId: 'card-pikachu',
  name: 'Pikachu Search Match',
  cardNumber: '#058/102',
  setName: 'Base Set',
  subtitle: null,
  imageUrl: 'https://example.com/pikachu.png',
  marketPrice: 1.12,
  currencyCode: 'USD',
  ownedQuantity: 2,
};

function buildPreviewJob(): PortfolioImportJobRecord {
  return {
    id: 'import-job-1',
    sourceType: 'collectr_csv_v1',
    status: 'needs_review',
    sourceFileName: 'collectr.csv',
    summary: {
      totalRowCount: 2,
      matchedCount: 0,
      reviewCount: 1,
      unresolvedCount: 0,
      unsupportedCount: 0,
      readyToCommitCount: 1,
      committedCount: 0,
      skippedCount: 0,
    },
    rows: [
      {
        id: 'row-ready',
        rowIndex: 1,
        sourceCollectionName: 'Collectr Binder',
        sourceCardName: 'Treecko',
        setName: 'Celestial Storm',
        collectorNumber: '#001/096',
        quantity: 2,
        conditionLabel: 'Near Mint',
        currencyCode: 'USD',
        acquisitionUnitPrice: 0.31,
        marketUnitPrice: 0.31,
        matchState: 'ready',
        matchStrategy: 'exact_title_number',
        matchedCard: matchedCandidate,
        candidateCards: [matchedCandidate],
        warnings: [],
        rawSummary: null,
      },
      {
        id: 'row-review',
        rowIndex: 2,
        sourceCollectionName: 'Collectr Binder',
        sourceCardName: 'Pikachu Search Match',
        setName: 'Base Set',
        collectorNumber: '#058/102',
        quantity: 1,
        conditionLabel: 'Near Mint',
        currencyCode: 'USD',
        acquisitionUnitPrice: 1.12,
        marketUnitPrice: 1.12,
        matchState: 'review',
        matchStrategy: 'ambiguous_name',
        matchedCard: null,
        candidateCards: [searchCandidate],
        warnings: ['Multiple candidates found.'],
        rawSummary: null,
      },
    ],
    warnings: [],
    errorText: null,
  };
}

describe('PortfolioImportScreen', () => {
  beforeEach(() => {
    setPendingPortfolioImportFile({
      sourceType: 'collectr_csv_v1',
      fileName: 'collectr.csv',
      csvText: 'name,set\nTreecko,SM7',
    });
  });

  afterEach(() => {
    setPendingPortfolioImportFile(null);
  });

  it('loads the preview and commits ready rows', async () => {
    const previewJob = buildPreviewJob();
    const committedJob: PortfolioImportJobRecord = {
      ...previewJob,
      status: 'completed',
      summary: {
        ...previewJob.summary,
        readyToCommitCount: 0,
        committedCount: 1,
      },
      rows: previewJob.rows.map((row) => (
        row.id === 'row-ready'
          ? { ...row, matchState: 'committed' }
          : row
      )),
    };
    const commitResponse: PortfolioImportCommitResponsePayload = {
      jobID: 'import-job-1',
      status: 'completed',
      summary: committedJob.summary,
      job: committedJob,
      message: 'Imported 1 row.',
    };

    const previewPortfolioImport = jest.fn().mockResolvedValue(previewJob);
    const commitPortfolioImportJob = jest.fn().mockResolvedValue(commitResponse);

    const repository = createTestSpotlightRepository({
      commitPortfolioImportJob,
      previewPortfolioImport,
    });

    renderWithProviders(
      <PortfolioImportScreen onClose={jest.fn()} />,
      { spotlightRepository: repository },
    );

    expect((await screen.findAllByText('Collectr Import')).length).toBeGreaterThan(0);
    expect(screen.getByTestId('portfolio-import-close')).toBeTruthy();
    expect(screen.getByTestId('portfolio-import-refresh')).toBeTruthy();
    expect(screen.getByText('Review Summary')).toBeTruthy();
    expect(screen.getByText('Ready to import')).toBeTruthy();

    fireEvent.press(screen.getByTestId('portfolio-import-commit'));

    await waitFor(() => {
      expect(commitPortfolioImportJob).toHaveBeenCalledWith('import-job-1');
    });

    expect(await screen.findByText('Imported 1 row.')).toBeTruthy();
  });

  it('opens resolve flow and applies a searched catalog match', async () => {
    const previewJob = buildPreviewJob();
    const resolvedJob: PortfolioImportJobRecord = {
      ...previewJob,
      status: 'ready',
      summary: {
        ...previewJob.summary,
        reviewCount: 0,
        readyToCommitCount: 2,
      },
      rows: previewJob.rows.map((row) => (
        row.id === 'row-review'
          ? {
            ...row,
            matchState: 'ready',
            matchedCard: searchCandidate,
            warnings: [],
          }
          : row
      )),
    };

    const previewPortfolioImport = jest.fn().mockResolvedValue(previewJob);
    const resolvePortfolioImportRow = jest.fn().mockResolvedValue(resolvedJob);
    const searchCatalogCards = jest.fn().mockResolvedValue([searchCandidate]);

    const repository = createTestSpotlightRepository({
      previewPortfolioImport,
      resolvePortfolioImportRow,
      searchCatalogCards,
    });

    renderWithProviders(
      <PortfolioImportScreen onClose={jest.fn()} />,
      { spotlightRepository: repository },
    );

    expect(await screen.findByText('Resolve Row')).toBeTruthy();

    fireEvent.press(screen.getByText('Resolve Row'));

    expect(await screen.findByText('Search Results')).toBeTruthy();
    expect(screen.getByTestId('portfolio-import-resolve-close')).toBeTruthy();
    expect(screen.getByTestId('portfolio-import-search-shell')).toBeTruthy();
    expect((await screen.findAllByText('Pikachu Search Match')).length).toBeGreaterThan(0);

    fireEvent.press(screen.getByText('Use'));

    await waitFor(() => {
      expect(resolvePortfolioImportRow).toHaveBeenCalledWith('import-job-1', {
        action: 'match',
        matchedCardID: 'card-pikachu',
        rowID: 'row-review',
      });
    });

    expect(await screen.findByText('Matched row 2 to Pikachu Search Match.')).toBeTruthy();
  });
});
