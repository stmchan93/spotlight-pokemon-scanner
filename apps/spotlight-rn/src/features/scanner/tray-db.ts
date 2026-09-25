import type { SQLiteDatabase } from 'expo-sqlite';

import { loadTraySQLite } from './tray-sqlite-module';

/*
  The scan tray's on-device store: one row per capture, owner-scoped. Kept thin
  on purpose — SQL in, plain records out; what a row means lives in
  `tray-row-codec.ts` and when to write lives in `recent-captures-persistence.ts`.

  Every call goes through one FIFO queue, so the single connection's
  BEGIN/COMMIT can never pick up a stray statement from another caller, and a
  load always sees the writes queued before it.
*/

export const TRAY_DB_NAME = 'scan-tray.db';

// Ordered and append-only: entry i upgrades user_version i -> i + 1. Never edit
// a shipped entry; add a new one.
const SCHEMA_MIGRATIONS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS scan_tray_rows (
    id TEXT PRIMARY KEY NOT NULL,
    owner_key TEXT NOT NULL,
    sort_key REAL NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    mode TEXT NOT NULL,
    normalized_image_uri TEXT,
    source_image_uri TEXT,
    binder_page_id TEXT,
    active_card_id TEXT,
    active_card_name TEXT,
    capture_json TEXT NOT NULL,
    price_selection_json TEXT
  );
  CREATE INDEX IF NOT EXISTS scan_tray_rows_owner_sort ON scan_tray_rows (owner_key, sort_key);
  CREATE TABLE IF NOT EXISTS scan_tray_meta (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
  );`,
];

export const TRAY_DB_SCHEMA_VERSION = SCHEMA_MIGRATIONS.length;

// Set in the same transaction as the legacy rows, so a re-run after a crash
// knows the import already landed.
const LEGACY_IMPORTED_META_KEY = 'legacy_async_storage_tray_imported';

// SQLite's bound-parameter limit is far higher; this keeps statements small.
const DELETE_CHUNK_SIZE = 500;

export type TrayRowWrite = {
  id: string;
  /** Display order: higher is nearer the top. */
  sortKey: number;
  mode: string;
  normalizedImageUri: string | null;
  sourceImageUri: string | null;
  binderPageId: string | null;
  activeCardId: string | null;
  activeCardName: string | null;
  /** The full capture, every candidate included. */
  captureJson: string;
  priceSelectionJson: string | null;
};

export type TrayRowRead = {
  id: string;
  sortKey: number;
  captureJson: string;
  priceSelectionJson: string | null;
};

// Signed out is a real owner (null); '' can never be a real key because owner
// keys are trimmed and empty ones normalize to null.
function ownerColumn(ownerKey: string | null): string {
  return ownerKey ?? '';
}

let dbPromise: Promise<SQLiteDatabase | null> | null = null;
let queue: Promise<unknown> = Promise.resolve();

async function migrateSchema(db: SQLiteDatabase): Promise<void> {
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  for (let version = row?.user_version ?? 0; version < SCHEMA_MIGRATIONS.length; version += 1) {
    await db.withTransactionAsync(async () => {
      await db.execAsync(SCHEMA_MIGRATIONS[version]);
      await db.execAsync(`PRAGMA user_version = ${version + 1}`);
    });
  }
}

async function openTrayDb(): Promise<SQLiteDatabase | null> {
  const sqlite = loadTraySQLite();
  if (!sqlite) {
    return null;
  }
  try {
    const db = await sqlite.openDatabaseAsync(TRAY_DB_NAME);
    await db.execAsync('PRAGMA journal_mode = WAL');
    await migrateSchema(db);
    return db;
  } catch {
    // Best-effort: an unopenable DB leaves the tray in memory for this session.
    return null;
  }
}

/** Runs `op` after every earlier call. Resolves null when there is no DB. */
function enqueue<T>(op: (db: SQLiteDatabase) => Promise<T>): Promise<T | null> {
  const run = queue.then(async () => {
    dbPromise ??= openTrayDb();
    const db = await dbPromise;
    return db ? op(db) : null;
  });
  queue = run.catch(() => undefined);
  return run;
}

const UPSERT_SQL = `INSERT INTO scan_tray_rows (
    id, owner_key, sort_key, created_at, updated_at, mode, normalized_image_uri,
    source_image_uri, binder_page_id, active_card_id, active_card_name,
    capture_json, price_selection_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    owner_key = excluded.owner_key,
    sort_key = excluded.sort_key,
    updated_at = excluded.updated_at,
    mode = excluded.mode,
    normalized_image_uri = excluded.normalized_image_uri,
    source_image_uri = excluded.source_image_uri,
    binder_page_id = excluded.binder_page_id,
    active_card_id = excluded.active_card_id,
    active_card_name = excluded.active_card_name,
    capture_json = excluded.capture_json,
    price_selection_json = excluded.price_selection_json`;

async function upsertRows(db: SQLiteDatabase, owner: string, rows: readonly TrayRowWrite[]): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  const now = Date.now();
  const statement = await db.prepareAsync(UPSERT_SQL);
  try {
    for (const row of rows) {
      await statement.executeAsync(
        row.id,
        owner,
        row.sortKey,
        now,
        now,
        row.mode,
        row.normalizedImageUri,
        row.sourceImageUri,
        row.binderPageId,
        row.activeCardId,
        row.activeCardName,
        row.captureJson,
        row.priceSelectionJson,
      );
    }
  } finally {
    await statement.finalizeAsync();
  }
}

async function deleteRows(db: SQLiteDatabase, owner: string, ids: readonly string[]): Promise<void> {
  for (let start = 0; start < ids.length; start += DELETE_CHUNK_SIZE) {
    const chunk = ids.slice(start, start + DELETE_CHUNK_SIZE);
    await db.runAsync(
      `DELETE FROM scan_tray_rows WHERE owner_key = ? AND id IN (${chunk.map(() => '?').join(', ')})`,
      owner,
      ...chunk,
    );
  }
}

/**
 * The owner's rows, newest first. Every OTHER owner's rows are deleted first:
 * the tray belongs to one account at a time, and an account switch starts from
 * an empty tray rather than ever showing the previous account's scans.
 */
export function loadOwnerTrayRows(ownerKey: string | null): Promise<TrayRowRead[] | null> {
  const owner = ownerColumn(ownerKey);
  return enqueue(async (db) => {
    await db.runAsync('DELETE FROM scan_tray_rows WHERE owner_key != ?', owner);
    return db.getAllAsync<TrayRowRead>(
      `SELECT id, sort_key AS sortKey, capture_json AS captureJson, price_selection_json AS priceSelectionJson
       FROM scan_tray_rows WHERE owner_key = ? ORDER BY sort_key DESC`,
      owner,
    );
  });
}

/** Upserts and deletes in ONE transaction. Resolves false without a DB; rejects if the write failed. */
export async function applyTrayChanges(
  ownerKey: string | null,
  upserts: readonly TrayRowWrite[],
  deleteIds: readonly string[],
): Promise<boolean> {
  const owner = ownerColumn(ownerKey);
  const result = await enqueue(async (db) => {
    await db.withTransactionAsync(async () => {
      await deleteRows(db, owner, deleteIds);
      await upsertRows(db, owner, upserts);
    });
    return true;
  });
  return result === true;
}

/** Clear All: every row of this owner, one statement. */
export async function clearOwnerTrayRows(ownerKey: string | null): Promise<boolean> {
  const owner = ownerColumn(ownerKey);
  const result = await enqueue(async (db) => {
    await db.runAsync('DELETE FROM scan_tray_rows WHERE owner_key = ?', owner);
    return true;
  });
  return result === true;
}

export function listOwnerTrayRowIds(ownerKey: string | null): Promise<Set<string> | null> {
  const owner = ownerColumn(ownerKey);
  return enqueue(async (db) => {
    const rows = await db.getAllAsync<{ id: string }>('SELECT id FROM scan_tray_rows WHERE owner_key = ?', owner);
    return new Set(rows.map((row) => row.id));
  });
}

/**
 * One-time import of the old AsyncStorage tray. Rows and the "imported" marker
 * commit together; a second call (blob delete never landed) imports nothing.
 */
export function importLegacyTrayRows(
  ownerKey: string | null,
  rows: readonly TrayRowWrite[],
): Promise<'imported' | 'already_imported' | null> {
  const owner = ownerColumn(ownerKey);
  return enqueue(async (db) => {
    let outcome: 'imported' | 'already_imported' = 'imported';
    await db.withTransactionAsync(async () => {
      const marker = await db.getFirstAsync<{ value: string }>(
        'SELECT value FROM scan_tray_meta WHERE key = ?',
        LEGACY_IMPORTED_META_KEY,
      );
      if (marker) {
        outcome = 'already_imported';
        return;
      }
      await upsertRows(db, owner, rows);
      await db.runAsync(
        'INSERT INTO scan_tray_meta (key, value) VALUES (?, ?)',
        LEGACY_IMPORTED_META_KEY,
        String(Date.now()),
      );
    });
    return outcome;
  });
}

export function __resetTrayDbForTests(): void {
  dbPromise = null;
  queue = Promise.resolve();
}
