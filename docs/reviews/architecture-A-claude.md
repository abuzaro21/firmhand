# Architecture A (Claude), written before reading Codex's proposal

## Names
1. **LEDGERLOOP**: "One company. One shared truth. Many accountable agents." It says what the product is, which is good, but the name is generic and collision-prone with fintech uses.
2. **COUNTERSIGN**: every consequential action carries a second signature, from another role's record or from a human. It is distinctive, but long and leans only on approvals.
3. **QUORUM**: collides with JPMorgan's Quorum and many others. Rejected.
4. **MANDATE**: "Agents act within mandates." It maps well to authority boundaries and is short. It collides with some legal/HR SaaS.
5. **TALLYHALL**, **FIRMLOOP**: weak.

Pick: whichever survives the collision search. Leaning toward LEDGERLOOP, because a judge reads the concept straight from the name.

## Company
**Fernhill Coffee Gear** (fictional) is a DTC brand selling coffee equipment.
- **Four SKUs:** kettle, dripper, grinder, filter papers (a consumable).
- **Customers:** retail customers pay at checkout. Wholesale café accounts are invoiced net-3 virtual days.
- **Warehouse:** one.
- **Suppliers:**
  - Primary: cheap, 3-day lead time.
  - Backup: +35% unit cost, 1-day lead time, pre-vetted.
- **Operating costs:** shipping capacity of 2 shipments per tick (16 per day), plus daily payroll and rent accruals.
- **Opening position:** $25,000 cash from equity.

## Agents (three runtimes)
**Shape of each agent.** Every agent is a separate module with:
- its own policy function `decide(view, inbox)`;
- its own inbox rows (`agent_tasks.role`);
- its own status (running, paused or faulted), heartbeat and decision log;
- its own capability set.

**Scheduler.** It only gives turns. Each tick (one virtual business hour, 8 per day) it runs world → sales → operations → finance, each in a separate DB transaction. A faulted agent gets no turn and its inbox accumulates. No agent can call another's commands: the Gate rejects off-role commands with `RoleViolation`, which is recorded as an event.

**Coordination.** It happens only through durable events.
- Every committed command appends events.
- A static subscription map routes each event type into the subscribing roles' inboxes, using `UNIQUE(company, role, idem)` for dedupe.

**Sales**
- Turns leads into quotes, using ATP and a capacity-aware promise date.
- Converts accepted quotes into orders.
- Applies discounts: up to 10% on its own, more than 15% needs a human, and 0% while Finance's spend freeze is on.
- Reacts to:
  - shortage: pause the promo, push promise dates later, steer to in-stock SKUs;
  - an Operations stall: stop promising near dates, and mark new orders "ships after recovery";
  - delays: send a notice plus a goodwill credit of $10 or less.
- Retention offers go to customers at risk.

**Operations**
- Reserves stock with a conditional update.
- Backorders anything it cannot reserve.
- Ships up to capacity, earliest promise first.
- Receives purchase orders.
- Detects projected shortage, meaning demand plus backlog exceeds on-hand plus inbound before the promise date.
- Proposes replenishment and expedite purchase orders to Finance. It cannot place one without authorization.

**Finance**
- Posts every journal entry from events: payments, shipments (revenue recognition plus COGS), receipts, supplier payments, opex and refunds.
- Authorizes purchase orders inside budget and the cash reserve, and escalates above them.
- Runs the watchdog on the other roles' progress.
- Applies a spend freeze when projected cash falls below the reserve.
- Runs the end-of-day close: trial balance, reconciliations, snapshot.

## Shared records (one schema; SQLite locally, PG16 hosted)
**Tables**
- **Company and agents:** `companies` (seed, clock, version, ev_seq), `agents`, `agent_tasks`.
- **Sales side:** `customers` (modeled satisfaction), `products`, `suppliers`, `leads`, `quotes`, `orders`, `order_lines`.
- **Stock:** `inventory` (on_hand, reserved, value_cents with CHECKs), `inventory_movements`, `reservations` (UNIQUE per order line).
- **Fulfilment and purchasing:** `shipments` (UNIQUE per order), `purchase_orders`.
- **Money:** `payments` (UNIQUE idem), `refunds`, `journal_entries` (UNIQUE source key), `journal_lines`.
- **Control:** `approvals`, `incidents`, `events` (append-only, seq), `decisions`, `snapshots`.

**Units and costing.** Money is integer cents. Inventory is valued at weighted average cost held as integer value_cents, so the Inventory GL reconciles exactly.

