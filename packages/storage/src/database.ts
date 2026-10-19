import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { createRepositories, type StorageRepositories } from './repositories.js';
import * as schema from './schema.js';

export type SqliteStorageOptions = {
  filename: string;
  migrationsFolder?: string;
};

export class SqliteStorage {
  readonly db: BetterSQLite3Database<typeof schema>;
  readonly repositories: StorageRepositories;

  constructor(readonly sqlite: Database.Database) {
    this.db = drizzle(sqlite, { schema });
    this.repositories = createRepositories(sqlite);
  }

  getJournalMode(): string {
    const row = this.sqlite.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    return row.journal_mode;
  }

  close(): void {
    this.sqlite.close();
  }
}

function defaultMigrationsFolder(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  return resolve(moduleDirectory, '..', 'drizzle');
}

export function openSqliteStorage(options: SqliteStorageOptions): SqliteStorage {
  if (options.filename !== ':memory:') {
    mkdirSync(dirname(resolve(options.filename)), { recursive: true });
  }

  const sqlite = new Database(options.filename);
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('busy_timeout = 5000');

  const storage = new SqliteStorage(sqlite);
  migrate(storage.db, {
    migrationsFolder: options.migrationsFolder ?? defaultMigrationsFolder(),
  });

  return storage;
}
