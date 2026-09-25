import AsyncStorage from '@react-native-async-storage/async-storage';

import type { ScanPriceSheetSelection } from './screens/scan-price-sheet';
import { importLegacyTrayRows } from './tray-db';
import {
  isPersistedCapture,
  isPersistedPriceSelection,
  trayRowWriteFor,
  type PersistedCapture,
} from './tray-row-codec';

/*
  One-time move of the pre-SQLite tray (a single AsyncStorage JSON blob) into
  the tray DB. Delete this file once every install has launched a SQLite build.
*/

export const LEGACY_TRAY_STORAGE_KEY = '@spotlight/scanner/recent-captures';
export const LEGACY_TRAY_ENVELOPE_VERSION = 1;

type LegacyTrayEnvelope = {
  version: number;
  // Absent on envelopes written before owner stamping; adopted by whoever loads first.
  ownerKey?: string | null;
  items: PersistedCapture[];
  priceSelections?: Record<string, ScanPriceSheetSelection>;
};

/** 'pending' = the blob is still there and still holds rows we could not import. */
export type LegacyTrayMigrationResult = 'none' | 'migrated' | 'discarded' | 'pending';

function normalizeOwnerKey(ownerKey: string | null | undefined): string | null {
  const trimmed = (ownerKey ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseEnvelope(raw: string): LegacyTrayEnvelope | null {
  try {
    const parsed = JSON.parse(raw) as LegacyTrayEnvelope | null;
    if (parsed && parsed.version === LEGACY_TRAY_ENVELOPE_VERSION && Array.isArray(parsed.items)) {
      return parsed;
    }
  } catch {
    // Corrupt JSON is discarded below, same as the old loader did.
  }
  return null;
}

async function removeBlob(): Promise<boolean> {
  try {
    await AsyncStorage.removeItem(LEGACY_TRAY_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * Imports the blob for `ownerKey`, then deletes it — only after the import
 * committed. Safe to re-run after a kill at any point: the rows and an
 * "imported" marker commit together, so a leftover blob is just deleted.
 * Owner policy is the old loader's: a blob stamped for another account is
 * dropped unread; an unstamped one is adopted.
 */
export async function migrateLegacyTrayBlob(ownerKey: string | null): Promise<LegacyTrayMigrationResult> {
  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(LEGACY_TRAY_STORAGE_KEY);
  } catch {
    return 'pending';
  }
  if (!raw) {
    return 'none';
  }
  const envelope = parseEnvelope(raw);
  if (!envelope || (envelope.ownerKey !== undefined && normalizeOwnerKey(envelope.ownerKey) !== ownerKey)) {
    return (await removeBlob()) ? 'discarded' : 'pending';
  }

  const items = envelope.items.filter(isPersistedCapture);
  const selections = envelope.priceSelections && typeof envelope.priceSelections === 'object'
    ? envelope.priceSelections
    : {};
  const rows = items.map((item, index) => {
    const selection = selections[item.id];
    return trayRowWriteFor(
      item,
      isPersistedPriceSelection(selection) ? selection : null,
      items.length - index,
    );
  });
  let outcome: Awaited<ReturnType<typeof importLegacyTrayRows>>;
  try {
    outcome = await importLegacyTrayRows(ownerKey, rows);
  } catch {
    return 'pending';
  }
  if (outcome == null) {
    // No DB in this binary: keep the blob for the build that has one.
    return 'pending';
  }
  // Rows are committed; a failed delete is retried next launch and imports nothing.
  await removeBlob();
  return 'migrated';
}
