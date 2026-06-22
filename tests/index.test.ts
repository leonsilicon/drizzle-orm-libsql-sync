import { expect, test } from "vite-plus/test";
import Database from "libsql";
import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { drizzle } from "../src/index.ts";

const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
});

function makeDb() {
  const client = new Database(":memory:");
  const db = drizzle(client, { schema: { users } });
  db.run(sql`create table users (id integer primary key autoincrement, name text not null)`);
  return db;
}

test("drizzle(client) returns a synchronous database", () => {
  const db = makeDb();
  db.insert(users).values({ name: "ada" }).run();
  const rows = db.select().from(users).all();
  expect(rows).toEqual([{ id: 1, name: "ada" }]);
});

test("get() returns a single row or undefined", () => {
  const db = makeDb();
  db.insert(users)
    .values([{ name: "grace" }, { name: "linus" }])
    .run();
  const found = db
    .select()
    .from(users)
    .where(sql`name = 'grace'`)
    .get();
  expect(found).toEqual({ id: 1, name: "grace" });
  const missing = db
    .select()
    .from(users)
    .where(sql`name = 'nobody'`)
    .get();
  expect(missing).toBeUndefined();
});

test("transaction() commits and rolls back synchronously", () => {
  const db = makeDb();
  db.transaction((tx) => {
    tx.insert(users).values({ name: "committed" }).run();
  });
  expect(db.select().from(users).all()).toHaveLength(1);

  expect(() =>
    db.transaction((tx) => {
      tx.insert(users).values({ name: "rolled-back" }).run();
      throw new Error("boom");
    }),
  ).toThrow("boom");
  expect(db.select().from(users).all()).toHaveLength(1);
});

test("drizzle.mock() builds without a real connection", () => {
  const db = drizzle.mock({ schema: { users } });
  expect(db).toBeDefined();
});
