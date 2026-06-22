// Synchronous drizzle session for the `libsql` package, modeled on drizzle's
// `BetterSQLiteSession` but synchronous and bound directly to libsql's
// `Database` (`prepare().all()/.get()/.run()/.raw()`).
//
// drizzle-orm's bundled `BetterSQLiteSession` (a) does a top-level
// `import Client from "better-sqlite3"`, forcing better-sqlite3 into the
// install, and (b) in older lines targeted the legacy (4-generic) relational
// system. This session targets the modern `SQLiteSession<'sync', …,
// TFullSchema, TRelations, TSchema>` shape used by drizzle v1 and binds to a
// libsql `Database` instead of better-sqlite3.

import type * as V1 from "drizzle-orm/_relations";
import {
  entityKind,
  fillPlaceholders,
  is,
  makeJitQueryMapper,
  makeJitRqbMapper,
  NoopLogger,
  sql,
  type AnyRelations,
  type DrizzleTypeError,
  type Logger,
  type Query,
  type RelationalQueryMapperConfig,
} from "drizzle-orm";
import * as drizzleRuntime from "drizzle-orm";
import type { WithCacheConfig } from "drizzle-orm/cache/core/types";
import {
  SQLitePreparedQuery,
  SQLiteSession,
  SQLiteTransaction,
  type PreparedQueryConfig as PreparedQueryConfigBase,
  type SQLiteSyncDialect,
  type SQLiteExecuteMethod,
  type SQLiteTransactionConfig,
  type SelectedFieldsOrdered,
} from "drizzle-orm/sqlite-core";
import { type DrizzleSyncSQLiteBindValue, type DrizzleSyncSQLiteClient } from "./client.ts";

function isAnyObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

/**
 * Sync one-shot memoizer for the `drizzle-orm` runtime export lookups below.
 * Avoids a `let cached…` module singleton while keeping the lookup off the hot
 * path.
 */
function onetime<T>(fn: () => T): () => T {
  let called = false;
  let value: T;
  return () => {
    if (!called) {
      value = fn();
      called = true;
    }
    return value;
  };
}

function getDrizzleRuntimeFunction<T extends (...args: never[]) => unknown>(
  exportName: string,
  validate: (value: unknown) => value is T,
): T {
  const value = Reflect.get(drizzleRuntime, exportName);
  if (!validate(value)) {
    throw new TypeError(`drizzle-orm is missing runtime export: ${exportName}`);
  }
  return value;
}

const getMapResultRow = onetime(() =>
  getDrizzleRuntimeFunction(
    "mapResultRow",
    (
      value,
    ): value is (
      columns: SelectedFieldsOrdered,
      row: unknown[],
      joinsNotNullableMap: Record<string, boolean> | undefined,
    ) => unknown => typeof value === "function",
  ),
);

function isSqliteBindValue(value: unknown): value is DrizzleSyncSQLiteBindValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean" ||
    value instanceof Uint8Array
  );
}

function toSqliteBindValues(params: unknown[]): DrizzleSyncSQLiteBindValue[] {
  const bindValues: DrizzleSyncSQLiteBindValue[] = [];
  for (const param of params) {
    if (!isSqliteBindValue(param)) {
      throw new TypeError(`Invalid SQLite bind value: ${JSON.stringify(param)}`);
    }
    bindValues.push(param);
  }
  return bindValues;
}

function isRecordBooleanMap(value: unknown): value is Record<string, boolean> | undefined {
  if (value === undefined) {
    return true;
  }
  if (!isPlainObject(value)) {
    return false;
  }
  return Object.values(value).every((entry) => typeof entry === "boolean");
}

function isSQLiteSyncDialect(value: unknown): value is SQLiteSyncDialect {
  return isAnyObject(value) && "sqlToQuery" in value;
}

interface PreparedQueryInternals {
  joinsNotNullableMap: Record<string, boolean> | undefined;
}

