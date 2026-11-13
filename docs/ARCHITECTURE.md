# Architecture

```
 browser (React cockpit)                 one Node 24 process (src/server.ts)
 ─────────────────────                   ─────────────────────────────────────────────────────────────
 Run / +1h / +1 day ── POST /api/tick ──▶ Engine.tick(company)            src/engine.ts
 Approve(id, hash) ─── POST /api/approvals/:id ──▶ Engine.decide           (operator controls only)
 KPI / trace / replay ─ GET … ──────────▶ read models (no writes)
                                              │
                                              ▼ one tick = 4 phases, each resumable
                         world ─▶ Sales turn ─▶ Operations turn ─▶ Finance turn
                         (market,  (own inbox,  (own inbox,          (own inbox, posts, watchdog,
                          suppliers) own policy) own policy)          closes day at 16:00)
                                              │ every agent action is a Command
                                              ▼
                         Kernel (src/kernel.ts): one transaction per command, under a company row lock
                           1. Gate: is this command in the executing role's capability list? Is the agent running?
                           2. Approval check when above a policy limit (hash-bound, single use, TTL, revalidated)
                           3. Handler (src/commands.ts) changes records, posts balanced journal entries, emits events
                           4. Event append + inbox fan-out to subscribed roles + decision receipt, same transaction
                                              │
                                              ▼
                         Shared record system (src/db.ts): SQLite locally, PostgreSQL 16 hosted, same DDL
```

## Pieces
| File | Responsibility |
|---|---|
| `src/model.ts` | The company, policy limits, role capabilities, event routing, deterministic randomness |
| `src/db.ts` | Schema (typed tables with CHECK and UNIQUE constraints), SQLite and PostgreSQL adapters, transactions and locks |
| `src/kernel.ts` | Command execution context: the gate, approvals, journal posting with a balance check and overdraft floor, event emission, ids |
| `src/commands.ts` | Every command the agents can issue, each with its own preconditions and idempotency |
| `src/agents/{sales,operations,finance}.ts` | Each role's policy: what to do with its inbox and the shared state on its turn |
| `src/world.ts` | The simulated market and suppliers: leads, quote acceptance, deliveries, customer patience, injected shocks |
| `src/engine.ts` | Genesis, the phased scheduler (no commercial policy), the role runtime, operator controls and read models |
| `src/kpi.ts` | KPIs and the reconciliation checks, all computed from records and journal accounts |
| `src/replay.ts` | A pure reducer over stored event facts and a state checksum |
| `src/compare.ts` | Managed vs naive runs on isolated in-memory companies |
| `src/server.ts` | HTTP API, per-visitor sessions, rate limits, static UI |

## Why it is three agents and not one
- **Separate queues.** Each role has its own inbox (`agent_tasks.role`). Events reach a role only through the subscription map.
- **Separate policies.** Each role's planner is its own module. The scheduler only hands out turns and makes no business decisions.
- **Separate permissions.** The kernel checks the command against the executing role. Sales cannot capture money, and Operations cannot post to the ledger. Tests prove both.
- **Separate state.** Each role has its own beliefs (`agents.memory`), status (running, paused or faulted) and decision log.
- **Separable at runtime.** You can pause any single agent. You can crash Operations mid-turn, and the others keep running and must notice on their own, because `AgentFailed` is routed to no one.

## Time and determinism
One tick is one business hour, and a day has 8 ticks. The week is 56 ticks. Every random draw is `sha256(seed|stream|key)`, so a retried phase cannot draw a different number. Every query whose order matters breaks ties on the numeric part of the readable id. That keeps the order identical in SQLite and PostgreSQL whatever the collation, and the test suite checks it by running the same seed under two different company ids.

The free host sleeps, so nothing runs in the background. Time moves only when the operator asks. `companies.phase` records which phase of the current tick has finished, so a crash or redeploy resumes at the exact phase it stopped in. A test proves this.

## Delivery semantics
Tasks are acknowledged in a batch at the end of each turn. If the process dies mid-turn, the acks are lost and the tasks are delivered again. Every command is idempotent, through unique keys and preconditions, so redelivery is harmless. Delivery is at-least-once and the effects are exactly-once.

## Storage parity
The DDL and SQL are shared. The PostgreSQL adapter translates `?` to `$n` and takes the company lock with `SELECT … FOR UPDATE` in the same round trip as `BEGIN`. The full test suite runs on both stores, in CI and locally.
