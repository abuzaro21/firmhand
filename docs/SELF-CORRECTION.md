# Self-correction: an inventory shock with no human

**Trigger** (Day 3, 10:00, or whenever injected): demand for the grinder goes ×4 for two days, and the main supplier's grinder deliveries slip 3 days. Other SKUs keep their normal lead time.

**What happens, with no approval needed:**
1. **Operations notices.** On its next turn it projects the grinder shortfall: waiting demand plus two days of observed demand, minus free stock and stock arriving within two days. It reports the shortage, which opens incident `INC-shortage-GRINDER-n`.
2. **Operations sizes an expedite.** It proposes a Swiftline purchase order, 1-day lead time at +35% cost, sized to the gap and capped to fit the remaining weekly expedite budget.
3. **Finance funds it.** It checks the expedite budget ($1,500 a week) and the $3,000 cash reserve, and funds the purchase order within its own authority. If the purchase did not fit, it would escalate instead.
4. **Sales adapts.** Its available-to-promise model now includes the expedite's arrival. New quotes carry honest dates. Customers already waiting are re-promised, receive a $5 goodwill credit (paid by Finance), and get a new date.
5. **Operations ships in promise order** as stock lands, and resolves the shortage when the projection reaches zero.

The cockpit shows each step as a receipt in the relevant lane, and the Watch view narrates it from the events.

## Measured result
The managed and naive runs are isolated in-memory companies with the same seed and the same shock. The naive run has `selfCorrect: false`: Sales always promises next-day, never warns anyone, and Operations makes no expedite. In both runs the simulated human answers any escalation exactly one business hour after it appears (approve). The watchdog stays on in both. Full table: [`evidence/comparisons.md`](evidence/comparisons.md).

| Seed | Lost customers (FIRMHAND / naive) | Late vs first promise | Revenue | Net income | Expedite spent | Human decisions (FIRMHAND) |
|---|---|---|---|---|---|---|
| 7 | **0** / 8 | **0** / 8 | **$13,775** / $11,086 | **$4,311** / $3,176 | $1,500 | 0 |
| 11 | **0** / 11 | **1** / 22 | **$12,725** / $12,095 | $3,855 / **$3,894** | $1,500 | 0 |
| 23 | **0** / 7 | **0** / 5 | **$13,931** / $11,225 | **$4,405** / $3,289 | $1,423 | 0 |
| 42 | **0** / 11 | **0** / 6 | **$15,123** / $12,741 | **$5,324** / $4,455 | $1,500 | 0 |
| 101 | **0** / 10 | **0** / 11 | **$14,153** / $11,367 | **$4,756** / $3,645 | $1,472 | 0 |

**Honest reading:**
- Self-correction keeps customers on every seed.
- It costs up to the full expedite budget.
- On seed 11 it ends the week with $39 *less* net income than doing nothing, because the expedite premium and credits outweigh the revenue it saved within the week. One order there still ships later than first promised, because the shock outran the budget.
- The budget is the human's lever. Raising it would trade cash for customers.

Test: `self-correction needs no human: the inventory shock is handled with zero approvals and a bounded budget` (`test/adversarial.test.ts`).