function getPreparedQueryInternals(
  instance: SQLitePreparedQuery<PreparedQueryConfigBase>,
): PreparedQueryInternals {
  // NOTE: drizzle's base `queryWithCache` is `async`, so it always returns a
  // Promise — unusable from a synchronous driver. This driver deliberately does
  // NOT cache (the result-cache layer is async by design), so we run the SQLite
  // work directly instead of routing it through `queryWithCache`.
  const joinsNotNullableMap = Reflect.get(instance, "joinsNotNullableMap");
  if (!isRecordBooleanMap(joinsNotNullableMap)) {
    throw new TypeError("Prepared query is missing joinsNotNullableMap");
  }
  return { joinsNotNullableMap };
}

function getSQLiteSyncDialect(instance: object): SQLiteSyncDialect {
  const dialect = Reflect.get(instance, "dialect");
  if (!isSQLiteSyncDialect(dialect)) {
    throw new TypeError("Missing SQLite sync dialect");
  }
  return dialect;
}

// An always-true predicate that narrows an already-correctly-typed runtime
// value to its compile-time `T` at the boundary, keeping the dead-`throw`
// branches below as defensive guards without an `as` cast at each call site.
function isPreparedQueryResult<T>(value: unknown): value is T {
  void value;
  return true;
}

function isRqbV2CustomResultMapper(
  mapper: unknown,
  isRqbV2: boolean | undefined,
): mapper is (rows: Record<string, unknown>[]) => unknown {
  return isRqbV2 === true && typeof mapper === "function";
}

function isLibsqlSyncSessionFor<
  TFullSchema extends Record<string, unknown>,
  TRelations extends AnyRelations,
  TSchema extends V1.TablesRelationalConfig,
>(value: unknown): value is LibsqlSyncSession<TFullSchema, TRelations, TSchema> {
  return is(value, LibsqlSyncSession);
}

function getSelectedFields(fields: SelectedFieldsOrdered | undefined): SelectedFieldsOrdered {
  if (fields === undefined) {
    throw new TypeError("Expected selected fields to be defined");
  }
  return fields;
}

function getRelationalQueryMapperConfig(
  config: RelationalQueryMapperConfig | undefined,
): RelationalQueryMapperConfig {
  if (config === undefined) {
    throw new TypeError("Expected relational query mapper config to be defined");
  }
  return config;
}

export interface LibsqlSyncSessionOptions {
  logger?: Logger;
  useJitMappers?: boolean;
}

export interface LibsqlSyncRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

type PreparedQueryConfig = Omit<PreparedQueryConfigBase, "statement" | "run">;

export class LibsqlSyncSession<
  TFullSchema extends Record<string, unknown>,
  TRelations extends AnyRelations,
  TSchema extends V1.TablesRelationalConfig,
> extends SQLiteSession<"sync", LibsqlSyncRunResult, TFullSchema, TRelations, TSchema> {
  static override readonly [entityKind]: string = "LibsqlSyncSession";

  private logger: Logger;

  constructor(
    private client: DrizzleSyncSQLiteClient,
    dialect: SQLiteSyncDialect,
    private relations: TRelations,
    private schema: V1.RelationalSchemaConfig<TSchema> | undefined,
    private options: LibsqlSyncSessionOptions = {},
  ) {
    super(dialect);
    this.logger = options.logger ?? new NoopLogger();
  }

  override prepareQuery<T extends Omit<PreparedQueryConfig, "run">>(
    query: Query,
    fields: SelectedFieldsOrdered | undefined,
    executeMethod: SQLiteExecuteMethod,
    customResultMapper?: (
      rows: unknown[][],
      mapColumnValue?: (value: unknown) => unknown,
    ) => unknown,
    queryMetadata?: {
      tables: string[];
      type: "select" | "update" | "delete" | "insert";
    },
    // Accepted to match the base signature; this sync session does not cache.
    _cacheConfig?: WithCacheConfig,
  ): LibsqlSyncPreparedQuery<T> {
    return new LibsqlSyncPreparedQuery<T>(
      this.client,
      query,
      this.logger,
      queryMetadata,
      fields,
      executeMethod,
      this.options.useJitMappers,
      customResultMapper,
    );
  }

  override prepareRelationalQuery<T extends Omit<PreparedQueryConfig, "run">>(
    query: Query,
    fields: SelectedFieldsOrdered | undefined,
    executeMethod: SQLiteExecuteMethod,
    customResultMapper: (
      rows: Record<string, unknown>[],
      mapColumnValue?: (value: unknown) => unknown,
    ) => unknown,
    config: RelationalQueryMapperConfig,
  ): LibsqlSyncPreparedQuery<T, true> {
    return new LibsqlSyncPreparedQuery<T, true>(
      this.client,
      query,
      this.logger,
      undefined,
      fields,
      executeMethod,
      this.options.useJitMappers,
      customResultMapper,
      true,
      config,
    );
  }

  override transaction<T>(
    transaction: (tx: LibsqlSyncTransaction<TFullSchema, TRelations, TSchema>) => T,
    config: SQLiteTransactionConfig = {},
  ): T {
    const dialect = getSQLiteSyncDialect(this);
    const tx = new LibsqlSyncTransaction<TFullSchema, TRelations, TSchema>(
      "sync",
      dialect,
      this,
      this.relations,
      this.schema,
    );
    this.run(sql.raw(`begin${config.behavior ? " " + config.behavior : ""}`));
    try {
      const result = transaction(tx);
      this.run(sql`commit`);
      return result;
    } catch (error) {
      this.run(sql`rollback`);
      throw error;
    }
  }
}

