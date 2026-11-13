# Independent review summary

**Reviewer:** OpenAI Codex CLI v0.166.0, model `gpt-6.1-sol` (from the CLI's own run header, see [PROVENANCE](PROVENANCE.md)), `-s read-only`, high reasoning effort. Codex changed no files. Claude (Opus 5.5) made every fix, and each code fix has a regression test in [`test/regressions.test.ts`](../../test/regressions.test.ts).

**Process:** four area reviews (R1–R4) covered the eight areas in pairs. Each fix-verification pass (R5–R8) re-checked the previous findings and hunted for defects in the fixes. A finding counts as **independently verified** only when a later Codex pass marked it FIXED. A finding fixed after the last pass is marked **fixed, not yet re-verified**.

| Pass | Areas | Verdict | Findings |
|---|---|---|---|
| [R1](R1-ledger-kernel-codex.md) | 1 financial correctness, 2 command kernel and storage | FAIL | 4 high, 2 medium |
| [R2](R2-approvals-http-codex.md) | 3 approvals, 4 HTTP, sessions and isolation | FAIL | 4 medium |
| [R3](R3-agents-failure-codex.md) | 5 agent independence (PASS), 6 failure and recovery | FAIL | 3 high, 1 medium, 1 low |
| [R4](R4-replay-ui-codex.md) | 7 replay, 8 KPI provenance and UI claims | FAIL | 4 medium, 4 low |
| [R5](R5-fix-verification-codex.md) | verification of R1–R4 | FAIL | 5 partial, 2 new medium |
| [R6](R6-fix-verification-2-codex.md) | verification of R5 | FAIL | all R5 items fixed, 2 new medium |
| [R7](R7-fix-verification-3-codex.md) | verification of R6 | FAIL | both R6 items fixed, 2 new medium |
| [R8](R8-release-review-codex.md) | verification of R7, and final review of the whole release tree | FAIL | both R7 items fixed; release: 2 medium, 5 low (docs, config, evidence) |
| [R9](R9-final-verification-codex.md) | verification of R8 on the committed release `9d9077c` | FAIL | all seven R8 items fixed; 1 medium, 1 low (pending items worded as done) |

## Findings, fixes and tests
| ID | Sev | Finding | Fix | Regression test | Status |
|---|---|---|---|---|---|
| R1-1 / R3-1 | High | A kill between the world phase commit and its checkpoint froze the company forever | `advancePhase`: each phase's effects and its checkpoint commit in one transaction (`src/engine.ts`) | `R1-1/R3-1` | verified FIXED (R5) |
| R1-2 / R3-2 | High | Parcels packed by a turn that died were never dispatched | Every running Operations turn dispatches all durable `packed` shipments (`src/agents/operations.ts`) | `R1-2/R3-2` | verified FIXED (R5) |
| R1-3 / R3-3 | High | An escalation that committed before a crash lost its continuation, including recovery requests and decisions made before redelivery | `src/agents/continuations.ts`: `rebuild()` from approvals; `track()` acts on already-decided duplicates; kernel returns `approvalStatus` | `R1-3/R3-3`, `R5: discount denied…`, `R5: recovery request…` | verified FIXED (R6) |
| R1-4 | High | A refused shipment posting was discarded, leaving revenue unposted | Posting tasks stay queued until posted; new reconciliation `shipments-posted` | `R1-4` | verified FIXED (R5) |
| R1-5 | Medium | Cancelling a fully credited order left a phantom deposit | `RefundDeposit` settles Deposits against Refunds with no cash; journal-based idempotency | `R1-5` | verified FIXED (R5) |
| R1-6 | Medium | The UI claimed nothing could take cash below $500 | Reworded: the floor restricts purchase funding | none (UI copy) | verified FIXED (R5) |
| R2-1 | Medium | A purchase approval survived a newly required reserve override | Required overrides are part of the hashed params and the idempotency key | `R2-1`, `R5: overrides change twice` | verified FIXED (R5, R6) |
| R2-2 | Medium | An approval that expired before use stranded the request | Fallback to the role's own authority for discounts and ads; purchases are re-evaluated | `R2-2`, `R5: approved campaign expires…` | verified FIXED (R6) |
| R2-3 | Medium | Concurrent session or reset requests exceeded the company cap | Admission mutex; old company re-resolved inside the gate | `R2-3`, `R5: concurrent resets…` | verified FIXED (R6) |
| R2-4 | Medium | A refused or failed reset deleted the visitor's company | Quota and capacity checked first; replacement created before the old company is dropped | `R2-4`, `R5: creating the replacement fails…` | verified FIXED (R6) |
| R3-4 | Medium | Promises against inbound stock ignored existing deficits and double-counted the order's own demand | `promiseFor`: `need = qty − free`, minus own waiting demand | `R3-4` | verified FIXED (R5) |
| R3-5 | Low | The comparison gave the human two hours while claiming one | Human acts at `clock ≥ requested_at + 1`; measurements regenerated | none (measurement; `docs/evidence/comparisons.json` regenerated) | verified FIXED (R5) |
| R4-1 | Medium | `/api/verify` could report a false mismatch during a concurrent tick | Both reads run in the company's serial lane | `R4-1` | verified FIXED (R5) |
| R4-2 | Medium | The first-promise drill-down hid late orders | `lateVsOriginal` drawer uses `original_promise` | `R4-2/R4-5` | verified FIXED (R5) |
| R4-3 | Medium | Late notifications were described as advance warnings | Narration and UI say "re-promised" | none (UI copy) | verified FIXED (R5) |
| R4-4 | Medium | Approved expedites were narrated as autonomous | Narration branches on the approval reference | none (UI copy) | verified FIXED (R5) |
| R4-5 | Low | The lost-customer drawer listed every customer | Per-KPI customer predicates | `R4-2/R4-5` | verified FIXED (R5) |
| R4-6 | Low | Documents called recognised revenue net when the UI shows gross | `BUSINESS-MODEL.md` distinguishes gross and net | none (docs) | verified FIXED (R5) |
| R4-7 | Low | World event order depended on unspecified SQL row order | `ORDER BY c.id` | `week: the same seed produces the same business` | verified FIXED (R5) |
| R4-8 | Low | Replay's "no side effects" claim ignored the session's `last_active` write | UI claim scoped: business state unchanged, session housekeeping excluded | none (UI copy) | verified FIXED (R5) |
| R5-A | Medium | Purchase funding stalled when the required overrides changed twice | Finance uses an already-approved matching duplicate; declines only on durable PO status | `R5: overrides change twice` | verified FIXED (R6) |
| R5-B | Medium | Reset admission kept a stale slot exemption | Re-resolve the old company inside the gate | `R5: concurrent resets…` | verified FIXED (R6) |
| R6-A | Medium | A rebuilt ads continuation advertised all four products instead of the requested ones | The ads approval binds `skus` in its hashed params, and `rebuild()` reads them | `R6: campaign continuation…` | verified FIXED (R7) |
| R6-B | Medium | A reset whose deletion failed stranded the replacement and used up capacity | If the drop fails, the replacement is dropped and the error re-thrown | `R6: deleting the old company fails…` | verified FIXED (R7) |
| R7-A | Medium | The hash covered the first four SKUs but the whole list was stored and advertised | `PayAds` normalises `skus` once and uses that array for the hash, the expense and the event | `R7: an ads approval cannot be stretched…` | verified FIXED (R8) |
| R7-B | Medium | The ads approval key was the day alone, so a different campaign matched an earlier approval and was dropped | The key is `ads:day:amount:skus`; the payment guard stays one per day | `R7: a different campaign for the same day…` | verified FIXED (R8) |
| R8-1 | Medium | README test counts did not match the published logs | Logs regenerated from the release tree (52/52 SQLite, 52/52 PostgreSQL, 6/6 e2e), and the README matches them | none (evidence) | verified FIXED (R9) |
| R8-2 | Medium | DEPLOY claimed the cockpit stays up after the free database expires | Corrected: the server cannot start without its configured database | none (docs) | verified FIXED (R9) |
| R8-3 | Low | Review reports contained absolute workstation paths | Rewritten to repository-relative links | none (docs) | verified FIXED (R9) |
| R8-4 | Low | README and DEPLOY pointed to missing files | `EXECUTION_STATE.md` added; live checks listed under G15 | none (docs) | verified FIXED (R9) |
| R8-5 | Low | README promised an approve-versus-deny comparison that does not exist | Claim removed; the walkthrough describes the different quote | none (docs) | verified FIXED (R9) |
| R8-6 | Low | FAILURE-TEST said 8/8 checks; there are nine | Changed to 9/9 | none (docs) | verified FIXED (R9) |
| R8-7 | Low | `.gitignore` `public/` also ignored `ui/public/favicon.svg` | Anchored to `/public/` and `/data/` | clean-clone build | verified FIXED (R9) |

The R6 and R7 tests were each confirmed to fail on the pre-fix code and to pass after the fix.

## Final state
| ID | Sev | Finding | Fix | Status |
|---|---|---|---|---|
| R9-1 | Medium | README and film/README said the film was already attached to the release | Both now say it is pending until the release is published | fixed, not yet re-verified |
| R9-2 | Low | REVIEW-SUMMARY linked to the R9 report before it was committed | The report is committed with this summary | fixed, not yet re-verified |

R9 is the last Codex pass. Its two findings are wording and link consistency, and they are fixed but have **not** been re-verified by Codex. Every code finding (R1–R7) was verified FIXED by a later pass.

## Not reviewed by Codex
PostgreSQL execution, disk durability, live sockets and browser rendering were outside what the read-only reviews ran. These are covered by FIRMHAND's own PostgreSQL suite, durability tests and Playwright runs ([`../evidence/`](../evidence/)).
