- **1 — FIXED.** Approval params now preserve the requested products, and Finance rebuilds from those params: [commands.ts:328](../../src/commands.ts#L328), [finance.ts:13](../../src/agents/finance.ts#L13).
- **2 — FIXED.** Failed old-company deletion triggers replacement deletion before returning 500: [server.ts:112](../../src/server.ts#L112). Concurrent reset fault injection preserved capacity and the successful replacement’s cookie.

Two defects remain in the new approval binding:

- **Medium — hashed products differ from executed products.** [commands.ts:328](../../src/commands.ts#L328) hashes only the first four stringified entries, but [commands.ts:333](../../src/commands.ts#L333) stores the entire raw list. Reproduced: approve four `KETTLE` entries, then present that approval with `GRINDER` appended fifth. Execution commits, advertising the unapproved product; demand uses this stored list at [world.ts:89](../../src/world.ts#L89). **Minimal fix:** normalize once and use the same array for hashing, expense storage, and event emission.

- **Medium — day-only approval key collides with different bound products.** [commands.ts:330](../../src/commands.ts#L330) retains `ads:${day}`, and [kernel.ts:221](../../src/kernel.ts#L221) matches duplicates without comparing params. Reproduced: approve an unpaid 20,000-cent KETTLE campaign, then attempt DRIPPER for the same day. The kernel returns KETTLE’s approval; [continuations.ts:31](../../src/agents/continuations.ts#L31) overwrites its continuation. Execution rejects the product mismatch, deletes the continuation, and files no fresh approval. **Minimal fix:** include canonical params/hash in the approval key; retain the day-only payment guard.

All 20 regressions passed using in-memory SQLite, stubbed writes, and direct HTTP-handler calls. No new reset-undo defect reproduced.

Not checked: PostgreSQL, disk durability, live sockets, or browsers. The additional findings were reproduced through command and continuation harnesses.

**Overall verdict: FAIL.**