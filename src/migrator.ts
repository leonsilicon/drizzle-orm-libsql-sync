// Mirrors `drizzle-orm/better-sqlite3/migrator.ts` — `readMigrationFiles`
// builds the in-memory `MigrationMeta[]` and `migrate(...)` delegates to
// `db.dialect.migrate(...)`, which does the actual schema work (migrations
// table, statement-breakpoint splitting, transactional apply).

import { readMigrationFiles, type MigrationConfig } from "drizzle-orm/migrator";
import type { AnyRelations } from "drizzle-orm";
import type { LibsqlSyncDatabase } from "./driver.ts";

export function migrate<TSchema extends Record<string, unknown>, TRelations extends AnyRelations>(
  db: LibsqlSyncDatabase<TSchema, TRelations>,
  config: MigrationConfig,
): void {
  const migrations = readMigrationFiles(config);
  const dialect = Reflect.get(db, "dialect");
  const session = Reflect.get(db, "session");
  if (typeof dialect !== "object" || dialect === null || !("migrate" in dialect)) {
    throw new TypeError("Database dialect does not expose migrate()");
  }
  const migrateFn = Reflect.get(dialect, "migrate");
  if (typeof migrateFn !== "function") {
    throw new TypeError("Database dialect migrate is not a function");
  }
  Reflect.apply(migrateFn, dialect, [migrations, session, config]);
}
