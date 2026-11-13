30 in-memory tests and 12 additional phase/HTTP-handler checks passed. The fixes remain incomplete.

- **R1-1 — FIXED.** World effects and checkpoint commit together; role completion, skip and fault paths also checkpoint atomically. [engine.ts:110](../../src/engine.ts#L110), [engine.ts:144](../../src/engine.ts#L144), [engine.ts:170](../../src/engine.ts#L170), [engine.ts:181](../../src/engine.ts#L181).
- **R1-2 — FIXED.** Normal Operations turns dispatch every durable packed shipment, including parcels from interrupted turns. [operations.ts:42](../../src/agents/operations.ts#L42).
- **R1-3 — PARTIAL.** Duplicate requests rebuild task-driven continuations, but recovery’s pending-request guard prevents reconstruction after a lost Finance checkpoint; approving that request leaves Operations faulted. [finance.ts:55](../../src/agents/finance.ts#L55), [finance.ts:125](../../src/agents/finance.ts#L125).
- **R1-4 — FIXED.** Refused postings remain queued; `continue` permits later tasks to run, without retrying within the turn. Reconciliation detects unposted dispatches. [finance.ts:19](../../src/agents/finance.ts#L19), [kpi.ts:95](../../src/kpi.ts#L95).
- **R1-5 — FIXED.** Zero-cash settlement clears Deposits against Refunds, uses the journal entry for idempotency, and reconciles correctly. [commands.ts:245](../../src/commands.ts#L245), [kpi.ts:84](../../src/kpi.ts#L84).
- **R1-6 — FIXED.** UI now identifies the floor as a purchase-funding restriction. [Proof.tsx:72](../../ui/src/Proof.tsx#L72).

- **R2-1 — FIXED.** Required override categories enter the hashed parameters; newly requiring reserve permission rejects the original approval. [commands.ts:299](../../src/commands.ts#L299).
- **R2-2 — PARTIAL.** Sales discounts and purchases have immediate fallbacks, but stale approved advertising is still discarded without replanning; reproduced with zero advertising expenses and empty pending memory. [sales.ts:114](../../src/agents/sales.ts#L114), [finance.ts:93](../../src/agents/finance.ts#L93).
- **R2-3 — PARTIAL.** Fresh admissions serialize correctly; concurrent resets sharing one cookie still exceed the cap because the captured old company is subtracted after deletion. [server.ts:96](../../src/server.ts#L96), [server.ts:102](../../src/server.ts#L102).
- **R2-4 — PARTIAL.** Quota refusal preserves the company, but replacement creation still follows deletion; injected creation failure returned 500 and invalidated the existing session. [server.ts:101](../../src/server.ts#L101), [server.ts:104](../../src/server.ts#L104).

- **R3-1 — FIXED.** World transaction includes its phase checkpoint. [engine.ts:110](../../src/engine.ts#L110).
- **R3-2 — FIXED.** Dispatch reconciles durable packed records without requiring recovery memory. [operations.ts:42](../../src/agents/operations.ts#L42).
- **R3-3 — PARTIAL.** Denying a discount request before crash redelivery still loses its continuation: terminal duplicates return no approval ID, and the outcome handler requires memory. Reproduced: lead remains `new`, no quote. [kernel.ts:225](../../src/kernel.ts#L225), [sales.ts:108](../../src/agents/sales.ts#L108).
- **R3-4 — FIXED.** Promise arithmetic preserves negative availability and subtracts an existing order’s own waiting demand. [sales.ts:19](../../src/agents/sales.ts#L19), [sales.ts:130](../../src/agents/sales.ts#L130).
- **R3-5 — FIXED.** Approval eligibility uses the advanced company clock. [compare.ts:27](../../src/compare.ts#L27).

- **R4-1 — FIXED.** Both verification reads share the company’s serial lane; concurrent handler probes matched. [server.ts:154](../../src/server.ts#L154).
- **R4-2 — FIXED.** Drawer uses `original_promise`, and UI passes the original KPI key. [engine.ts:300](../../src/engine.ts#L300), [App.tsx:84](../../ui/src/App.tsx#L84).
- **R4-3 — FIXED.** Narration and both displays describe re-promising without claiming advance warning. [story.ts:46](../../ui/src/story.ts#L46), [parts.tsx:38](../../ui/src/parts.tsx#L38), [Proof.tsx:10](../../ui/src/Proof.tsx#L10).
- **R4-4 — FIXED.** Expedite narration branches on the approval reference. [story.ts:22](../../ui/src/story.ts#L22).
- **R4-5 — FIXED.** Customer drawers apply the corresponding status predicate. [engine.ts:306](../../src/engine.ts#L306).
- **R4-6 — FIXED.** Documentation distinguishes gross recognised revenue from net revenue. [BUSINESS-MODEL.md:23](../../docs/BUSINESS-MODEL.md#L23).
- **R4-7 — FIXED.** Customer-status accumulation now orders by customer ID. [world.ts:79](../../src/world.ts#L79).
- **R4-8 — FIXED.** Replay explicitly excludes session housekeeping from its unchanged-business-state claim. [Replay.tsx:45](../../ui/src/Replay.tsx#L45).

Two additional defects in the fix paths:

- **Medium — funding can stall after override requirements change twice.** [finance.ts:85](../../src/agents/finance.ts#L85), [kernel.ts:225](../../src/kernel.ts#L225): approve AP-1 for `limit`; falling cash causes AP-2 for `limit+reserve`; restore cash before executing approved AP-2. Finance reattaches AP-1, whose grant event was already consumed. Reproduced: PO remains proposed, both approvals approved, no queued outcome. **Minimal fix:** execute an already-approved matching duplicate rather than waiting for another grant event.
- **Medium — reset admission retains a stale slot exemption.** [server.ts:102](../../src/server.ts#L102): eight concurrent resets sharing one cookie with `maxCompanies:1` produced two successful replacements and two companies. **Minimal fix:** revalidate the old company inside the admission gate before granting its slot exemption.

Not checked: PostgreSQL, disk durability or browser rendering. Tests used in-memory SQLite with `pg` stubbed; HTTP probes opened no sockets.

**Overall verdict: FAIL — approval continuations and reset admission/replacement remain incomplete.**