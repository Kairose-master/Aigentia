import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface DbHandle {
  db: Database;
  pool: pg.Pool;
  close(): Promise<void>;
}

/** Create a pooled Drizzle client. Each app creates exactly one and closes it on shutdown. */
export function createDb(connectionString: string, opts: { max?: number } = {}): DbHandle {
  const pool = new pg.Pool({ connectionString, max: opts.max ?? 10 });
  // Postgres bigint → JS bigint for money columns (drizzle mode:"bigint" handles conversion,
  // but we set the type parser so raw sql`` queries are consistent too).
  pg.types.setTypeParser(20, (v: string) => BigInt(v));
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}
