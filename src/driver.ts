// Synchronous drizzle driver for the `libsql` package, modeled on drizzle's
// `drizzle-orm/better-sqlite3` driver but synchronous and backed by a libsql
// `Database`.
//
// drizzle-orm's bundled `drizzle-orm/better-sqlite3` driver (a) does a
// top-level `import Client from "better-sqlite3"`, forcing better-sqlite3 into
// the install, and (b) historically targeted drizzle's legacy relational
// system. This driver targets drizzle v1's modern relations and binds to a
// libsql `Database`, taking the `{ client, … }` config-object form.

import LibsqlDatabaseCtor from "libsql";
import type { Database as LibsqlDatabaseInstance } from "libsql";
import {
  DefaultLogger,
  entityKind,
  type AnyRelations,
  type DrizzleConfig,
  type EmptyRelations,
  type Logger,
} from "drizzle-orm";
import * as V1 from "drizzle-orm/_relations";
import { BaseSQLiteDatabase, SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { toDrizzleSyncSQLiteClient } from "./client.ts";
import { LibsqlSyncSession, type LibsqlSyncRunResult } from "./session.ts";

function isAnyObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRelationsConfig<TRelations extends AnyRelations>(value: unknown): value is TRelations {
  return isAnyObject(value);
}

function isExtractedSchemaTables<TSchema extends Record<string, unknown>>(
  value: unknown,
): value is V1.ExtractTablesWithRelations<TSchema> {
  return isAnyObject(value);
}

/** Config-object form accepted by the call sites. */
export type LibsqlSyncDrizzleConfig<
  TSchema extends Record<string, unknown>,
  TRelations extends AnyRelations,
> = DrizzleConfig<TSchema, TRelations> & { client: LibsqlDatabaseInstance };

export class LibsqlSyncDatabase<
  TSchema extends Record<string, unknown> = Record<string, never>,
  TRelations extends AnyRelations = EmptyRelations,
> extends BaseSQLiteDatabase<"sync", LibsqlSyncRunResult, TSchema, TRelations> {
  static override readonly [entityKind]: string = "LibsqlSyncDatabase";

  declare $client: LibsqlDatabaseInstance;
}

function construct<
  TSchema extends Record<string, unknown> = Record<string, never>,
  TRelations extends AnyRelations = EmptyRelations,
>(
  client: LibsqlDatabaseInstance,
  drizzleConfig: DrizzleConfig<TSchema, TRelations> = {},
): LibsqlSyncDatabase<TSchema, TRelations> & {
  $client: LibsqlDatabaseInstance;
} {
  const sqliteClient = toDrizzleSyncSQLiteClient(client);
  const dialect = new SQLiteSyncDialect();

  let logger: Logger | undefined;
  if (drizzleConfig.logger === true) {
    logger = new DefaultLogger();
  } else if (drizzleConfig.logger !== false) {
    logger = drizzleConfig.logger;
  }

  let schema: V1.RelationalSchemaConfig<V1.ExtractTablesWithRelations<TSchema>> | undefined;
  if (drizzleConfig.schema) {
    const tablesConfig = V1.extractTablesRelationalConfig(
      drizzleConfig.schema,
      V1.createTableRelationsHelpers,
    );
    if (!isExtractedSchemaTables<TSchema>(tablesConfig.tables)) {
      throw new TypeError("Invalid relational schema tables config");
    }
    schema = {
      fullSchema: drizzleConfig.schema,
      schema: tablesConfig.tables,
      tableNamesMap: tablesConfig.tableNamesMap,
    };
  }

  const relations = drizzleConfig.relations ?? {};
  if (!isRelationsConfig<TRelations>(relations)) {
    throw new TypeError("Invalid drizzle relations config");
  }

  const session = new LibsqlSyncSession<
    TSchema,
    TRelations,
    V1.ExtractTablesWithRelations<TSchema>
  >(sqliteClient, dialect, relations, schema, { logger });
  const db = new LibsqlSyncDatabase<TSchema, TRelations>(
    "sync",
    dialect,
    session,
    relations,
    schema,
  );
  db.$client = sqliteClient;
  return db as LibsqlSyncDatabase<TSchema, TRelations> & {
    $client: LibsqlDatabaseInstance;
  };
}

function isLibsqlSyncDrizzleConfig<
  TSchema extends Record<string, unknown>,
  TRelations extends AnyRelations,
>(value: unknown): value is LibsqlSyncDrizzleConfig<TSchema, TRelations> {
  return isAnyObject(value) && "client" in value && isAnyObject(Reflect.get(value, "client"));
}

function drizzleImpl<
  TSchema extends Record<string, unknown> = Record<string, never>,
  TRelations extends AnyRelations = EmptyRelations,
>(
  ...params:
    | [string]
    | [string, DrizzleConfig<TSchema, TRelations>]
    | [LibsqlDatabaseInstance]
    | [LibsqlDatabaseInstance, DrizzleConfig<TSchema, TRelations>]
    | [LibsqlSyncDrizzleConfig<TSchema, TRelations>]
): LibsqlSyncDatabase<TSchema, TRelations> & {
  $client: LibsqlDatabaseInstance;
} {
  const [first, second] = params;

  // drizzle("file:./db.sqlite") | drizzle("file:./db.sqlite", config)
  if (typeof first === "string") {
    const client = new LibsqlDatabaseCtor(first);
    return construct(client, second as DrizzleConfig<TSchema, TRelations>);
  }

  // drizzle({ client, …config })
  if (isLibsqlSyncDrizzleConfig<TSchema, TRelations>(first)) {
    const { client, ...drizzleConfig } = first;
    return construct(client, drizzleConfig);
  }

  // drizzle(client) | drizzle(client, config)
  return construct(first as LibsqlDatabaseInstance, second as DrizzleConfig<TSchema, TRelations>);
}

/**
 * Mirrors `drizzle-orm/better-sqlite3`'s `drizzle.mock` — an in-memory libsql
 * database, handy for type-only fixtures and tests that never touch a real
 * connection.
 */
function mock<
  TSchema extends Record<string, unknown> = Record<string, never>,
  TRelations extends AnyRelations = EmptyRelations,
>(config?: DrizzleConfig<TSchema, TRelations>): LibsqlSyncDatabase<TSchema, TRelations> {
  return construct(new LibsqlDatabaseCtor(":memory:"), config);
}

export const drizzle: typeof drizzleImpl & { mock: typeof mock } = Object.assign(drizzleImpl, {
  mock,
});
