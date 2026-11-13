# Architecture decisions

Claude wrote Architecture A (`docs/reviews/architecture-A-claude.md`). Codex wrote Architecture B (`docs/reviews/architecture-B-codex.md`), working from the prompt in `docs/reviews/architecture-B-prompt.md`. Codex ran as `gpt-6.1-sol` (taken from the Codex CLI runtime output) under a read-only sandbox, and it did not see A. This file records where we agreed, where we disagreed, and what we chose.

## Product name
**FIRMHAND**: *One company. One shared truth. Many accountable hands.*

Both proposals first picked **LEDGERLOOP**. A collision search on 2026-11-13 found two conflicts:
- an existing open-source project, LedgerLoops (ledgerloops.com);
- a public repository called `ledgerloop` that describes itself as a "multi-agent finance-ops toolkit". That is too close to this product.

FIRMHAND had no meaningful collision on GitHub; the only hit was an empty personal pages repository. We have not done a trademark search, and we make no claim of clearance. The name works on two levels: a *firm* run by several *hands*, and keeping a *firm hand* on the business, which stands for authority and accountability.

## Company model
**Hearthbrew Coffee Gear** is a fictional direct-to-consumer company. Every customer, supplier, product and amount in it is synthetic.

| SKU | Price | Standard cost | Opening stock |
|---|---:|---:|---:|
| Gooseneck kettle | $64 | $26 | 34 |
| Ceramic dripper | $32 | $9 | 50 |
| Burr grinder | $149 | $62 | 24 |
| Filter papers ×200 | $12 | $3 | 160 |

- **Customers.** There are 40: 30 retail customers and 10 café accounts. Cafés place larger orders and sometimes ask for discounts. Every customer pays when the order is placed.
- **Suppliers.** *Northgate* is the primary supplier: standard cost, 3-day lead time, prepaid. *Swiftline* is the pre-vetted backup: +35% unit cost, 1-day lead time, prepaid.
- **Fixed costs.** Shipping costs $6 per parcel. Staff cost is $350 per business day. Advertising is a daily campaign that Sales requests and Finance pays.
- **Opening position.** $14,000 cash, plus the opening inventory at cost, both against Opening Equity.
- **Time.** One tick is one virtual business hour, and a business day has 8 ticks. The packing bench handles 4 parcels per hour.

## Role boundaries (both proposals agree)
| Role | May | May not |
|---|---|---|
| Sales | Quote, set promise dates, discount ≤10%, place orders from accepted quotes, request ad spend, notify customers, request goodwill credits, request cancellations | Touch stock, capture or refund money, fund purchases, ship |
| Operations | Reserve or release stock, pack, dispatch, receive goods, propose purchase orders, report shortages | Change prices or promises, post journal entries, fund purchases, refund |
| Finance | Capture payments, post every journal entry, fund purchase orders within budget, pay ads within budget, issue refunds and credits, run the watchdog, freeze discretionary spend, close the day | Ship, change stock, change customer promises, create revenue without a shipment |

Each role is a separate module with these parts:
- its own policy (`src/agents/*.ts`);
- its own inbox (`agent_tasks.role`);
- its own private belief state (`agents.memory`);
- its own status, which is running, paused or faulted;
- its own decision log, made of causal receipts.

The scheduler only hands out turns and contains **no commercial policy** (Codex). The Gate checks every command's capability against the role that is executing it, never against a role field inside the command. An off-role command is rejected and recorded as an event.

