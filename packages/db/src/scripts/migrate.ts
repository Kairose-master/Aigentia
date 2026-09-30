import { loadEnv } from "@aigentia/shared";
import { createDb } from "../client";
import { migrateDb } from "../migrate";

const env = loadEnv();
const handle = createDb(env.DATABASE_URL);
try {
  await migrateDb(handle.db);
  console.log("migrations applied");
} finally {
  await handle.close();
}
