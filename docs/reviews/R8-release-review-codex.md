- **Hashed versus executed products — FIXED.** One normalized array is hashed, stored, and emitted: [commands.ts:325](../../src/commands.ts#L325), [commands.ts:331](../../src/commands.ts#L331), [commands.ts:335](../../src/commands.ts#L335), [commands.ts:337](../../src/commands.ts#L337).
- **Day-only approval-key collision — FIXED.** The key now includes amount and products at [commands.ts:332](../../src/commands.ts#L332); the payment guard remains day-only at [commands.ts:334](../../src/commands.ts#L334).

Probes with two different approved campaigns produced exactly one payment and one ads journal entry. Executing the second approval returned `duplicate`; transaction rollback preserved its previous approval status. Finance cleared its continuation without looping: [kernel.ts:196](../../src/kernel.ts#L196), [finance.ts:75](../../src/agents/finance.ts#L75), [continuations.ts:34](../../src/agents/continuations.ts#L34).

Release defects:

- **Medium — unsupported release-test evidence.** [README.md:70](../../README.md#L70) claims 50/50 tests on both databases. The current suite defines **52** cases, while both supplied logs report **42**: [test-sqlite.txt:47](../../docs/evidence/test-sqlite.txt#L47), [test-pg.txt:47](../../docs/evidence/test-pg.txt#L47). **Minimal fix:** publish results from the release tree and update the claim to those verified counts.

- **Medium — incorrect database-expiry availability claim.** [DEPLOY.md:36](../../docs/DEPLOY.md#L36) says the cockpit remains available after database expiry. A subsequent cold start awaits database initialization before listening: [main.ts:5](../../src/main.ts#L5), [main.ts:15](../../src/main.ts#L15). With `DATABASE_URL` still configured, failure does not fall back to SQLite: [db.ts:208](../../src/db.ts#L208). **Minimal fix:** document that a cold start remains unavailable until the database configuration is repaired.

- **Low — machine-specific paths are published.** Review reports contain absolute workstation links such as `/...`: [R1-ledger-kernel-codex.md:3](../../docs/reviews/R1-ledger-kernel-codex.md#L3), [R7-fix-verification-3-codex.md:1](../../docs/reviews/R7-fix-verification-3-codex.md#L1). They expose local layout and break public navigation. **Minimal fix:** convert these links throughout the review reports to repository-relative paths.

- **Low — live-demo instructions point to missing files.** [README.md:11](../../README.md#L11) promises the current URL through nonexistent `docs/EXECUTION_STATE.md`; `DEPLOY.md` contains setup instructions rather than that URL. [DEPLOY.md:32](../../docs/DEPLOY.md#L32) also references nonexistent `evidence/live-check.md`. **Minimal fix:** provide the referenced documents and actual demo link, or explicitly mark them pending.

- **Low — nonexistent approval comparison.** [README.md:42](../../README.md#L42) promises a comparison showing approve-versus-deny outcomes. The implemented comparisons cover only inventory shock and Operations failure: [compare.ts:8](../../src/compare.ts#L8). **Minimal fix:** remove that comparison claim.

- **Low — stale reconciliation count.** [FAILURE-TEST.md:16](../../docs/FAILURE-TEST.md#L16) says “8/8”; reconciliation now returns nine checks, including `shipments-posted`: [kpi.ts:96](../../src/kpi.ts#L96). **Minimal fix:** change it to “9/9.”

- **Low — source favicon excluded from initial publication.** [`.gitignore:2`](../../.gitignore#L2) uses unanchored `public/`, which also ignores `ui/public/favicon.svg`, referenced at [index.html:8](../../ui/index.html#L8). Confirmed with `git check-ignore`. **Minimal fix:** use `/public/` to exclude only root build output.

All 22 regressions and seven full-week SQLite tests passed with the unused PostgreSQL import stubbed and temporary-file writes suppressed. Seed-7 comparison figures matched. No additional concrete server-security or deployment-configuration defect was established.

Not checked: PostgreSQL execution, clean Docker builds, browsers, or live hosting; those release risks remain unverified.

Overall verdict: FAIL