import { Alert, Share } from 'react-native';
// GOTCHA (this repo was burned by it — caused 100% scanner image loss): the
// file-system APIs must be imported from 'expo-file-system/legacy'. The new
// 'expo-file-system' entry's stubs typecheck clean but THROW at runtime.
import { cacheDirectory, writeAsStringAsync } from 'expo-file-system/legacy';

import type { SpotlightRepository } from '@spotlight/api-client';

/**
 * Fetch the user's holdings as CSV from the backend, write it to a temp file,
 * and hand it to the OS share sheet (iOS surfaces "Save to Files" here).
 * Owner-scoping is enforced server-side.
 */
export async function exportCollectionCsv(repository: SpotlightRepository): Promise<void> {
  try {
    const csv = await repository.exportDeckEntriesCsv();

    // Empty body or a header-only CSV (no data rows) means there's nothing to
    // export. Split on newlines and drop blank lines to decide.
    const nonEmptyLines = csv
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0);
    if (nonEmptyLines.length <= 1) {
      Alert.alert('Nothing to export', 'Your collection is empty.');
      return;
    }

    const fileUri = `${cacheDirectory}spotlight-collection.csv`;
    await writeAsStringAsync(fileUri, csv, { encoding: 'utf8' });

    await Share.share({ url: fileUri });
  } catch (error) {
    const message =
      error instanceof Error && error.message.trim()
        ? error.message
        : 'Could not export your collection. Please try again.';
    Alert.alert('Export failed', message);
  }
}