export class LibsqlSyncTransaction<
  TFullSchema extends Record<string, unknown>,
  TRelations extends AnyRelations,
  TSchema extends V1.TablesRelationalConfig,
> extends SQLiteTransaction<"sync", LibsqlSyncRunResult, TFullSchema, TRelations, TSchema> {
  static override readonly [entityKind]: string = "LibsqlSyncTransaction";

  override transaction<T>(
    transaction: (
      tx: LibsqlSyncTransaction<TFullSchema, TRelations, TSchema>,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- must match drizzle's base `T extends Promise<any>` guard exactly
    ) => T extends Promise<any>
      ? DrizzleTypeError<"Sync drivers can't use async functions in transactions!">
      : T,
  ): T {
    const dialect = getSQLiteSyncDialect(this);
    const sessionValue = Reflect.get(this, "session");
    if (!isLibsqlSyncSessionFor<TFullSchema, TRelations, TSchema>(sessionValue)) {
      throw new TypeError("Expected LibsqlSyncSession");
    }
    const savepointName = `sp${this.nestedIndex}`;
    const tx = new LibsqlSyncTransaction<TFullSchema, TRelations, TSchema>(
      "sync",
      dialect,
      sessionValue,
      this.relations,
      this.schema,
      this.nestedIndex + 1,
    );
    sessionValue.run(sql.raw(`savepoint ${savepointName}`));
    try {
      // The callback's static return is the `T extends Promise<any> ? … : T`
      // guard; at runtime a sync callback yields `T`.
      const result = transaction(tx) as T;
      sessionValue.run(sql.raw(`release savepoint ${savepointName}`));
      return result;
    } catch (error) {
      sessionValue.run(sql.raw(`rollback to savepoint ${savepointName}`));
      throw error;
    }
  }
}

export class LibsqlSyncPreparedQuery<
  T extends PreparedQueryConfig = PreparedQueryConfig,
  TIsRqbV2 extends boolean = false,
