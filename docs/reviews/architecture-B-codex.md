**Architecture B: a small commerce company whose agents propose actions, whose shared ledger enforces authority, and whose failures remain visible.** Build one convincing seven-day simulation.

**1. Name**

| Name | Tagline | Assessment |
|---|---|---|
| **LEDGERLOOP** | Every decision leaves a receipt. | Best pick: connects accountability, finance, and repetition. |
| Weekshift | Run the company. Watch it adapt. | Strong demo language; weaker accountability signal. |
| Common Record | Three agents. One accountable company. | Clear thesis; less memorable. |

Pick **LEDGERLOOP**, with “The Autonomous Company Simulator” as the explanatory subtitle.

**2. Company**

**Loop Goods** sells three fictional desk products:

| SKU | Price | Landed unit cost | Supplier lead time |
|---|---:|---:|---:|
| Cable kit | $25 | $8 | 2 days |
| Desk mat | $45 | $18 | 3 days |
| Organizer | $35 | $12 | 2 days |

Start with $2,000 cash, 20 units/SKU, and 40 synthetic customers. Record opening inventory against opening equity.

Assumptions: one currency, fixed acquisition costs, no tax, shipping included, no physical returns. Refunds after shipment are goodwill payments; inventory and COGS remain unchanged.

Customers have seeded demand and delivery patience. “Churn” means an explicit customer exit after an excessive wait, divided by customers active at week start; label this simulation definition.

**3. Independent roles**

| Role | Capabilities and policy | Forbidden |
|---|---|---|
| Sales | Quote, request reservations, offer discounts, redirect demand, pause campaigns. Prefer contribution margin and delivery reliability over bookings. | Charge customers, change inventory, declare shipments. |
| Operations | Reserve/release stock, request procurement, receive goods, ship. Prioritize oldest promised delivery; reorder below two days’ projected coverage. | Change prices, issue refunds, release supplier payments. |
| Finance | Capture simulated payments, release procurement funds, refund, enforce budgets, reconcile journals, detect stalled fulfillment. | Ship, invent stock, change customer promises. |

Each has its own inbox, planner module, processed-event cursor, pause switch, fault injector, and decision log. Planners read shared records and emit typed commands.

The scheduler advances time and dispatches work; it contains **no commercial decision policy**. A shared command executor validates authority and commits effects. Separate processes are unnecessary; independent queues and enforceable capabilities are essential.

**4. Shared records and twelve invariants**

Tables: `companies`, `sessions`, `customers`, `products`, `inventory`, `orders`, `order_lines`, `reservations`, `purchase_orders`, `payments`, `refunds`, `campaigns`, `budgets`, `approvals`, `journal_entries`, `journal_lines`, `events`, `role_inbox`, `role_runs`, `commands`.

Every record is company-scoped; composite foreign keys prevent cross-company relationships. Sessions determine scope server-side.

1. **Stock never negative:** checked quantities and atomic conditional updates.
2. **Reserved stock ≤ on-hand:** reservation transaction validates availability.
3. **One active reservation per order line:** unique key; release/consume exactly once.
4. **Payments idempotent:** unique command key and one successful capture per order.
5. **Refunds ≤ captured amount:** transactional cumulative check against locked/versioned payment.
6. **Shipment once per order:** unique fulfillment key; this slice excludes partial shipments.
7. **Revenue ≠ bookings:** journal revenue only upon shipment.
8. **Every journal balances:** posting function checks debit/credit equality before commit.
9. **Approvals authorize exact actions:** hash binds command, parameters, resource revisions, policy version.
10. **Stale decisions cannot execute:** compare expected revisions; reject and replan.
11. **Spend cannot exceed released budget or available cash:** reserve funds transactionally.
12. **Business changes and events cannot diverge:** projection writes, journal, event append, and inbox fan-out share one transaction.

Unique keys handle duplicates; transactions and revision comparisons handle races. Backend command handlers enforce every rule.

**5. Financial meaning**

Use integer cents and immutable journal postings.

Accounts: Cash, Inventory, Supplier Advances, Customer Deposits, Sales Revenue, Sales Refunds, COGS, Advertising Expense, Opening Equity.

- Accepted order: operational booking; stock reservation required.
- Capture: debit Cash, credit Customer Deposits.
- Shipment: debit Customer Deposits, credit Revenue; debit COGS, credit Inventory.
- Supplier prepayment: debit Supplier Advances, credit Cash.
- Receipt: debit Inventory, credit Supplier Advances.
- Unshipped cancellation: debit Customer Deposits, credit Cash; release reservation.
- Shipped refund: debit Sales Refunds, credit Cash.
- Advertising: debit Advertising Expense, credit Cash.

Budgets are spending permissions and commitments, not expenses. Display bookings, recognized revenue, cash, COGS, advertising, backlog, and churn separately.

**6. Commands and events**

Use `events` as the durable outbox. Transactional fan-out inserts unique `(company, event, role)` inbox deliveries.

A planner records its inputs, policy rule, explanation, proposed command, and outcome. Capability checks use the executing worker’s role, never a role supplied inside the command.

