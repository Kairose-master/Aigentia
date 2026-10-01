# Deploying the backend on Railway

The dashboard runs on Vercel. Everything else (API, worker, x402 payment service, Postgres,
Redis) runs on Railway as **one application service plus two database services**.

```
Railway project
├── aigentia   (this repo, deploy/railway/Dockerfile)
│     ├── supervisor.mjs → migrations → x402 service (127.0.0.1:8402) → API ($PORT) → worker
│     └── volume /data   (dev wallet file: Testnet seeds)
├── Postgres   (Railway database)
└── Redis      (Railway database)
```

Why one container: the API signs treasury payments (agent funding) and the worker signs agent
payments, so both need the same wallet file, and a Railway volume attaches to a single service.

## Steps

1. **New project from the GitHub repo.** In Railway: New Project → Deploy from GitHub repo →
   `Aigentia`. Railway reads `railway.json` and builds `deploy/railway/Dockerfile`.
2. **Add databases.** In the same project: New → Database → PostgreSQL, then New → Database →
   Redis.
3. **Add a volume** to the `aigentia` service, mounted at `/data`.
4. **Generate a public domain** for the `aigentia` service (Settings → Networking). The
   supervisor uses it as `API_PUBLIC_URL`, the base of every advertised x402 service endpoint.
5. **Set variables** on the `aigentia` service:

   | Variable               | Value                                       |
   | ---------------------- | ------------------------------------------- |
   | `DATABASE_URL`         | `${{Postgres.DATABASE_URL}}`                |
   | `REDIS_URL`            | `${{Redis.REDIS_URL}}`                      |
   | `ADMIN_TOKEN`          | a long random string (24+ characters)       |
   | `X402_SERVICE_TOKEN`   | another long random string (24+ characters) |
   | `XRPL_FILE_WALLET_ACK` | `testnet-only`                              |

   Optional: `TICK_SECONDS` (default 60), `XRPL_WSS_URL` / `XRPL_RPC_URL` (default
   `testnet.xrpl-labs.com`), `LLM_PROVIDER` + key for LLM brains.

   `XRPL_FILE_WALLET_ACK=testnet-only` is a deliberate acknowledgement: the treasury and agent
   wallets are generated on first use, funded from the Testnet faucet and their seeds live in
   `/data/wallets.json` on the volume. Mainnet is refused at startup regardless.

6. **Deploy.** The first boot applies migrations, starts the payment service, starts the API
   (which creates and faucet-funds the treasury), then the worker. `GET /health` turns green.
7. **Point the dashboard at it.** In the Vercel project: set
   `NEXT_PUBLIC_API_URL=https://<railway domain>`, delete `NEXT_PUBLIC_DATA_MODE`, redeploy.
8. **Start the economy** (all autonomous after this):

   ```bash
   API=https://<railway domain>; T="x-admin-token: <ADMIN_TOKEN>"; H='content-type: application/json'
   curl -X POST $API/api/admin/agents -H "$H" -H "$T" \
     -d '{"name":"ORION-7","objective":"maximize_net_worth","startingCapitalXrp":10}'
   curl -X POST $API/api/admin/agents -H "$H" -H "$T" \
     -d '{"name":"ATLAS-3","objective":"profitable_service","startingCapitalXrp":10,"services":[{"kind":"SCOUT","priceDrops":"1000"}]}'
   curl -X POST $API/api/admin/sim/start -H "$T"
   ```

   Or run an experiment: `POST $API/api/admin/experiments` with a config (see the README), then
   `POST $API/api/admin/experiments/<id>/start`.

## Behaviour

- If any of the three processes exits, the supervisor stops the others and exits non-zero, and
  Railway restarts the container (`restartPolicyType: ON_FAILURE`).
- Redeploys stop the processes gracefully (SIGTERM). Railway volumes cause a short downtime on
  redeploy and do not allow replicas, so this service runs as a single instance.
- The supervisor refuses to boot with missing variables, placeholder tokens, or file wallets in
  production without the acknowledgement.
