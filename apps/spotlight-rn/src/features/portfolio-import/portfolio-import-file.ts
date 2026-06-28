import type { PortfolioImportSourceType } from '@spotlight/api-client';

export type PortfolioImportSelectedFile = {
  sourceType: PortfolioImportSourceType;
  fileName: string;
  csvText: string;
};

type PortfolioImportSourceCopy = {
  title: string;
  subtitle: string;
  buttonTitle: string;
  reviewTitle: string;
};

export const portfolioImportSourceCopy: Record<PortfolioImportSourceType, PortfolioImportSourceCopy> = {
  collectr_csv_v1: {
    title: 'Collectr',
    subtitle: 'Best if your collection already lives in Collectr.',
    buttonTitle: 'Import from Collectr',
    reviewTitle: 'Collectr Import',
  },
  tcgplayer_csv_v1: {
    title: 'TCGplayer',
    subtitle: 'Use your TCGplayer CSV export and review it before import.',
    buttonTitle: 'Import from TCGplayer',
    reviewTitle: 'TCGplayer Import',
  },
};
