You are an independent co-architect. Do NOT read any other files in this directory except this prompt. Propose, independently, "Architecture B" for a DOO Builders League entry: "The Autonomous Company Simulator".

Challenge (verified): "Can a business operating loop run through accountable AI systems rather than disconnected tools?" Build a working slice of a small company run as a loop of accountable AI agents. Must have: >=3 connected agent roles (sales, ops, finance) sharing state through a common record system; a run-the-week loop where agents act on shared records and escalate to a human inbox; numbers (revenue, cost, backlog, churn) that move and can be replayed by day; at least one scenario where the company self-corrects without human input; a failure test where one role goes off and others compensate or escalate. Judging: conceptual clarity 25, technical depth 25 ("real shared state, real escalations, replayable"), demo quality 20, failure thinking 15, future thesis 15. DQ: one agent pretending to be three; no shared state; no demo. Deadline: ~3 days. Free hosting only (Render free web service + free Postgres 16, sleeps, 512MB). No runtime LLM calls (deterministic role planners). Each public visitor gets an isolated synthetic company. Stack preference: TypeScript, Node 24 (native type stripping), React+Vite, Postgres on host / SQLite (node:sqlite) locally, SSE, Playwright.

Deliver (markdown, <= 1800 words, dense):
1. Three product names + taglines (evaluate LEDGERLOOP too) and your pick.
2. Company model (fictional DTC commerce suggested; catalog, suppliers, assumptions).
3. Role boundaries: each agent's capabilities, forbidden actions, task inbox, decision policy; how independence is real (separate queues, pausable, fault-injectable) and not one planner in three hats.
4. Shared data model (tables) and the 12 invariants: no negative stock, idempotent payments, refund caps, no double reservation, revenue != bookings, approvals bound to action+params+state version, stale decisions revalidated, etc. How enforced (transactions, constraints, unique keys).
5. Financial semantics: integer cents, double-entry journal or simpler; when revenue is recognized (shipment?), when cash moves, COGS, refunds, budgets. Accounts list.
6. Event/command architecture: how agents coordinate (event outbox + per-role inbox?), virtual clock, determinism (seeded RNG), ordering, idempotency keys.
7. Run-the-week engine: what one simulated day consists of; how tick/step runs on a free host that sleeps (request-driven stepping vs background loop).
8. Human approval policy with exact thresholds; backend enforcement; binding hash; expiry; deny consequences.
9. Self-correction scenario (no human) with measurable outcome.
10. Failure scenario (Operations down): detection (heartbeat/progress watchdog by whom?), compensation by Sales/Finance, escalation, recovery reconciliation without double shipment; naive-baseline comparison.
11. Replay: event-sourced reconstruction vs snapshots; zero side effects.
12. Top 10 risks / ways a judge could catch this as fake, and how to defeat each.
13. Where you'd disagree with an obvious "3 deterministic bots on a shared SQLite" design.
Be concrete and opinionated.
