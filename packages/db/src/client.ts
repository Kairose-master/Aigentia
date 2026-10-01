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
  // An idle client can be dropped by the server (restart, failover, network). pg removes it
  // from the pool and the next query reconnects; without a listener Node would crash instead.
  pool.on("error", (err: Error) => {
    console.warn(`postgres pool: idle client error (${err.message}); it will be replaced`);
  });
  // Postgres bigint → JS bigint for money columns (drizzle mode:"bigint" handles conversion,
  // but we set the type parser so raw sql`` queries are consistent too).
  pg.types.setTypeParser(20, (v: string) => BigInt(v));
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}
