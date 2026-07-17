import { Alert } from 'react-native';

import { getDocumentAsync } from 'expo-document-picker';
// IMPORTANT: read APIs MUST come from 'expo-file-system/legacy'. The new
// 'expo-file-system' entry exposes stubs that typecheck but throw at runtime
// (this previously caused 100% scanner source-image loss). Do not "simplify"
// this import back to 'expo-file-system'.
import { readAsStringAsync } from 'expo-file-system/legacy';

import type { PortfolioImportSourceType } from '@spotlight/api-client';

import type { PortfolioImportSelectedFile } from './portfolio-import-file';
import { setPendingPortfolioImportFile } from './portfolio-import-session';

/**
 * Present the system document picker, read the chosen CSV, and stage it for the
 * portfolio-import review screen.
 *
 * Returns `true` when a file was picked, read, and staged (the caller should
 * then navigate to the review screen). Returns `false` when the user cancels or
 * when the file could not be read (a user-facing Alert is shown on read error).
 */
export async function pickAndStageImportFile(
  sourceType: PortfolioImportSourceType,
): Promise<boolean> {
  let result;
  try {
    result = await getDocumentAsync({
      type: [
        'text/csv',
        'text/comma-separated-values',
        'public.comma-separated-values-text',
        '*/*',
      ],
      copyToCacheDirectory: true,
      multiple: false,
    });
  } catch {
    Alert.alert('Could not read file', 'The file picker could not be opened. Please try again.');
    return false;
  }

  if (result.canceled || !result.assets || result.assets.length === 0) {
    return false;
  }

  const asset = result.assets[0];

  try {
    const csvText = await readAsStringAsync(asset.uri, { encoding: 'utf8' });
    const file: PortfolioImportSelectedFile = {
      sourceType,
      fileName: asset.name ?? 'import.csv',
      csvText,
    };
    setPendingPortfolioImportFile(file);
    return true;
  } catch {
    Alert.alert(
      'Could not read file',
      'We were unable to read that file. Make sure it is a CSV export and try again.',
    );
    return false;
  }
}
