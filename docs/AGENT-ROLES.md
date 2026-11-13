# Agent roles

Each agent runs once per business hour, in this order: Sales, then Operations, then Finance. On its turn an agent:
1. reads the tasks in its own inbox;
2. reads the shared records it is allowed to see;
3. updates its private beliefs (`agents.memory`) and states a one-line plan;
4. issues commands.

Each command produces a **receipt** in `decisions`. The receipt records the command, its parameters, the outcome (committed, rejected, escalated or duplicate), the reason, and the event seq that caused it. Receipts are visible in each lane of the cockpit.

| | Sales (`src/agents/sales.ts`) | Operations (`src/agents/operations.ts`) | Finance (`src/agents/finance.ts`) |
|---|---|---|---|
| Goal | Turn demand into promises it can keep | Turn paid orders into shipments without inventing stock | Keep every cent posted, spending inside authority, and the other agents honest |
| Inbox | `LeadArrived`, `QuoteAccepted/Declined`, `ShipmentDispatched`, `OrderDelivered`, shortages, supplier delays, capacity lost or restored, spend freezes | `OrderPlaced`, `PaymentCaptured`, `GoodsArrived`, `SupplierDelayed`, funding outcomes, cancellations | `OrderPlaced`, `ShipmentDispatched`, `GoodsReceived`, `PurchaseProposed`, credit and ad requests, shortages |
| Commands | `IssueQuote`, `PlaceOrder`, `RequestAdSpend`, `NotifyDelay`, `RequestCredit`, `CancelOrder` | `ReserveStock`, `Backorder`, `ReleaseReservation`, `Pack`, `Dispatch`, `ReceiveGoods`, `ProposePurchase`, `ReportShortage`, `ResolveShortage`, `ReportRecovery` | `CapturePayment`, `PostShipment`, `PostReceipt`, `RefundDeposit`, `IssueCredit`, `FundPurchase`, `DeclinePurchase`, `PayAds`, `PayStaff`, `OpenIncident`, `ResolveIncident`, `SetSpendFreeze`, `RecoverAgent`, `CloseDay` |
| Cannot | Touch stock, move money, ship | Change prices or promises, post to the ledger, fund anything | Ship, change stock, change promises, create revenue without a shipment |
| Key policy | Available-to-promise: free stock, minus queued backlog, plus funded inbound with its ETA. Promise dates come from that. Re-promises waiting orders when supply changes. | Ships in promise order within 4 parcels an hour. Projects the shortfall as waiting demand plus 2 days of observed demand, minus free and arriving stock. Sizes expedites to fit the budget. | Funds within the purchase limit and cash reserve. Freezes discretionary spend below the reserve. Runs the progress watchdog on Operations. Closes the day with 9 reconciliation checks. |
| Escalates to you | Discounts over 10%, credits over $60, cancellations over $500, ads over $150 a day | (through Finance) purchases over the limit | Purchases above authority, restarting a faulted agent |

## How independence is enforced, not just described
- **Capability gate.** `src/kernel.ts` checks every command against `CAPABILITIES[executingRole]`. A refused command is still logged as a receipt. Test: *role violation*.
- **Status gate.** A paused or faulted agent cannot execute, even when its code is called directly. Test: *a paused or faulted agent cannot act*.
- **No direct messages.** Agents never call each other. Everything goes through committed records and routed events.
- **No self-announcement on failure.** `AgentFailed` has no subscribers, so Finance learns of a crash only by watching progress.