## Shared-state invariants and how they are enforced
1. **Stock is never negative.** Enforced by `CHECK(on_hand >= 0 AND reserved >= 0 AND reserved <= on_hand)` and a conditional `UPDATE … WHERE on_hand - reserved >= qty`.
2. **Every reservation has a stable id.** The id is `res:<order>:<sku>`, with `UNIQUE(company, order_id, sku)`.
3. **The same order cannot consume stock twice.** A shipment is unique per order, and consuming a reservation requires `status='active'`.
4. **A payment is captured at most once per order.** `UNIQUE(company, order_id, kind)` on captures, plus a unique idempotency key.
5. **A refund cannot exceed what is refundable.** Inside the transaction: cumulative refunds ≤ captured amount.
6. **Expenses reduce cash when they are paid.** Ads, staff and shipping are posted as paid. Purchase orders are prepaid and land in Supplier Advances.
7. **A booking is not revenue.** Revenue is posted only from a dispatched shipment.
8. **Gross revenue, recognized revenue, collected cash, gross profit and net income are separate figures**, each a separate query over journal accounts or records.
9. **Corrections leave an audit trail.** Journal entries are immutable, and corrections are new compensating entries.
10. **No agent overwrites another's work.** Each command is a transaction under a company row lock. Row versions are checked for updates that depend on a version.
11. **An approval binds to one exact action.** `sha256(company | kind | canonical params | bound record versions | policy version)`, single-use, with a virtual-time expiry.
12. **A stale decision is checked again before it commits.** Execution recomputes the binding and the preconditions. If they fail, the approval is marked stale and the agent re-proposes.
13. **Business changes and their events cannot diverge** (Codex). Records, journal, event append and inbox fan-out share one transaction.

Money is integer cents everywhere. Inventory is valued at weighted average cost, held as integer `value_cents` per SKU, so the Inventory account reconciles exactly.

## Financial semantics (double-entry)
**Accounts:** Cash, Inventory, Supplier Advances, Customer Deposits, Revenue, Refunds & Credits (contra-revenue), COGS, Shipping, Advertising, Staff, Opening Equity.

| Fact | Entry |
|---|---|
| Payment captured at order | Dr Cash / Cr Customer Deposits |
| Shipment dispatched | Dr Customer Deposits / Cr Revenue; Dr COGS / Cr Inventory (moving-average cost carried on the shipment); Dr Shipping / Cr Cash |
| Purchase order funded | Dr Supplier Advances / Cr Cash |
| Goods received | Dr Inventory / Cr Supplier Advances (at the funded cost) |
| Cancellation before shipment | Dr Customer Deposits / Cr Cash |
| Goodwill credit or refund after shipment | Dr Refunds & Credits / Cr Cash |
| Ads, staff | Dr expense / Cr Cash |

Each entry has a unique source key, `(company, source_type, source_id, kind)`, so a retried event cannot double-post. The posting function rejects any entry whose debits and credits do not balance.

## Coordination, time and determinism
- **Events are the outbox.** Every event appends to `events`, which carries a per-company `seq`, the actor, the subject, a causation seq, an idempotency key and the state version. A static subscription map fans each event out to the inboxes of the subscribing roles, with `UNIQUE(company, role, source_seq)`.
- **Ticks run in phases.** Each tick runs four phases: world → Sales → Operations → Finance. `companies.phase` records progress, so a crash or restart resumes at the exact phase it stopped in.
- **Commands are separate transactions.** Each command an agent executes is its own transaction. A crash part-way through a turn leaves the earlier commands committed and nothing half-written. On recovery the agent re-plans from the shared state, and idempotency keys stop any repeat.
- **Randomness is stateless.** Every draw is `hash(seed, stream, key)`, so a retry cannot consume a fresh draw (Codex). The same seed plus the same operator inputs gives the same history.
- **The host drives nothing on its own.** The web host sleeps on the free tier, so time advances only when a request asks for it (both proposals). The UI's Run button calls `/tick` repeatedly.
- **Live updates.** *Disagreement:* Codex proposed SSE with resumable IDs; Claude proposed cursor polling. **Decision: cursor polling.** Every tick response returns its new events, and `GET /events?after=seq` is gap-free by construction. The free host's proxy and sleep cycle make long-lived streams the weaker choice, and polling loses nothing that matters at this volume.

## Human approval policy (enforced by the Gate)
| Action | Autonomous up to | Needs a human | Hard limit, approval cannot override |
|---|---|---|---|
| Discount | 10% | >10% | 25% |
| Purchase order | $1,500, with cash after funding ≥ $3,000 reserve | above either | cash after ≥ $500 |
| Expedite (backup supplier) | within the $1,500/week expedite budget | above | n/a |
| Refund or credit after shipment | $60 | above | ≤ captured amount |
| Cancellation of an unshipped order | $500 | above | n/a |
| Ad spend | $150/day, only while no spend freeze is on | above | n/a |
| Recovering a faulted agent | never | always | n/a |

