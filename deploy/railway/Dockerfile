# Aigentia backend for Railway: one container, three processes (x402 payment service, API,
# worker) started by deploy/railway/supervisor.mjs. Postgres and Redis are Railway services.
# One container because the API (treasury funding) and the worker (agent payments) must sign
# with the same wallet file, and a Railway volume attaches to a single service.
FROM node:22-bookworm-slim

ENV PNPM_HOME=/pnpm \
    PATH=/opt/venv/bin:/pnpm:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# Debian bookworm ships Python 3.11, which x402-xrpl requires.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g pnpm@10.33.0

WORKDIR /app

# Python payment service dependencies (cached layer).
COPY services/x402-xrpl/requirements.txt services/x402-xrpl/requirements.txt
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install -r services/x402-xrpl/requirements.txt

# Node workspace dependencies (cached layer). Every workspace manifest is copied so the frozen
# lockfile matches; only the API, worker and db packages (and their dependencies) are installed.
# Dev dependencies are kept on purpose: the apps run TypeScript sources through tsx.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/xrpl/package.json packages/xrpl/package.json
COPY packages/x402/package.json packages/x402/package.json
COPY packages/economy/package.json packages/economy/package.json
COPY packages/agent-core/package.json packages/agent-core/package.json
COPY packages/game-engine/package.json packages/game-engine/package.json
RUN pnpm install --frozen-lockfile \
    --filter "@aigentia/api..." --filter "@aigentia/worker..." --filter "@aigentia/db..."

COPY . .

ENV NODE_ENV=production \
    SIM_LEDGER=testnet \
    X402_SERVICE_URL=http://127.0.0.1:8402 \
    X402_SERVICE_PORT=8402 \
    XRPL_WALLET_PROVIDER=file \
    XRPL_WALLET_FILE=/data/wallets.json

CMD ["node", "deploy/railway/supervisor.mjs"]
