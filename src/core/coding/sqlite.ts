import { Database } from "bun:sqlite";
import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "@earendil-works/pi-durable/storage/sqlite";
import { ensureExtensionCapableSqlite } from "../engine/custom-sqlite.ts";

type Execute = <T>(operation: () => T | Promise<T>) => Promise<T>;

function executor(database: Database, execute: Execute): SqliteExecutor {
  return {
    exec: (sql) => execute(() => { database.exec(sql); }),
    // Finalize statements explicitly. Bun 1.3.14 can leave statements beyond
    // its query cache open, preventing SQLite file cleanup on Windows.
    run: (sql, ...params) => execute(() => {
      using statement = database.prepare<object, SqliteValue[]>(sql);
      statement.run(...params);
    }),
    get: <T extends object>(sql: string, ...params: SqliteValue[]) => execute(() => {
      using statement = database.prepare<T, SqliteValue[]>(sql);
      return statement.get(...params) ?? undefined;
    }),
    all: <T extends object>(sql: string, ...params: SqliteValue[]) => execute(() => {
      using statement = database.prepare<T, SqliteValue[]>(sql);
      return statement.all(...params);
    }),
  };
}

export function openDurableDatabase(path: string): SqliteDatabase {
  ensureExtensionCapableSqlite();
  const database = new Database(path, { strict: true });
  try {
    database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL");
  } catch (error) {
    database.close();
    throw error;
  }

  let tail = Promise.resolve();
  const enqueue: Execute = (operation) => {
    const result = tail.then(operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };

  return {
    ...executor(database, enqueue),
    transaction: (callback) => enqueue(async () => {
      database.exec("BEGIN IMMEDIATE");
      let active = true;
      const transaction = executor(database, async (operation) => {
        if (!active) throw new Error("SQLite transaction handle is no longer active");
        return operation();
      });
      try {
        const result = await callback(transaction);
        database.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          database.exec("ROLLBACK");
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], "SQLite transaction and rollback failed");
        }
        throw error;
      } finally {
        active = false;
      }
    }),
    close: () => enqueue(() => database.close(true)),
  };
}
