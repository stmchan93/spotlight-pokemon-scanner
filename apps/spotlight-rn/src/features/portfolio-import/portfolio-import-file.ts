import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';

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

const documentPickerTypes = [
  'text/csv',
  'text/comma-separated-values',
  'text/plain',
  'public.comma-separated-values-text',
  'public.text',
] as const;

async function readTextFromUri(uri: string) {
  let fileReadError: unknown = null;

  try {
    const text = await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.UTF8,
    });

    if (text.trim().length > 0) {
      return text;
    }
  } catch (error) {
    fileReadError = error;
  }

  try {
    const response = await fetch(uri);
    const text = await response.text();

    if (text.trim().length === 0) {
      throw new Error('This file could not be read as a CSV export.');
    }

    return text;
  } catch {
    if (fileReadError instanceof Error) {
      throw fileReadError;
    }

    throw new Error('This file could not be read as a CSV export.');
  }
}

export async function pickPortfolioImportFile(
  sourceType: PortfolioImportSourceType,
): Promise<PortfolioImportSelectedFile | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: documentPickerTypes as unknown as string[],
    copyToCacheDirectory: true,
    multiple: false,
  });

  if (result.canceled) {
    return null;
  }

  const asset = result.assets?.[0];
  if (!asset?.uri) {
    throw new Error('No import file was selected.');
  }

  const csvText = (await readTextFromUri(asset.uri)).replace(/^\uFEFF/, '');

  if (csvText.trim().length === 0) {
    throw new Error('This file could not be read as a CSV export.');
  }

  return {
    sourceType,
    fileName: asset.name?.trim() || 'portfolio-import.csv',
    csvText,
  };
}
