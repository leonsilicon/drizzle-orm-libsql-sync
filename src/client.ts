// Minimal synchronous SQLite client surface used by `LibsqlSyncSession`.
//
// A libsql `Database` already exposes the synchronous `prepare`/`exec` calls
// the session needs, so this is a thin structural type plus a runtime guard —
// no wrapping required.

import type { Database as LibsqlDatabase } from "libsql";

export type DrizzleSyncSQLiteBindValue = null | string | number | bigint | boolean | Uint8Array;

/** The libsql `Database` surface the sync session relies on. */
export type DrizzleSyncSQLiteClient = LibsqlDatabase;

export function isDrizzleSyncSQLiteClient(value: unknown): value is DrizzleSyncSQLiteClient {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return (
    typeof Reflect.get(value, "prepare") === "function" &&
    typeof Reflect.get(value, "exec") === "function"
  );
}

export function toDrizzleSyncSQLiteClient(value: unknown): DrizzleSyncSQLiteClient {
  if (!isDrizzleSyncSQLiteClient(value)) {
    throw new TypeError("Expected a libsql-compatible synchronous SQLite client.");
  }
  return value;
}