> extends SQLitePreparedQuery<{
  all: T["all"];
  execute: T["execute"];
  get: T["get"];
  run: LibsqlSyncRunResult;
  type: "sync";
  values: T["values"];
}> {
  static override readonly [entityKind]: string = "LibsqlSyncPreparedQuery";

  private jitRowMapper?: ReturnType<typeof makeJitQueryMapper<T["all"]>>;
  private jitRqbMapper?: ReturnType<typeof makeJitRqbMapper<T["all"]>>;

  constructor(
    private client: DrizzleSyncSQLiteClient,
    query: Query,
    private logger: Logger,
    queryMetadata:
      | { tables: string[]; type: "select" | "update" | "delete" | "insert" }
      | undefined,
    private fields: SelectedFieldsOrdered | undefined,
    executeMethod: SQLiteExecuteMethod,
    private useJitMappers: boolean | undefined,
    private customResultMapper?: (
      rows: TIsRqbV2 extends true ? Record<string, unknown>[] : unknown[][],
    ) => unknown,
    private isRqbV2Query?: TIsRqbV2,
    private rqbConfig?: RelationalQueryMapperConfig,
  ) {
    super("sync", executeMethod, query, undefined, queryMetadata, undefined);
  }

  override run(placeholderValues?: Record<string, unknown>): LibsqlSyncRunResult {
    const params = fillPlaceholders(this.query.params, placeholderValues ?? {});
    this.logger.logQuery(this.query.sql, params);
    const info = this.client.prepare(this.query.sql).run(...toSqliteBindValues(params));
    return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
  }

  override all(placeholderValues?: Record<string, unknown>): T["all"] {
    if (this.isRqbV2Query) {
      return this.allRqbV2(placeholderValues);
    }
    const internals = getPreparedQueryInternals(this);
    const { client, customResultMapper, fields, logger, query } = this;
    const { joinsNotNullableMap } = internals;
    if (!fields && !customResultMapper) {
      const params = fillPlaceholders(query.params, placeholderValues ?? {});
      logger.logQuery(query.sql, params);
      const result = client.prepare(query.sql).all(...toSqliteBindValues(params)) as T["all"];
      if (isPreparedQueryResult<T["all"]>(result)) {
        return result;
      }
      throw new TypeError("Unexpected prepared query result");
    }
    const rows = this.values(placeholderValues);
    if (!Array.isArray(rows)) {
      throw new TypeError("Expected values() to return row arrays");
    }
    if (customResultMapper) {
      const mapped = customResultMapper(rows);
      if (isPreparedQueryResult<T["all"]>(mapped)) {
        return mapped;
      }
      throw new TypeError("Unexpected custom result mapper output");
    }
    const fieldsDefined = getSelectedFields(fields);
    if (this.useJitMappers) {
      const mapper =
        this.jitRowMapper ?? makeJitQueryMapper<T["all"]>(fieldsDefined, joinsNotNullableMap);
      this.jitRowMapper = mapper;
      const mapped = mapper(rows);
      if (isPreparedQueryResult<T["all"]>(mapped)) {
        return mapped;
      }
      throw new TypeError("Unexpected JIT mapper output");
    }
    const mapped = rows.map((row) => {
      if (!Array.isArray(row)) {
        throw new TypeError("Expected each row to be an array");
      }
      return getMapResultRow()(fieldsDefined, row, joinsNotNullableMap);
    });
    if (isPreparedQueryResult<T["all"]>(mapped)) {
      return mapped;
    }
    throw new TypeError("Unexpected mapped query result");
  }

  private allRqbV2(placeholderValues?: Record<string, unknown>): T["all"] {
    const { client, customResultMapper, logger, query } = this;
    const params = fillPlaceholders(query.params, placeholderValues ?? {});
    logger.logQuery(query.sql, params);
    const rows = client.prepare(query.sql).all(...toSqliteBindValues(params)) as Record<
      string,
      unknown
    >[];
    const rqbConfig = getRelationalQueryMapperConfig(this.rqbConfig);
    if (this.useJitMappers) {
      const mapper = this.jitRqbMapper ?? makeJitRqbMapper<T["all"]>(rqbConfig);
      this.jitRqbMapper = mapper;
      const mapped = mapper(rows);
      if (isPreparedQueryResult<T["all"]>(mapped)) {
        return mapped;
      }
      throw new TypeError("Unexpected RQB JIT mapper output");
    }
    if (!isRqbV2CustomResultMapper(customResultMapper, this.isRqbV2Query)) {
      throw new TypeError("Expected custom result mapper for RQB v2 query");
    }
    const mapped = customResultMapper(rows);
    if (isPreparedQueryResult<T["all"]>(mapped)) {
      return mapped;
    }
    throw new TypeError("Unexpected RQB custom result mapper output");
  }

  override get(placeholderValues?: Record<string, unknown>): T["get"] {
    if (this.isRqbV2Query) {
      return this.getRqbV2(placeholderValues);
    }
    const internals = getPreparedQueryInternals(this);
    const { client, customResultMapper, fields, logger, query } = this;
    const { joinsNotNullableMap } = internals;
    const params = fillPlaceholders(query.params, placeholderValues ?? {});
    logger.logQuery(query.sql, params);
    if (!fields && !customResultMapper) {
      const rawRow = client.prepare(query.sql).get(...toSqliteBindValues(params));
      const row = (rawRow ?? undefined) as T["get"] | undefined;
      if (row === undefined || row === null) {
        return undefined as T["get"];
      }
      if (isPreparedQueryResult<T["get"]>(row)) {
        return row;
      }
      throw new TypeError("Unexpected prepared query row");
    }
    const rows = this.values(placeholderValues);
    if (!Array.isArray(rows)) {
      throw new TypeError("Expected values() to return row arrays");
    }
    const row = rows[0];
    if (!row) {
      return undefined as T["get"];
    }
    if (customResultMapper) {
      const mapped = customResultMapper(rows);
      if (isPreparedQueryResult<T["get"]>(mapped)) {
        return mapped;
      }
      throw new TypeError("Unexpected custom result mapper output");
    }
    const fieldsDefined = getSelectedFields(fields);
    if (this.useJitMappers) {
      const mapper =
        this.jitRowMapper ?? makeJitQueryMapper<T["get"]>(fieldsDefined, joinsNotNullableMap);
      this.jitRowMapper = mapper;
      const mappedRows = mapper([row]);
      if (!Array.isArray(mappedRows)) {
        throw new TypeError("Expected JIT mapper to return an array");
      }
      const mapped = mappedRows[0];
      if (mapped === undefined) {
        return undefined as T["get"];
      }
      if (isPreparedQueryResult<T["get"]>(mapped)) {
        return mapped;
      }
      throw new TypeError("Unexpected JIT mapper row");
    }
    if (!Array.isArray(row)) {
      throw new TypeError("Expected row to be an array");
    }
    const mapped = getMapResultRow()(fieldsDefined, row, joinsNotNullableMap);
    if (isPreparedQueryResult<T["get"]>(mapped)) {
      return mapped;
    }
    throw new TypeError("Unexpected mapped query row");
  }

  private getRqbV2(placeholderValues?: Record<string, unknown>): T["get"] {
    const { client, customResultMapper, logger, query } = this;
    const params = fillPlaceholders(query.params, placeholderValues ?? {});
    logger.logQuery(query.sql, params);
    const rows = client.prepare(query.sql).all(...toSqliteBindValues(params)) as Record<
      string,
      unknown
    >[];
    const row = rows[0];
    if (!row) {
      return undefined as T["get"];
    }
    const rqbConfig = getRelationalQueryMapperConfig(this.rqbConfig);
    if (this.useJitMappers) {
      const mapper = this.jitRqbMapper ?? makeJitRqbMapper<T["get"]>(rqbConfig);
      this.jitRqbMapper = mapper;
      const mapped = mapper(rows);
      if (isPreparedQueryResult<T["get"]>(mapped)) {
        return mapped;
      }
      throw new TypeError("Unexpected RQB JIT mapper output");
    }
    if (!isRqbV2CustomResultMapper(customResultMapper, this.isRqbV2Query)) {
      throw new TypeError("Expected custom result mapper for RQB v2 query");
    }
    const mapped = customResultMapper([row]);
    if (isPreparedQueryResult<T["get"]>(mapped)) {
      return mapped;
    }
    throw new TypeError("Unexpected RQB custom result mapper output");
  }

  override values(placeholderValues?: Record<string, unknown>): T["values"] {
    const params = fillPlaceholders(this.query.params, placeholderValues ?? {});
    this.logger.logQuery(this.query.sql, params);
    const stmt = this.client.prepare(this.query.sql);
    const toggled: unknown = stmt.raw(true);
    let result: T["values"];
    try {
      result = (toggled as typeof stmt).all(...toSqliteBindValues(params)) as T["values"];
    } finally {
      stmt.raw(false);
    }
    if (isPreparedQueryResult<T["values"]>(result)) {
      return result;
    }
    throw new TypeError("Unexpected prepared query values");
  }
}