- **Approval.** The requesting agent executes on its next turn. The executing command has to present the approval id, and its parameters must hash to the same value.
- **Denial.** Each kind of request has a defined fallback:
  - a discount falls back to the 10% maximum;
  - a purchase order is cancelled, and Sales pushes promise dates out;
  - a refund is limited to $60;
  - a recovery leaves the agent down, and Sales keeps holding promises.
- **Expiry.** An approval expires after 8 ticks. The action is not executed, and the agent decides again.

## Self-correction: inventory shock, no human involved
1. A grinder demand surge (×4 for two days) coincides with a 3-day Northgate delay on the grinder line (other SKUs keep their normal lead time).
2. Operations detects the projected shortfall and opens an incident. It proposes a Swiftline expedite purchase order sized to the gap.
3. Finance funds the expedite on its own, because it fits inside the expedite budget and the cash reserve.
4. Sales stops grinder advertising, quotes promise dates that include the expedite arrival, and sends delay notices with a $5 credit to backordered customers. Finance pays the credits.
5. Operations ships in promise order.
6. The incident closes when the shortfall reaches zero.

**How we measure it.** We run the same seed and the same injections on an *isolated in-memory company* twice, once with correction policies on and once off. Both runs report broken promises, cancellations, churned customers and margin.

## Failure: Operations goes down
1. **The crash.** The injected fault crashes Operations mid-turn, after it has packed one or more orders and before it dispatches them, so the partial commit is real. From then on Operations gets no turns, and its inbox grows.
2. **Detection.** Finance's watchdog checks for progress, not heartbeats (Codex). It flags Operations as stalled when work has been eligible for 2 or more ticks with no Operations progress. It opens an incident and emits `CapacityLost`.
3. **Response.**
   - Sales stops near-date promises and quotes "after recovery" dates.
   - Finance freezes ad spend, publishes the exposure (deposits held for orders that cannot ship), and asks for a human recovery approval.
4. **Recovery.** Operations reconciles before it does any new work:
   - it dispatches packed shipments exactly once, because shipments are unique per order;
   - it reserves for paid orders that have no reservation;
   - it drains its inbox, with idempotency stopping any repeats.
5. **Comparison.** A naive baseline runs the same seed and the same outage, but without the watchdog and with no compensation. It runs on isolated state.

## Replay
- **How a day is rebuilt.** Replay is a pure reducer over the event log. Every event that moves money carries its journal postings; inventory and order-status events carry their deltas. It reconstructs KPIs, order states and stock at any seq.
- **Read-only.** It runs as GET requests and never calls planners, commands or inbox delivery.
- **What the tests check.** The reducer's final checksum must equal the checksum of the live tables, and a replay must leave every table digest unchanged.

## Hosting
- **What runs.** One Render free web service (Docker) and one Render free PostgreSQL 16, in a **new, dedicated Render workspace** if the account allows one. Otherwise we choose a different free host and record the reason in `docs/DEPLOY.md`. Existing DOO workspaces and services are never touched.
- **Local storage.** Locally and in tests, the app uses SQLite through `node:sqlite`, with the same SQL.
- **Visitor isolation.** Each visitor gets an isolated company keyed by an HttpOnly cookie, which the database stores only as a hash. There are limits on companies, rate and idle time.

## Acceptance criteria
The gates are G1–G17 in `docs/EXECUTION_STATE.md`. The pivotal checks:
- **Week runs.** A 7-day run completes reproducibly for 3 seeds, and every invariant holds at each day's close: the trial balance balances, inventory reconciles, and deposits reconcile.
- **Self-correction.** The shock resolves with zero human approvals and measurably beats the baseline.
- **Failure handling.** Under an Operations outage, Sales and Finance compensate, nothing is duplicated after recovery, and the result beats the naive baseline.
- **Approvals.** An approval executes only the exact action it covers. Altered, reused, expired or stale approvals are rejected.
- **Replay.** The replay checksum equals the live state, and a replay produces no side effects.
