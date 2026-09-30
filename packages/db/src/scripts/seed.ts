import { loadEnv } from "@aigentia/shared";
import { createDb } from "../client";
import { seedWorld } from "../seed";

const env = loadEnv();
const handle = createDb(env.DATABASE_URL);
try {
  const summary = await seedWorld(handle.db, {
    seed: env.SIM_SEED,
    ledger: env.SIM_LEDGER,
    tickSeconds: env.TICK_SECONDS,
  });
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await handle.close();
}
