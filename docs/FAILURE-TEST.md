# Failure test: Operations crashes mid-turn

**Trigger** (Day 5, 12:00, or whenever injected): Operations crashes part-way through its turn. By then it has committed some commands, for example packing parcels, but not dispatched them. The partial work is real and committed. The agent's in-memory beliefs for that turn are lost, and its status becomes `faulted`.

`AgentFailed` is routed to **nobody**. Operations does not announce its own death.

## Detection, compensation, escalation, recovery
| Step | Who | What | Seed 7 timing |
|---|---|---|---|
| Crash | — | Operations faulted mid-turn; parcels packed, not dispatched | hour 35 (D5 12:00) |
| **Detection** | Finance | Progress watchdog: eligible work (paid orders, packed parcels, arrived goods) has existed for ≥ 2 business hours with no Operations progress. Opens `INC-ops-stalled`. | hour 37 |
| **Containment** | Finance | `SetSpendFreeze` stops discretionary ad spend; emits `CapacityLost` with the exposure (deposits held for orders that cannot ship) | hour 37 |
| **Compensation** | Sales | On `CapacityLost`: no more near-date promises, quotes use after-recovery dates, and waiting customers are re-promised | hours 37–38 |
| **Escalation** | Finance | `RecoverAgent` above all authority, so it lands in the human inbox with evidence: stalled hours, packed parcels, backlog, deposits at risk | hour 37 |
| **Recovery** | Human, then Operations | On approval Operations restarts and runs `ReportRecovery` *before any new work*. It dispatches each packed parcel exactly once, because shipments are unique per order, and drains the backlog. The inbox redelivers at-least-once, and idempotency makes it harmless. | hour 38 in the comparison (the simulated human answers one hour after the request) |
| **Close** | Finance | Lifts the freeze when safe, resolves the incident, and the day closes 9/9 | same day |

## Against a naive baseline
The naive run has `watchdog: false` and `selfCorrect: false`, the same seed and the same crash. Nobody notices, so Operations stays faulted to the end of the week. The human gets the same one-hour answer time in both runs; nothing is ever asked of the human in the naive run.

| Seed | Backlog at week end (FIRMHAND / naive) | Late vs first promise | Lost customers | Revenue | Ops at week end |
|---|---|---|---|---|---|
| 7 | **3** / 61 | **0** / 42 | **0** / 5 | **$13,094** / $7,896 | running / faulted |
| 11 | **5** / 62 | **0** / 38 | **0** / 13 | **$12,379** / $8,399 | running / faulted |
| 23 | **2** / 65 | **0** / 47 | **0** / 1 | **$11,317** / $6,698 | running / faulted |
| 42 | **3** / 58 | **0** / 45 | **0** / 3 | **$13,416** / $8,515 | running / faulted |
| 101 | **3** / 59 | **0** / 37 | **0** / 3 | **$12,443** / $6,818 | running / faulted |

In every run, managed and naive, the books still reconcile: a crash never corrupts the ledger. Full table: [`evidence/comparisons.md`](evidence/comparisons.md).

## Proven by
- `test/adversarial.test.ts`: *operations crash mid-turn: detection, compensation, human-approved recovery, exactly-once dispatch*. It asserts detection within 3 hours, the freeze, `CapacityLost`, the executed recovery approval, `RecoveryReconciled`, and exactly one shipment per order.
- `test/adversarial.test.ts`: *restart: a pending approval and a half-finished tick survive a process restart and resume exactly once*. This is the infrastructure version of the same failure: the server process itself dies mid-tick.