Ordering: virtual timestamp, phase, role order, inbox sequence. Randomness uses a versioned seeded generator with separate streams for demand, suppliers, and faults. Retries cannot consume fresh random draws.

Command keys derive from company, originating task, action, and attempt generation. Duplicate delivery returns the recorded result.

**7. Running a week**

Each day has fixed phases:

1. Release due supplier arrivals and customer demand.
2. Sales proposes offers; Operations reserves; Finance captures.
3. Operations fulfills eligible orders and proposes replenishment.
4. Finance funds approved procurement, evaluates stalls, and processes cancellations.
5. Repeat reactive inbox passes to a bounded limit.
6. Close the day and record metrics.

Bounded passes prevent infinite agent ping-pong.

Use **request-driven stepping**. React repeatedly POSTs “advance one phase” while Run Week is active. A database lease prevents overlapping runners; a transaction commits each bounded phase. Closing the browser pauses progression; another request resumes.

SSE streams committed events with resumable event IDs. No permanent background loop or sleep-sensitive timers.

**8. Human authority**

Automatic limits:

- Discount ≤10%; contribution margin ≥40%.
- Procurement ≤$200/PO and ≤$300/day.
- Refund ≤$50/order and ≤$100/day.
- Advertising ≤$20/day.

Exceeding any limit requires approval. Hard limits remain: discount ≤20%, advertising ≤$50/day, valid refund entitlement, and cash after discretionary spending ≥$250.

Approval hash:

`SHA256(company + action + canonical_params + relevant_record_revisions + policy_version)`

Single-use; expires after one simulated day. Approval execution rechecks all invariants and bound revisions. A changed resource requires a fresh proposal.

Denial cancels that proposal: Sales uses normal pricing, Operations defers procurement and reports supply risk, Finance leaves the refund unresolved in the human inbox. No automatic resubmission of the same denied action.

**9. Self-correction**

Inject a cable-kit demand spike and supplier delay.

Operations publishes projected shortage. Sales pauses that campaign and redirects eligible demand to organizers. Finance releases a small organizer replenishment within budget. No approval is required.

Ship a fixed seed with acceptance targets: correction within one day, zero oversells, zero human approvals, and fewer unfulfilled promises than a frozen-policy baseline. Display actual measured differences; targets are not claimed results.

**10. Operations failure**

Pause Operations after day-one payments.

Finance’s independent watchdog runs each finance phase. It detects two consecutive fulfillment windows with eligible paid orders and no Operations progress; heartbeat age alone is insufficient.

Sales stops new promises for affected products. Finance pauses advertising spend, publishes exposure, and requests human attention. Valid cancellations still receive refunds.

Recovery begins with reconciliation: inspect paid orders, reservations, shipment facts, and supplier receipts; regenerate missing tasks. Shipment uniqueness and command idempotency prevent duplicate fulfillment.

Baseline: identical seed and Operations outage, but no watchdog or compensating policies. Compare paid backlog, overdue orders, refunds, lost customers, and cash exposure. Preserve identical accounting invariants in both runs.

**11. Replay**

Events are authoritative business facts; current tables are projections. Store genesis, seed, engine/policy versions, human decisions, faults, and monetary postings.

For seven days, rebuild projections directly from events; snapshots are unnecessary. Replay applies facts without planners, command execution, inbox delivery, or external effects.

The day scrubber shows balances, backlog, customer exits, and decision ancestry. A replay checksum must match the live projection.

**12. Ten judge challenges**

| Challenge | Evidence that defeats it |
|---|---|
| One planner wearing three hats | Pause one queue; show others continuing independently. |
| Decorative shared database | Follow one order through three role-authored transitions. |
| Scripted success story | Publish seed, policies, fault settings, and repeatable runs. |
| Fake financial movement | Open balanced postings behind every metric change. |
| Approval button with no authority | Submit altered parameters; backend rejects them. |
| Duplicate effects on retry | Deliver payment and shipment commands twice. |
| Replay secretly reruns decisions | Replay with planners disabled; compare checksums. |
| Failure only changes a badge | Show Sales and Finance compensation events. |
| Visitors share companies | Cross-session API and SSE isolation tests. |
| Free host breaks the demo | Resume interrupted phases; keep replay available after restart. |

**13. Architectural disagreement and delivery**

“Three deterministic bots sharing SQLite” proves connectivity, but not accountability. The distinguishing artifact is the **causal receipt**: evidence read → policy applied → command proposed → authority checked → committed effect → compensation.

Use TypeScript on Node 24, React/Vite, SSE, PostgreSQL on Render, and local `node:sqlite`. Keep a small database adapter; run invariant tests against both engines. Avoid an ORM, broker, microservices, and generic agent framework.

Day one: command kernel, accounting, records. Day two: role queues, scenarios, replay. Day three: approval UI, isolation/retry tests, Playwright demo and recording.

Future thesis: planners may become more capable, while durable authority, budgets, evidence, and reversibility remain outside them.

Skipped: file inspection and prototype execution, as requested. Main risk: three days only works with one company model, whole-order shipments, and a tightly bounded simulation.
