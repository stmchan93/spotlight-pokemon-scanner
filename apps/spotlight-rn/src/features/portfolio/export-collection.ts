import { Alert, Share } from 'react-native';
// GOTCHA (this repo was burned by it — caused 100% scanner image loss): the
// file-system APIs must be imported from 'expo-file-system/legacy'. The new
// 'expo-file-system' entry's stubs typecheck clean but THROW at runtime.
import { cacheDirectory, writeAsStringAsync } from 'expo-file-system/legacy';

import type { SpotlightRepository } from '@spotlight/api-client';

// expo-sharing is a NATIVE module added after some shipped binaries were built,
// and OTA'd JS must not crash on them — lazy-require and fall back (same
// pattern as react-native-image-colors). On binaries that have it, it's the
// only path that shares an actual FILE on Android (RN Share's `url` is
// iOS-only; Android's share sheet ignores it, which broke Android export).
type SharingModule = {
  isAvailableAsync: () => Promise<boolean>;
  shareAsync: (
    url: string,
    options?: { mimeType?: string; UTI?: string; dialogTitle?: string },
  ) => Promise<void>;
};
function loadSharingModule(): SharingModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-sharing') as SharingModule;
  } catch {
    return null;
  }
}

/**
 * Fetch the user's holdings as CSV from the backend, write it to a temp file,
 * and hand it to the OS share sheet (iOS surfaces "Save to Files"; Android
 * shows the system share targets). Owner-scoping is enforced server-side.
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

    // Prefer expo-sharing (the only path that shares a real FILE on Android).
    // On an OLDER binary the JS module resolves but its NATIVE side is missing,
    // so isAvailableAsync() itself throws "native module not found" — catch that
    // and fall back rather than surfacing it as an export error. (Android needs a
    // build that includes expo-sharing for real file sharing; iOS's RN Share
    // `url` fallback works.)
    let sharedViaModule = false;
    const sharing = loadSharingModule();
    if (sharing) {
      try {
        if (await sharing.isAvailableAsync()) {
          await sharing.shareAsync(fileUri, {
            mimeType: 'text/csv',
            UTI: 'public.comma-separated-values-text',
            dialogTitle: 'Export collection',
          });
          sharedViaModule = true;
        }
      } catch {
        sharedViaModule = false;
      }
    }
    if (!sharedViaModule) {
      await Share.share({ url: fileUri });
    }
  } catch (error) {
    // Never surface the raw server body (JSON) to the user. After the repository's
    // silent 503 retries, a still-busy backend gets a plain retry prompt; anything
    // else gets a generic message.
    const raw = error instanceof Error ? error.message : '';
    const isServerBusy = /serverbusy|server is busy|busy right now/i.test(raw);
    Alert.alert(
      'Export failed',
      isServerBusy
        ? 'The server is busy right now. Please try again.'
        : 'Could not export your collection. Please try again.',
    );
  }
}