## Financial semantics (double-entry, documented basis)
**Accounts**
- Assets: Cash, AR, Inventory.
- Liabilities: Customer Deposits (deferred revenue), AP.
- Equity: Equity.
- Income and expense: Revenue, Refunds & Credits (contra), COGS, Shipping, Expedite, Opex.

**Postings**
- **Retail payment captured:** Dr Cash, Cr Customer Deposits.
- **Shipment:** Dr Deposits or AR, Cr Revenue. Dr COGS, Cr Inventory. Dr Shipping, Cr Cash.
- **Wholesale payment received:** Dr Cash, Cr AR.
- **Purchase order received:** Dr Inventory, Cr AP. Paying the supplier: Dr AP, Cr Cash. The expedite premium goes to an Expedite expense.

**KPI terms**
- Booked value: sum of order totals.
- Recognized revenue: the Revenue account.
- Collected cash: Cash debits from customers.
- Gross margin: Revenue minus Refunds minus COGS.
- Net income: everything else after that.

**Correction rule.** Corrections are reversing or compensating entries. The `journal_entries` source key UNIQUE makes double-posting impossible.

## Approval policy (Gate-enforced)
**Thresholds that need a human**
- Discount above 15%.
- Refund above $150.
- A purchase order above $2,000, or one that leaves projected cash below the $3,000 reserve.
- Cancelling an order above $500.
- Operations recovery after a fault.

**Binding.** Each approval stores:
- the action kind;
- canonical params and their sha256;
- the referenced record versions;
- the precondition list;
- an expiry in virtual hours.

**At execution.** The hash must match, the status must be approved and not yet executed, and the preconditions must be re-evaluated; if the state has moved, the approval is marked stale. A denial has a defined consequence: the order is placed without the discount, or the purchase order is cancelled and Sales pushes promise dates later.

## Self-correction: Inventory Shock (no human)
1. A grinder demand surge combines with a primary-supplier delay of +4 days.
2. Operations detects the projected shortage and opens an incident.
3. Sales pauses the promo, quotes later dates and steers buyers.
4. Operations proposes a backup expedite purchase order.
5. Finance authorizes it autonomously because it falls inside the $1,500 weekly expedite budget.
6. Operations reprioritizes the backlog.
7. Sales notifies late customers with a credit under $10.
8. The incident resolves once the backlog clears.

**Measuring it.** The same seed runs on an isolated in-memory company with correction policies OFF. We compare broken promises, fill rate, modeled churn risk and margin. Correction costs some margin (the expedite premium) and saves promises.

## Failure: Operations goes down
**The fault.** It is injected between saga steps: the shipment row is created (`label_created`), but the carrier handoff has not been confirmed. Operations's status becomes faulted, so it gets no turns and its inbox grows.

**Detection.** Finance's watchdog notices tasks older than 2 ticks with no Operations progress. It opens an AgentStalled incident.

**Response**
- Sales sees the capacity events and stops near-date promises.
- Finance computes the exposure (customer deposits at risk plus late orders), freezes discretionary purchase orders, and escalates "authorize Operations recovery."
- The human approves.
- Operations restarts and reconciles:
  - it resumes the `label_created` shipments idempotently (UNIQUE order shipment);
  - it drains its inbox using idempotency keys;
  - no shipment or posting can duplicate.

**Comparison.** A naive baseline runs on isolated state: Sales keeps promising, and there is no watchdog. It shows the extra broken promises.

## Run engine on a free host
The run is request-driven:
- `POST /tick` and `/day` advance virtual time under a company row lock. There is no background loop that dies when the host sleeps.
- The UI "Run" auto-plays ticks, one request each.
- The client reads incremental events with `GET /events?after=seq`, which is cursor based and gap-free. We use this instead of SSE, so reconnects lose nothing.

## Replay
Replay is a pure reducer over the event log (plus journal postings in the event payloads). It produces the KPIs, order states and inventory at any seq.
- A test asserts that reducer(all events) equals the live tables.
- Replay is a GET, and a test asserts the table digests are unchanged.

## Risks / judge-catch
1. KPIs not reconciling: there is a reconciliation endpoint plus tests.
2. One planner in three hats: separate modules, inboxes, capabilities and RoleViolation tests.
3. Fake replay: the reducer is checked for equality with the live tables.
4. Failure only cosmetic: a faulted agent's turns are actually skipped, and its inbox counts grow.
5. Approval bypass: the Gate is server-side, with hash binding.
6. Scripted story: different seeds produce different histories, and a test runs the shock under 3 seeds.
