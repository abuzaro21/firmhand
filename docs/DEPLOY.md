# Deploying FIRMHAND

FIRMHAND is one Node 24 process that serves both the API and the static cockpit. It keeps durable state in PostgreSQL 16 when `DATABASE_URL` is set. Otherwise it uses a SQLite file.

## Local
```bash
npm ci && npm run build && npm start      # http://localhost:3000, SQLite at data/firmhand.db
```

## Docker
```bash
docker build -t firmhand:local .
docker run --rm -p 3000:3000 firmhand:local                                    # SQLite inside the container
docker run --rm -p 3000:3000 -e DATABASE_URL=postgres://user:pass@host/db firmhand:local   # durable
```
The image runs as the unprivileged `node` user. Its only runtime dependency is `pg`, and it has a health endpoint at `/api/health`.

## Render (free plan only)
[`render.yaml`](../render.yaml) is a Blueprint for exactly two free resources:

| Resource | Plan | Notes |
|---|---|---|
| `firmhand` web service (Docker) | free | `autoDeploy: false`, health check `/api/health`, `FIRMHAND_TRUST_PROXY_HOPS=3` |
| `firmhand-db` PostgreSQL 16 | free | `ipAllowList: []`, so it is reachable only from Render services |

No paid resources, disks, workers or custom domains are declared.

### Steps
1. Create a dedicated Render workspace for FIRMHAND. The CLI cannot create workspaces, so this is done in the dashboard. Do not reuse another project's workspace.
2. In that workspace choose **New → Blueprint** and connect `abuzaro21/firmhand`. Render reads `render.yaml`.
3. Approve the two free resources. `DATABASE_URL` is wired automatically from the database, and no secret is entered by hand.
4. Trigger the first deploy. FIRMHAND itself was deployed this way with the Render MCP: `create_blueprint`, review the plan, then `approve_blueprint`. When `/api/health` returns `{"ok":true,...}`, run the live checks listed under G15 in [`EXECUTION_STATE.md`](EXECUTION_STATE.md).

### Free-plan behaviour to expect
- **Sleep:** a free web service spins down after about 15 minutes without traffic. The next request wakes it, which takes up to about a minute. Companies are stored in PostgreSQL, so they survive sleep, restarts and redeploys. A company idle for 2 hours expires, and its visitor gets a new one on the next visit.
- **Database expiry:** a free Render PostgreSQL database expires 30 days after it is created, unless it is upgraded. After expiry the server cannot connect at start-up, so after its next sleep or restart the demo stays down until a new database is attached. It does not fall back to SQLite while `DATABASE_URL` is set. The expiry date is recorded in [`EXECUTION_STATE.md`](EXECUTION_STATE.md) once the database exists.
- **Capacity:** the server caps live companies (`FIRMHAND_MAX_COMPANIES`, default 400) and new companies per client address (`FIRMHAND_COMPANIES_PER_MINUTE`, default 10 per minute). It also limits each address to 300 requests and 240 simulated hours per minute. Companies idle for 2 hours expire. At the cap, `/api/session` returns 503 instead of degrading everyone.

## Configuration
| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | listen port |
| `DATABASE_URL` | none | PostgreSQL URL. If unset, SQLite at `FIRMHAND_DB` is used |
| `FIRMHAND_DB` | `data/firmhand.db` | SQLite file |
| `FIRMHAND_TRUST_PROXY_HOPS` | 0 | how many reverse proxies to trust for the client IP in `X-Forwarded-For` (Render: 3; the edge adds the client plus two proxy hops) |
| `FIRMHAND_MAX_COMPANIES` | 400 | live companies across all visitors |
| `FIRMHAND_COMPANIES_PER_MINUTE` | 10 | new companies per client address per minute |
| `FIRMHAND_PREWARM` | on | set to `0` to skip precomputing the comparison runs at start |
| `NODE_ENV` | none | `production` enables HSTS and the `Secure` cookie flag |

The app has no API keys, model keys or payment credentials, because nothing in it needs them.
