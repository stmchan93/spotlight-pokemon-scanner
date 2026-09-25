import {
  __resetTrayDbForTests,
  applyTrayChanges,
  importLegacyTrayRows,
  listOwnerTrayRowIds,
  loadOwnerTrayRows,
  TRAY_DB_NAME,
  TRAY_DB_SCHEMA_VERSION,
  type TrayRowWrite,
} from '@/features/scanner/tray-db';

import {
  __dropFakeSQLiteDatabases,
  __fakeSQLiteLog,
  __setFakeSQLiteFault,
  openDatabaseAsync,
} from '../../../test-support/fake-expo-sqlite';

function row(id: string, sortKey: number): TrayRowWrite {
  return {
    id,
    sortKey,
    mode: 'raw',
    normalizedImageUri: `file:///scans/${id}.jpg`,
    sourceImageUri: null,
    binderPageId: null,
    activeCardId: null,
    activeCardName: null,
    captureJson: JSON.stringify({ id }),
    priceSelectionJson: null,
  };
}

describe('tray-db', () => {
  beforeEach(() => {
    __dropFakeSQLiteDatabases();
    __resetTrayDbForTests();
  });

  it('opens in WAL mode and migrates the schema once', async () => {
    await listOwnerTrayRowIds(null);
    const raw = await openDatabaseAsync(TRAY_DB_NAME);
    expect(await raw.getFirstAsync<{ user_version: number }>('PRAGMA user_version')).toEqual({
      user_version: TRAY_DB_SCHEMA_VERSION,
    });
    expect(__fakeSQLiteLog()).toContain('PRAGMA journal_mode = WAL');

    // A second open of the same file runs no migration.
    __resetTrayDbForTests();
    const logLength = __fakeSQLiteLog().length;
    await listOwnerTrayRowIds(null);
    expect(__fakeSQLiteLog().slice(logLength).some((sql) => sql.startsWith('CREATE TABLE'))).toBe(false);
  });

  it('indexes rows by (owner_key, sort_key)', async () => {
    await listOwnerTrayRowIds(null);
    const raw = await openDatabaseAsync(TRAY_DB_NAME);
    const columns = await raw.getAllAsync<{ name: string }>("SELECT name FROM pragma_index_info('scan_tray_rows_owner_sort')");
    expect(columns.map((column) => column.name)).toEqual(['owner_key', 'sort_key']);
  });

  it('upserts by id — writing a row twice never duplicates it', async () => {
    await applyTrayChanges('user-a', [row('a', 1)], []);
    await applyTrayChanges('user-a', [{ ...row('a', 2), captureJson: '{"id":"a","v":2}' }], []);
    const rows = await loadOwnerTrayRows('user-a');
    expect(rows).toEqual([{ id: 'a', sortKey: 2, captureJson: '{"id":"a","v":2}', priceSelectionJson: null }]);
  });

  it('rolls back the whole change set when any statement fails', async () => {
    await applyTrayChanges('user-a', [row('keep', 1)], []);
    __setFakeSQLiteFault((sql) => sql.startsWith('INSERT'));
    await expect(applyTrayChanges('user-a', [row('new', 2)], ['keep'])).rejects.toThrow();
    __setFakeSQLiteFault(null);
    expect([...(await listOwnerTrayRowIds('user-a'))!]).toEqual(['keep']);
  });

  it('deletes are owner-scoped', async () => {
    await applyTrayChanges('user-a', [row('a', 1)], []);
    await applyTrayChanges('user-b', [], ['a']);
    expect([...(await listOwnerTrayRowIds('user-a'))!]).toEqual(['a']);
  });

  it('loading one owner deletes every other owner\'s rows', async () => {
    await applyTrayChanges('user-a', [row('a', 1)], []);
    await applyTrayChanges(null, [row('guest', 1)], []);
    expect((await loadOwnerTrayRows('user-a'))!.map((stored) => stored.id)).toEqual(['a']);
    expect((await listOwnerTrayRowIds(null))!.size).toBe(0);
  });

  it('imports legacy rows once', async () => {
    expect(await importLegacyTrayRows('user-a', [row('a', 1)])).toBe('imported');
    expect(await importLegacyTrayRows('user-a', [row('b', 1)])).toBe('already_imported');
    expect([...(await listOwnerTrayRowIds('user-a'))!]).toEqual(['a']);
  });
});
