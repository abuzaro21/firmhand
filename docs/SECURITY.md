# Security

FIRMHAND is a public demo on a free host. The aims are that one visitor cannot affect another, the browser cannot forge business facts, and nobody can exhaust a 512 MB instance cheaply.

## Visitor isolation
- **One company per visitor.** Each visitor gets their own synthetic company, keyed by a random 24-byte token in an `HttpOnly; SameSite=Strict` cookie. The cookie also carries `Secure` in production. The database stores only the token's SHA-256 hash.
- **No shared ids.** Company ids are random (`co_` + 16 hex). Every query is scoped by company, and every write runs under that company's row lock.
- **No session, no access.** A request without a valid session gets 401, and a forged cookie gets nothing. Tests: *visitors are isolated; a forged or missing cookie gets nothing* (HTTP) and *isolation: one company never sees or changes another company* (kernel).

## The browser cannot forge facts
- **Narrow write surface.** The only write endpoints are the operator controls: tick, day, approve or deny, pause or resume an agent, inject a scenario, new company. No endpoint accepts an event, a record, an actor, a role or a clock. Test: *there is no way to write an event, a record, an actor or a clock from the browser*.
- **Approvals.** An approval requires the exact 64-hex hash the server issued for that approval, and the server recomputes the binding at execution. See [APPROVALS.md](APPROVALS.md).
- **JSON only.** POST requests must be `application/json` (otherwise 415). With `SameSite=Strict`, this blocks simple cross-site form posts.

## Resource limits (per client address unless noted)
| Limit | Default |
|---|---|
| Requests | 300 per minute |
| New companies | 10 per minute |
| Simulated hours | 240 per minute (a full week is 56) |
| Hours per request | 1–8 |
| Live companies, whole server | 400. Companies idle for 2 hours are deleted. At capacity, companies idle for 20 minutes are deleted first; if it is still full, new visitors get 503. |
| Comparison runs | only the 5 published seeds × 2 scenarios, computed once and cached |

The client address comes from the socket. It comes from `X-Forwarded-For` only when `FIRMHAND_TRUST_PROXY_HOPS` is set, which is 3 on Render, and then the address is taken that many entries from the right, so a client cannot spoof it. On Render the edge appends the client address and two proxy hops. With a hop count of 1 the key was an internal proxy address that changed between requests, and the per-address limits did not hold. The live check found this and verifies the fix: rapid new sessions hit 429, and forged left-most entries do not create new buckets.

## Headers and static files
- **Headers.** A strict CSP (`default-src 'self'`, no inline script, `frame-ancestors 'none'`), plus `nosniff`, `no-referrer`, `X-Frame-Options: DENY`, COOP/CORP same-origin, and HSTS in production.
- **Static files.** Files are served only from the resolved `public/` directory, with path containment, so traversal attempts get the SPA shell or 404. Test: *static serving refuses traversal and serves the SPA fallback*.
- **Errors.** Error responses never include stack traces.

## Data and side effects
- All data is synthetic. There are no real payments, emails, customers or suppliers, and no outbound network calls at runtime. No LLM is called at runtime.
- The only runtime dependency is `pg`. `npm audit --omit=dev` runs in CI.

## What this does not claim
- The "operator" is whoever holds the browser cookie. There is **no identity verification**.
- Checksums show that the log explains the tables. They are **not tamper evidence**: there is no signature and no hash chain.
- This has not had a professional security audit. Independent AI reviews are in [`reviews/`](reviews).
