All 18 regressions passed using in-memory SQLite, stubbed file writes, and direct HTTP-handler calls.

- **R1-3 — FIXED.** Finance reconstructs pending recovery continuations before its watchdog runs. [continuations.ts:17](../../src/agents/continuations.ts#L17), [finance.ts:11](../../src/agents/finance.ts#L11).
- **R2-2 — FIXED.** An expired approved campaign falls back to Finance’s autonomous spending limit. [finance.ts:95](../../src/agents/finance.ts#L95).
- **R2-3 / stale reset exemption — FIXED.** Admission re-resolves the old company inside the gate before subtracting its slot. [server.ts:104](../../src/server.ts#L104).
- **R2-4 — FIXED.** Replacement creation precedes deletion, preserving the existing company when creation fails. [server.ts:108](../../src/server.ts#L108).
- **R3-3 — FIXED.** Decided duplicates return their approval ID/status; `track()` immediately dispatches the recorded outcome, including denial. [kernel.ts:226](../../src/kernel.ts#L226), [continuations.ts:32](../../src/agents/continuations.ts#L32).
- **Funding after two override changes — FIXED.** Re-evaluation immediately uses an already-approved matching duplicate; durable PO status prevents subsequently declining the funded purchase. [finance.ts:83](../../src/agents/finance.ts#L83), [finance.ts:85](../../src/agents/finance.ts#L85).

Two new defects reproduced:

- **Medium — reconstructed campaigns advertise different products.** [finance.ts:13](../../src/agents/finance.ts#L13) substitutes all four SKUs. Concrete scenario: request a 20,000-cent KETTLE-only campaign; kill Finance’s memory checkpoint after escalation; enqueue 401 context tasks before granting approval; freeze spending while the original request is redelivered. That request is rejected, leaving the reconstructed continuation until the queued grant arrives. After unfreezing, Finance pays for advertising **all four products**. The uninterrupted control preserves KETTLE only. **Minimal fix:** recover `skus` from the original durable `AdSpendRequested` event instead of inventing a replacement list.

- **Medium — failed deletion strands a replacement and consumes capacity.** [server.ts:108](../../src/server.ts#L108), [server.ts:109](../../src/server.ts#L109). With `maxCompanies:1`, let creation succeed and make deletion of the old company fail. Reset returns 500 without delivering the replacement cookie, but both companies remain; retry returns 503. **Minimal fix:** make replacement creation and old-company deletion one database transaction, preserving the old company and rolling back the replacement on failure.

No unbounded recursion, duplicate financial effect, cross-role authority bypass, or new nondeterministic ordering was reproduced. `track()` bounds nested duplicate handling; command validation retains company/requester/hash checks and durable idempotency. Rebuilding executed approvals with queued outcomes can repeat handler attempts, but the checked paths refused a second effect.

Not checked: PostgreSQL, disk durability, live sockets, or browser behavior.
**Overall verdict: FAIL.**