/*
  The slice of expo-sqlite the scan tray uses, backed by Node's built-in SQLite
  (`node:sqlite`, Node >= 22.5) so every statement runs against a real engine.
  Databases are in-memory and keyed by name, so reopening one sees the same data
  (like reopening the file on device) until a test resets it.
*/

type BindValue = string | number | null;
type NodeStatement = {
  run: (...params: BindValue[]) => { changes: number | bigint; lastInsertRowid: number | bigint };
  all: (...params: BindValue[]) => unknown[];
  get: (...params: BindValue[]) => unknown;
};
type NodeDatabase = {
  exec: (sql: string) => void;
  prepare: (sql: string) => NodeStatement;
  close: () => void;
};
type NodeSqlite = { DatabaseSync: new (path: string) => NodeDatabase };

// Prints one ExperimentalWarning per jest worker on Node 22; harmless.
const nodeSqlite = (process as unknown as { getBuiltinModule: (id: string) => unknown })
  .getBuiltinModule('node:sqlite') as NodeSqlite;
const databases = new Map<string, NodeDatabase>();
const log: string[] = [];
let fault: ((sql: string) => boolean) | null = null;

function databaseNamed(name: string): NodeDatabase {
  let database = databases.get(name);
  if (!database) {
    database = new nodeSqlite.DatabaseSync(':memory:');
    databases.set(name, database);
  }
  return database;
}

function bindParams(params: unknown[]): BindValue[] {
  const flat = params.length === 1 && Array.isArray(params[0]) ? params[0] as unknown[] : params;
  return flat.map((value) => {
    if (value === undefined || value === null) {
      return null;
    }
    if (typeof value === 'boolean') {
      return value ? 1 : 0;
    }
    return value as BindValue;
  });
}

function checkFault(sql: string) {
  log.push(sql.trim());
  if (fault?.(sql)) {
    throw new Error(`fake sqlite fault: ${sql.trim().slice(0, 40)}`);
  }
}

class FakeStatement {
  constructor(private readonly database: NodeDatabase, private readonly sql: string) {}

  async executeAsync(...params: unknown[]) {
    checkFault(this.sql);
    const result = this.database.prepare(this.sql).run(...bindParams(params));
    return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) };
  }

  async finalizeAsync() {}
}

class FakeDatabase {
  constructor(readonly databasePath: string) {}

  private get database() {
    return databaseNamed(this.databasePath);
  }

  async execAsync(sql: string) {
    checkFault(sql);
    this.database.exec(sql);
  }

  async runAsync(sql: string, ...params: unknown[]) {
    checkFault(sql);
    const result = this.database.prepare(sql).run(...bindParams(params));
    return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) };
  }

  async getAllAsync<T>(sql: string, ...params: unknown[]): Promise<T[]> {
    checkFault(sql);
    return this.database.prepare(sql).all(...bindParams(params)) as T[];
  }

  async getFirstAsync<T>(sql: string, ...params: unknown[]): Promise<T | null> {
    checkFault(sql);
    return (this.database.prepare(sql).get(...bindParams(params)) as T | undefined) ?? null;
  }

  async prepareAsync(sql: string) {
    return new FakeStatement(this.database, sql);
  }

  // Mirrors expo-sqlite: BEGIN, task, COMMIT; ROLLBACK and rethrow on failure.
  async withTransactionAsync(task: () => Promise<void>) {
    await this.execAsync('BEGIN');
    try {
      await task();
      await this.execAsync('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  async withExclusiveTransactionAsync(task: (txn: FakeDatabase) => Promise<void>) {
    await this.withTransactionAsync(() => task(this));
  }

  async closeAsync() {}
}

export async function openDatabaseAsync(name: string) {
  return new FakeDatabase(name);
}

/** Empties every table (schema and user_version survive, like a cleared app). */
export function __resetFakeSQLite(): void {
  databases.forEach((database) => {
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    tables.forEach(({ name }) => database.exec(`DELETE FROM "${name}"`));
  });
  log.length = 0;
  fault = null;
}

/** Forgets every database, schema included (a fresh install). */
export function __dropFakeSQLiteDatabases(): void {
  databases.forEach((database) => database.close());
  databases.clear();
  log.length = 0;
  fault = null;
}

/** Throw from any statement the predicate matches, until cleared with null. */
export function __setFakeSQLiteFault(predicate: ((sql: string) => boolean) | null): void {
  fault = predicate;
}

/** Every statement run since the last reset, in order. */
export function __fakeSQLiteLog(): readonly string[] {
  return log;
}
