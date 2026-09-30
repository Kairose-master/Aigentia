#!/usr/bin/env node
/**
 * Record a snapshot of a running Aigentia API for snapshot-mode builds (NEXT_PUBLIC_DATA_MODE=snapshot).
 *
 *   node scripts/export-snapshot.mjs [apiBaseUrl] [outFile]
 *
 * Captures exactly the routes the dashboard pages request, keyed like lib/snapshot.ts
 * (`path?sorted=query`). Nothing is generated or edited: every value is the API's own
 * response, and every payment in it references a real ledger transaction when the source
 * ran on XRPL Testnet. Refuses to export a mock-ledger world unless --allow-mock is given.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const allowMock = process.argv.includes("--allow-mock");
const base = (args[0] ?? "http://localhost:4000").replace(/\/+$/, "");
const out = resolve(
  args[1] ?? new URL("../src/snapshot/testnet-snapshot.json", import.meta.url).pathname,
);
const TRANSACTIONS_PAGE_SIZE = 50; // app/transactions/page.tsx
const EVENTS_LIMIT = 100; // app/page.tsx

function key(path, query = {}) {
  const params = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => [k, String(v)])
    .sort(([a], [b]) => a.localeCompare(b));
  return params.length ? `${path}?${new URLSearchParams(params).toString()}` : path;
}

const responses = {};
async function capture(path, query) {
  const k = key(path, query);
  const res = await fetch(`${base}${k}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${k} → HTTP ${res.status}`);
  const body = await res.json();
  responses[k] = body;
  return body;
}

const stats = await capture("/api/stats");
if (stats.ledger !== "testnet" && !allowMock) {
  console.error(`refusing to export a ${stats.ledger} world as a snapshot (use --allow-mock)`);
  process.exit(1);
}
await capture("/api/world");
await capture("/api/market");
await capture("/api/jobs");
await capture("/api/events", { limit: EVENTS_LIMIT });
const agents = await capture("/api/agents");
for (const a of agents) await capture(`/api/agents/${a.id}`);
const experiments = await capture("/api/experiments");
for (const e of experiments) await capture(`/api/experiments/${e.id}`);
let cursor;
let pages = 0;
do {
  const page = await capture("/api/transactions", { cursor, limit: TRANSACTIONS_PAGE_SIZE });
  cursor = page.nextCursor ?? undefined;
  pages += 1;
} while (cursor && pages < 100);

const snapshot = {
  meta: {
    recordedAt: new Date().toISOString(),
    network: stats.network === "testnet" ? "XRPL Testnet" : stats.network,
    ledger: stats.ledger,
    source: "Aigentia API export (scripts/export-snapshot.mjs)",
    routes: Object.keys(responses).length,
  },
  responses,
};
await mkdir(dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(snapshot));
console.log(
  `snapshot: ${snapshot.meta.routes} routes, ${agents.length} agents, ${experiments.length} experiments, ${pages} transaction pages → ${out}`,
);
