import type { ScanPriceSheetSelection } from '@/features/scanner/screens/scan-price-sheet';
import { applyTrayChanges, loadOwnerTrayRows } from '@/features/scanner/tray-db';
import { trayRowWriteFor, type PersistedCapture } from '@/features/scanner/tray-row-codec';

/** Stores `items` (newest first) as `ownerKey`'s tray, as a previous session would have. */
export async function seedTrayRows(
  ownerKey: string | null,
  items: readonly unknown[],
  priceSelections: Record<string, unknown> = {},
): Promise<void> {
  const rows = (items as PersistedCapture[]).map((item, index) => trayRowWriteFor(
    item,
    (priceSelections[item.id] as ScanPriceSheetSelection | undefined) ?? null,
    items.length - index,
  ));
  await applyTrayChanges(ownerKey, rows, []);
}

/** What the tray DB holds for `ownerKey`, newest first, parsed. */
export async function readTrayRows(ownerKey: string | null): Promise<{
  id: string;
  sortKey: number;
  capture: PersistedCapture;
  priceSelection: ScanPriceSheetSelection | null;
}[]> {
  const rows = (await loadOwnerTrayRows(ownerKey)) ?? [];
  return rows.map((row) => ({
    id: row.id,
    sortKey: row.sortKey,
    capture: JSON.parse(row.captureJson) as PersistedCapture,
    priceSelection: row.priceSelectionJson ? JSON.parse(row.priceSelectionJson) as ScanPriceSheetSelection : null,
  }));
}
