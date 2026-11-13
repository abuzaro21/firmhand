**Area (5): the implemented agents are separate policies, with distinct durable queues, memory, status and pause handling. I found no off-role command calls; execution binds commands to the scheduler’s role identity.**

Five defects in area (6):

1. **High — A process restart can permanently freeze the company.** [src/engine.ts:102](../../src/engine.ts#L102)  
   The world transaction commits before the phase marker advances. Kill the process between those commits at tick 0: restarting reruns the world phase and throws `Duplicate event day-start:1` indefinitely. The in-memory interruption probe remained at `clock=0, phase=0` after repeated attempts.  
   **Minimal fix:** update the world phase marker inside the same transaction as `worldPhase`.

2. **High — Interrupted packing leaves parcels stranded after process restart.** [src/agents/operations.ts:9](../../src/agents/operations.ts#L9), [src/agents/operations.ts:40](../../src/agents/operations.ts#L40)  
   Kill the process after `Pack` commits but before dispatch. Operations remains marked `running`, and `memory.recovering` remains false. Its next turn selects reserved orders and dispatches only newly packed parcels; the existing packed parcel is skipped. Finance cannot request recovery because it requires Operations to be `faulted`. Reproduced with seed 7: `O-1` remained packed through week end, with no recovery approval.  
   **Minimal fix:** reconcile existing packed shipments before new work on every running Operations turn, using the existing idempotent `Dispatch` handler.

3. **High — Committed approvals lose their continuation across a crash.** [src/engine.ts:173](../../src/engine.ts#L173), [src/kernel.ts:222](../../src/kernel.ts#L222), [src/agents/sales.ts:99](../../src/agents/sales.ts#L99)  
   Crash after an escalation commits but before the requester’s memory checkpoint. On redelivery, escalation returns `duplicate`, so the policy never restores `mem.pending`. Approval outcomes then return immediately because that memory entry is absent. Reproduced with a big-discount request: `AP-1` stayed approved while its lead remained new with no quote after ten more ticks.  
   **Minimal fix:** reconstruct approval continuations from durable approval/decision records when memory is absent, including after duplicate escalation results.

4. **Medium — Sales discards existing supply deficits when promising against inbound stock.** [src/agents/sales.ts:24](../../src/agents/sales.ts#L24)  
   At tick 20, suppose no stock is free, ten older one-unit orders are waiting, and five units arrive at tick 30. A new two-unit lead receives a tick-34 promise: `Math.max(0, s.free)` erases the ten-unit deficit, so five inbound units appear sufficient. Those units actually serve older orders first. The function probe returned “covered by inbound stock.”  
   **Minimal fix:** preserve negative availability when calculating inbound requirements, using `qty - s.free`; exclude the current order’s own demand when recalculating an existing order’s promise.

5. **Low — The comparison applies a two-hour human response while claiming one hour.** [src/compare.ts:24](../../src/compare.ts#L24)  
   `tick()` advances the company clock before the approval loop, but eligibility uses the previous tick index. In seed 7’s crash comparison, recovery is requested at tick 37 and approved at tick 39. This changes recovery timing and reported outcomes.  
   **Minimal fix:** compare the current company clock against `requested_at + 1`, then regenerate the published measurements.

The isolated shock completed without approvals for all five selectable seeds. Scheduled crash recovery produced no duplicate dispatches in those probes. The baseline is explicitly labelled synthetic and uses isolated companies with matching seeds and injections; the timing claim above needs correction.

Not checked: PostgreSQL, browser execution or filesystem durability; interruption probes used in-memory SQLite. No files changed or network commands run.

**Verdict (5): PASS for the implemented deterministic policies.**  
**Verdict (6): FAIL — restart recovery and promise arithmetic require fixes.**