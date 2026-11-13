You are an independent, adversarial code reviewer for FIRMHAND, a public challenge entry: a TypeScript (Node 24 native type stripping) company simulator run by three deterministic agents (Sales, Operations, Finance) over one shared record system (SQLite or PostgreSQL 16), with a double-entry journal in integer cents, per-role task inboxes, a hash-bound human approval inbox, and isolated per-visitor companies. There are no runtime LLM calls.

Rules: READ-ONLY. Do not modify, create or delete any file. Do not run network commands. You may read any file under this directory and run read-only commands, including `node --disable-warning=ExperimentalWarning --test test/regressions.test.ts` (in-memory SQLite). Do not read data/ or node_modules/.

Task: the previous verification (docs/reviews/R6-fix-verification-2-codex.md) returned FAIL with two new medium defects:
1. a rebuilt ads continuation substituted all four SKUs for the products Sales requested;
2. a reset whose deletion of the old company fails strands the replacement and consumes capacity.
They were addressed by:
- src/commands.ts PayAds: the ads approval's params now bind `skus` (normalised: first four, as strings), so the hash covers the products; src/agents/finance.ts rebuild() reads `skus` from the approval params;
- src/server.ts reset admission: if deleting the old company throws, the replacement is deleted and the error re-thrown (500); if that undo also fails, the replacement has no cookie and idle expiry reclaims it;
- tests prefixed `R6:` in test/regressions.test.ts.

For each of the two items say FIXED, PARTIAL or NOT FIXED with file:line evidence in one or two lines. Then look for NEW defects introduced by these two changes only: can an approval filed with the new params be matched, executed or re-used incorrectly (for example a campaign with different products reusing an older approval for the same day, or the duplicate/idempotency key `ads:${day}` now conflicting with the bound params)? Can the reset undo delete a company someone holds a cookie for, or race a concurrent request? For each new defect: severity, file:line, concrete scenario, minimal fix. No style comments. End with a one-line overall verdict (PASS or FAIL). At most 500 words.
