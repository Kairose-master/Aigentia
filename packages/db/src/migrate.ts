import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Database } from "./client";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Apply SQL migrations from packages/db/drizzle. Safe to run repeatedly. */
export async function migrateDb(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder: path.resolve(here, "../drizzle") });
}
