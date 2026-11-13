Reviewed committed tree `9d9077c`.

- **R8-1 FIXED** — `README.md:70` matches SQLite/PostgreSQL logs (`docs/evidence/test-sqlite.txt:59,61`, `test-pg.txt:59,61`) and e2e results (`test-e2e.txt:11`): 52/52, 52/52, 6/6.
- **R8-2 FIXED** — `docs/DEPLOY.md:36` correctly describes startup failure after database expiry; matches `src/main.ts:5,15` and `src/db.ts:208`.
- **R8-3 FIXED** — Review links are repository-relative, including `docs/reviews/R1-ledger-kernel-codex.md:3` and `R7-fix-verification-3-codex.md:1`; tracked-text scan found no workstation paths.
- **R8-4 FIXED** — `docs/EXECUTION_STATE.md:13–15,36` explicitly records pending deployment and G15 checks; `docs/DEPLOY.md:32` links there.
- **R8-5 FIXED** — `README.md:42` describes the approval/denial outcomes without promising a comparison feature.
- **R8-6 FIXED** — `docs/FAILURE-TEST.md:16` says 9/9, matching the nine checks in `src/kpi.ts:67–101`.
- **R8-7 FIXED** — `.gitignore:2` anchors `/public/`; `ui/public/favicon.svg:1` is tracked and is no longer ignored.

Two release defects remain:

- **Medium — `README.md:12`; `film/README.md:5`: contradictory film availability.** Both assert that the MP4 is attached to the v1.0.0 release, while `docs/EXECUTION_STATE.md:16` explicitly says it is not yet attached. **Minimal fix:** mark attachment pending consistently until completed.
- **Low — `docs/reviews/REVIEW-SUMMARY.md:17`: broken relative link.** `R9-final-verification-codex.md` does not exist in the committed tree. **Minimal fix:** replace the link with an explicit pending label until the report is tracked.

No additional sensitive-content findings. Tests were not rerun because regression setup creates temporary files; runtime behavior remains unverified by this pass.

Overall verdict: FAIL