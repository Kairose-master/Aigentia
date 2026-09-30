import { sql } from "drizzle-orm";
import { loadEnv } from "@aigentia/shared";
import { createDb } from "../client";
import { migrateDb } from "../migrate";

/** Drops and recreates the public schema, then re-applies migrations. Development only. */
const env = loadEnv();
if (env.NODE_ENV === "production") throw new Error("refusing to reset a production database");
const handle = createDb(env.DATABASE_URL);
try {
  await handle.db.execute(sql`DROP SCHEMA public CASCADE`);
  await handle.db.execute(sql`CREATE SCHEMA public`);
  await handle.db.execute(sql`DROP SCHEMA IF EXISTS drizzle CASCADE`);
  await migrateDb(handle.db);
  console.log("database reset");
} finally {
  await handle.close();
}
