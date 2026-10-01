#!/usr/bin/env node
/**
 * Process supervisor for the single-container Railway deployment.
 *
 *   1. validate the configuration and fail fast with a readable message
 *   2. apply database migrations
 *   3. start the x402 payment service (127.0.0.1 only) and wait until healthy
 *   4. start the API on $PORT and wait until healthy (this also creates and faucet-funds the
 *      treasury wallet on first boot, before any other process can race it)
 *   5. start the worker (simulation ticks, ledger indexing, experiment deadlines)
 *
 * If any process exits, everything is stopped and the container exits non-zero so Railway
 * restarts it. SIGTERM/SIGINT are forwarded for a graceful shutdown.
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const env = { ...process.env };

// Railway injects PORT and, once a domain is generated, RAILWAY_PUBLIC_DOMAIN.
env.API_PORT = env.PORT ?? env.API_PORT ?? "4000";
if (!env.API_PUBLIC_URL && env.RAILWAY_PUBLIC_DOMAIN) {
  env.API_PUBLIC_URL = `https://${env.RAILWAY_PUBLIC_DOMAIN}`;
}
env.X402_SERVICE_PORT ??= "8402";
env.X402_SERVICE_URL ??= `http://127.0.0.1:${env.X402_SERVICE_PORT}`;

// LOG_LEVEL is shared: Node uses pino names, the Python service expects logging names.
const PY_LOG_LEVEL = {
  fatal: "CRITICAL",
  error: "ERROR",
  warn: "WARNING",
  info: "INFO",
  debug: "DEBUG",
  trace: "DEBUG",
  silent: "CRITICAL",
};
const pythonEnv = {
  ...env,
  LOG_LEVEL: PY_LOG_LEVEL[(env.LOG_LEVEL ?? "info").toLowerCase()] ?? "INFO",
};

const log = (msg, extra = {}) =>
  console.log(
    JSON.stringify({ name: "supervisor", time: new Date().toISOString(), msg, ...extra }),
  );

function fail(msg) {
  console.error(JSON.stringify({ name: "supervisor", level: "error", msg }));
  process.exit(1);
}

// ── 1. configuration ──────────────────────────────────────────────────────────
const problems = [];
for (const key of ["DATABASE_URL", "REDIS_URL", "ADMIN_TOKEN", "X402_SERVICE_TOKEN"]) {
  if (!env[key]) problems.push(`${key} is not set`);
}
for (const key of ["ADMIN_TOKEN", "X402_SERVICE_TOKEN"]) {
  if (env[key] && (env[key].startsWith("change-me") || env[key].length < 24)) {
    problems.push(`${key} must be a long random value (24+ characters), not a placeholder`);
  }
}
if (!env.API_PUBLIC_URL) {
  problems.push(
    "API_PUBLIC_URL is not set and no RAILWAY_PUBLIC_DOMAIN exists (generate a domain)",
  );
}
if (
  env.XRPL_WALLET_PROVIDER !== "env" &&
  env.NODE_ENV === "production" &&
  env.XRPL_FILE_WALLET_ACK !== "testnet-only"
) {
  problems.push(
    "XRPL_WALLET_PROVIDER=file stores Testnet seeds on the volume: set XRPL_FILE_WALLET_ACK=testnet-only to accept that",
  );
}
if (problems.length > 0) fail(`configuration incomplete:\n  - ${problems.join("\n  - ")}`);
if (env.XRPL_WALLET_PROVIDER !== "env") {
  mkdirSync(dirname(env.XRPL_WALLET_FILE ?? "/data/wallets.json"), {
    recursive: true,
    mode: 0o700,
  });
}

// ── helpers ───────────────────────────────────────────────────────────────────
const children = new Map();
let stopping = false;

function bin(dir, name) {
  return resolve(root, dir, "node_modules/.bin", name);
}

function start(name, command, args, cwd, childEnv = env) {
  // Never spawn once shutdown began: a late API + worker pair would race on the treasury.
  if (stopping) throw new Error(`not starting ${name}: shutting down`);
  const child = spawn(command, args, { cwd: resolve(root, cwd), env: childEnv, stdio: "inherit" });
  children.set(name, child);
  child.on("exit", (code, signal) => {
    children.delete(name);
    if (stopping) return;
    log("process exited; stopping the container so it restarts", { process: name, code, signal });
    shutdown(1);
  });
  log("started", { process: name, pid: child.pid });
  return child;
}

function run(name, command, args, cwd) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: resolve(root, cwd), env, stdio: "inherit" });
    child.on("exit", (code) =>
      code === 0 ? resolveRun() : rejectRun(new Error(`${name} exited with code ${code}`)),
    );
  });
}

async function waitHealthy(name, url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (stopping) throw new Error(`stopped while waiting for ${name}`);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        log("healthy", { process: name });
        return;
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${name} did not become healthy at ${url} within ${timeoutMs / 1000}s`);
}

function shutdown(code) {
  if (stopping) return;
  stopping = true;
  log("stopping", { exitCode: code, running: [...children.keys()] });
  // Stop in reverse start order: worker first, the payment service last.
  for (const name of ["worker", "api", "x402"]) children.get(name)?.kill("SIGTERM");
  // Inside Railway's drainingSeconds (30s in railway.json), so an in-flight tick can finish.
  const timer = setTimeout(() => {
    for (const child of children.values()) child.kill("SIGKILL");
    process.exit(code);
  }, 25_000);
  const check = setInterval(() => {
    if (children.size === 0) {
      clearInterval(check);
      clearTimeout(timer);
      process.exit(code);
    }
  }, 200);
}

process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));

// ── 2–5. boot sequence ────────────────────────────────────────────────────────
try {
  log("applying database migrations");
  await run("migrate", bin("packages/db", "tsx"), ["src/scripts/migrate.ts"], "packages/db");

  start(
    "x402",
    env.X402_UVICORN ?? "uvicorn",
    ["app.main:app", "--host", "127.0.0.1", "--port", env.X402_SERVICE_PORT],
    "services/x402-xrpl",
    pythonEnv,
  );
  await waitHealthy("x402", `${env.X402_SERVICE_URL}/health`, 90_000);

  start("api", bin("apps/api", "tsx"), ["src/main.ts"], "apps/api");
  await waitHealthy("api", `http://127.0.0.1:${env.API_PORT}/health`, 180_000);

  start("worker", bin("apps/worker", "tsx"), ["src/main.ts"], "apps/worker");
  log("all processes running", { apiPublicUrl: env.API_PUBLIC_URL, port: env.API_PORT });
} catch (e) {
  if (!stopping) {
    log("boot failed", { error: e instanceof Error ? e.message : String(e) });
    shutdown(1);
  }
}
