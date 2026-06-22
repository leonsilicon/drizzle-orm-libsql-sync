# drizzle-orm-libsql-sync

A **synchronous** [Drizzle ORM](https://orm.drizzle.team) driver for
[`libsql`](https://github.com/tursodatabase/libsql-js), backed directly by the
libsql `Database` (`prepare`/`exec`) and targeting Drizzle v1's modern relations.

## Why this exists

Drizzle ships two relevant SQLite drivers, but neither fits a sync + libsql +
modern-relations use case:

- **`drizzle-orm/libsql`** is **async** (`await db.execute(...)`). Great for
  Turso over the network, but heavy for serial Node/Bun build scripts, test
  seeding, and benchmarks where every row insert would otherwise be `await`ed.
- **`drizzle-orm/better-sqlite3`** is sync, but it does a top-level
  `import Client from "better-sqlite3"` (forcing that dependency) and historically
  targeted Drizzle's legacy relational system.

This package gives you the missing combination: a real
`BaseSQLiteDatabase<"sync", …>` whose `select()/insert()/...` return rows
directly, bound to a libsql `Database`. libsql is a SQLite superset (more `ALTER`
statements, encryption-at-rest, extensions), so it's a strong local engine for
build/CLI/test code.

> **Note:** This is for **synchronous, local** work (Node/Bun build scripts,
> fixtures, benchmarks). For your app talking to Turso over the network, keep
> using the official async `drizzle-orm/libsql`.

## Install

```bash
npm i drizzle-orm-libsql-sync drizzle-orm libsql
```

`drizzle-orm` and `libsql` are peer dependencies.

## Usage

```ts
import Database from "libsql";
import { drizzle } from "drizzle-orm-libsql-sync";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
});

// Pass a path…
const db = drizzle("file:local.db", { schema: { users } });

// …or an existing libsql client…
const client = new Database(":memory:");
const db2 = drizzle(client, { schema: { users } });

// …or the config-object form:
const db3 = drizzle({ client, schema: { users } });

// Synchronous — no await:
db.insert(users).values({ name: "ada" }).run();
const rows = db.select().from(users).all();
```

### Migrations

```ts
import { migrate } from "drizzle-orm-libsql-sync/migrator";

migrate(db, { migrationsFolder: "./drizzle" });
```

### Transactions

```ts
db.transaction((tx) => {
  tx.insert(users).values({ name: "grace" }).run();
  // throw to roll back; nested transactions use SAVEPOINTs
});
```

## License

MIT
