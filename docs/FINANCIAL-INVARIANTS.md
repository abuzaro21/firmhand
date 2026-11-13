# Financial and operational invariants

Money is integer cents everywhere, in the database, in the API and in every calculation. Display formatting happens only in the UI.

| # | Invariant | How it is enforced | Proven by |
|---|---|---|---|
| 1 | Stock is never negative; reserved ≤ on hand | Schema `CHECK (on_hand >= 0 AND reserved >= 0 AND reserved <= on_hand)` plus a conditional `UPDATE … WHERE on_hand - reserved >= qty` | *negative stock is impossible*; *concurrent reservations for the last units* |
| 2 | An order is reserved at most once per SKU | `UNIQUE(company, order_id, sku)` on reservations; consuming one requires `status='active'` | *concurrent reservations* |
| 3 | A payment is captured at most once | `UNIQUE(company, order_id, kind)` on payments plus an idempotency key; a re-delivered `OrderPlaced` is a Duplicate | *duplicate payment* |
| 4 | An order ships at most once | Shipments are unique per order; recovery dispatches packed parcels exactly once | *operations crash … exactly-once dispatch* |
| 5 | Refunds and credits never exceed what was paid | Checked inside the transaction against cumulative captures | *refunds and credits can never exceed what the customer paid* |
| 6 | A booking is not revenue | Revenue is posted only by `PostShipment`, from a dispatched shipment | every full-week test: revenue < bookings and revenue = sum of posted shipments |
| 7 | Every journal entry balances | `post()` rejects any entry whose debits ≠ credits | *overdraft is impossible* (unbalanced entry case) |
| 8 | Cash never goes below zero, and purchase funding stops at the floor | `post()` refuses a credit to Cash that would make it negative; `FundPurchase` refuses a purchase that would leave cash below the $500 floor (other costs, such as staff pay, may still take cash below $500, never below zero) | *overdraft is impossible* |
| 9 | A fact is posted once | Journal entries are unique on `(company, source_type, source_id, kind)` | *duplicate payment*; full-week tests |
| 10 | Corrections never rewrite history | Journal entries and events are append-only; corrections are new entries | schema (no update paths) |
| 11 | Records, journal and events cannot diverge | One transaction per command covers the record changes, the postings, the event append and the inbox fan-out | *restart … resume exactly once*; replay = live checksum |
| 12 | Inventory value reconciles to the ledger | Weighted-average cost held as integer `value_cents` per SKU; COGS is taken from it | reconciliation check `inventory` |

## Daily close
At 16:00 each business day, Finance runs `CloseDay`. In the same transaction it computes nine checks and stores a snapshot (KPIs, checks and a state checksum).

| Check | Ledger side | Records side |
|---|---|---|
| `trial-balance` | total debits | total credits |
| `cash` | Cash account | opening cash + captures − deposit refunds − credits − expenses − prepaid purchase orders |
| `inventory` | Inventory account | Σ `inventory.value_cents`, adjusted for postings that are still in flight |
| `customer-deposits` | Customer Deposits account | paid orders that have not shipped, or are cancelled and whose deposit is not yet settled (refunded in cash, or already returned by earlier credits) |
| `supplier-advances` | Supplier Advances account | funded or arrived purchase orders whose receipt is not yet posted |
| `revenue` | Revenue account | Σ value of orders whose dispatch has been posted (never bookings) |
| `shipment-integrity` | shipped orders whose shipment is still only packed | 0 |
| `shipments-posted` | parcels dispatched or delivered with no posted shipment entry | 0 |
| `reservations` | SKUs whose `inventory.reserved` ≠ Σ active reservations | 0 |

Each records-side figure is summed from operational tables: payments, expenses, purchase orders, inventory, orders and reservations. The journal is consulted only to ask whether a fact has been posted yet, never for an amount.

Every seed in the test suite (7, 11, 23, 42 and 101) closes all 7 days with 9/9 checks passing, on both SQLite and PostgreSQL.
