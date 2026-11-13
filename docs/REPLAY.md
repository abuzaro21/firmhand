# Replay

## What is stored
Every event that changes business state carries **facts** in its payload, written in the same transaction as the change itself:
- journal postings (account, debit, credit);
- stock deltas (on hand, reserved and value per SKU);
- order and customer status changes;
- counters (booked, shipped, churned).

Facts are what happened, not instructions to repeat it.

## How a day is replayed
`src/replay.ts` is a pure reducer. It starts from the snapshot at the previous day's close, or from genesis, and applies the facts of each event in `seq` order up to the chosen point. It never calls an agent, a command, the scheduler or inbox delivery. It runs inside a GET request.

The Replay tab shows the result step by step: revenue, cash, deposits, net income, bookings, backlog, shipped, lost customers and free stock per SKU, together with the events up to that point.

## How it is checked
| Check | Where |
|---|---|
| **No side effects on business state.** The server takes a digest of every business table of the company before and after the replay; they must be equal. The UI shows both digests. Session housekeeping is excluded: resolving the visitor's cookie refreshes `companies.last_active`, which only extends the idle timeout, and is not part of the digest. | `GET /api/replay/:day` → `sideEffects` |
| **Replay = close.** For a closed day, the replay's final checksum must equal the checksum in that day's close snapshot. | Replay tab badge; `test/week.test.ts` for every day of 5 seeds |
| **Whole company.** Rebuild everything from the log and compare with the live tables. | Proof → Verify now; `GET /api/verify` |
| **Determinism.** The same seed under a different company id produces the same checksum; a different seed differs. | `test/week.test.ts` |

## What the checksum is, and is not
The checksum is a SHA-256 digest of a canonical form of the state: account balances, stock, order statuses and customer statuses. It answers one question: "does the log explain the tables?" It is **not** a signature, a hash chain or tamper evidence. Someone with database access could change both the tables and the log consistently.

## Counterfactual
Replay itself never branches. The *what-if* is a separate, labelled feature, the comparison on the Proof tab. It runs the same seed and the same injected event on two brand-new in-memory companies, one with FIRMHAND's policies and one naive. It never touches the visitor's company or the hosted database.
