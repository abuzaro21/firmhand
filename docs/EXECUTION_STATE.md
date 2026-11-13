# Execution state

_Last updated 2026-11-13. This file records what is actually true, with evidence. Nothing is marked PASS without it._

## Snapshot
| | |
|---|---|
| Repository | [`abuzaro21/firmhand`](https://github.com/abuzaro21/firmhand), **public**, branch `main` (latest commit: see `git log -1`) |
| Release | [v1.0.0](https://github.com/abuzaro21/firmhand/releases/tag/v1.0.0) (tag on `c2f0916`) with `firmhand-film.mp4` and `firmhand-film.srt` attached |
| Live URL | **https://firmhand-e2vl.onrender.com** (Render free plan, Frankfurt; it sleeps after about 15 idle minutes, and waking takes up to about a minute) |
| Render resources | Workspace FIRMHAND (dedicated to this project). Blueprint `firmhand` (`render.yaml`, auto-sync off): web service `firmhand-e2vl` (free, Docker) and database `firmhand-db-e2vl` (free PostgreSQL 16, `ipAllowList: []`) |
| Free database expiry | **2026-12-13 13:02 UTC**. After that date the service cannot start until a new database is attached ([DEPLOY.md](DEPLOY.md)) |
| Running services | the Render web service and database above |
| Last Codex verdict | R9 (`gpt-6.1-sol`, read-only) on commit `9d9077c`: FAIL on two wording and link items, which are fixed but not re-verified. Every code finding from R1–R7 was verified FIXED by a later pass. See [reviews/REVIEW-SUMMARY.md](reviews/REVIEW-SUMMARY.md) |
| Tests | typecheck PASS · `npm test` 52/52 SQLite · 52/52 PostgreSQL 16 · e2e 6/6 (desktop and mobile Chromium) · `npm audit` 0 vulnerabilities · GitHub Actions green |
| Film | `firmhand-film.mp4`, 89.47 s, 1080p30, H.264/AAC, machine-checked and attached to the release. **Not uploaded to YouTube**; the owner uploads it |
| DOO submission | **not submitted**; the owner submits it |

## Gates
| Gate | Status | Evidence |
|---|---|---|
| G1 Architecture: two independent proposals, reconciled | PASS | [reviews/architecture-A-claude.md](reviews/architecture-A-claude.md), [reviews/architecture-B-codex.md](reviews/architecture-B-codex.md), [ARCHITECTURE-DECISIONS.md](ARCHITECTURE-DECISIONS.md) |
| G2 Three independent agents | PASS | `src/agents/*.ts`; per-role inboxes, memory, status and permissions; R3 area 5 PASS; tests *role violation…* and *a paused or faulted agent cannot act…* |
| G3 Shared durable state | PASS | One kernel and one transaction per command (`src/kernel.ts`). SQLite and PostgreSQL run the same DDL and the same 52 tests |
| G4 Real operations | PASS | Quotes, orders, payments, reservations, packing, dispatch, purchasing, receipts, credits, refunds, ads and staff, all posted to the journal |
| G5 KPIs reconcile and drill down | PASS | `src/kpi.ts` nine reconciliation checks; test *R4-2/R4-5: every KPI drawer returns exactly the records its tile counts*; live: nine checks pass and the drill-down returns rows |
| G6 Week reproducible | PASS | `test/week.test.ts`: 5 seeds each close 7 days, and the same seed gives the same checksum |
| G7 Approval and denial change outcomes | PASS | Approve: the 18% quote is executed under the approval. Deny: the quote is 10% (test *R5: a discount denied…*). Test *approval binding…*; live: approvals executed with the shown hash, forged hash refused |
| G8 Self-correction vs naive | PASS | [SELF-CORRECTION.md](SELF-CORRECTION.md), [evidence/comparisons.md](evidence/comparisons.md): 0 vs 8 customers lost, $13,775 vs $11,086; live: expedite POs funded with no human |
| G9 Failure and compensation vs naive | PASS | [FAILURE-TEST.md](FAILURE-TEST.md): backlog 3 vs 61, 0 vs 5 customers lost; test *operations crash mid-turn…*; live: `ops-stalled` incident opened and resolved, all agents running at week end |
| G10 Replay with no side effects | PASS | [REPLAY.md](REPLAY.md); tests *day replay is read-only…*, *replay over HTTP…*, R4-1; live: Day 3 replay `sideEffects.none` and close matched, whole-company replay matches live |
| G11 Durability | PASS | Tests *restart: a pending approval and a half-finished tick survive a process restart*, R1-1, R1-2, R1-3, R5 recovery; live: [evidence/live-check-restart.json](evidence/live-check-restart.json) shows the same session, clock and checksum after a redeploy |
| G12 Security | PASS | [SECURITY.md](SECURITY.md); `test/http.test.ts`; R2 and R8 server review. Live: HSTS, CSP, nosniff, HTTP→HTTPS, HttpOnly/Secure/SameSite=Strict cookie, isolation, forged cookie 401, rate limit 429, forged `X-Forwarded-For` still limited, no secrets in responses. The live check found the proxy hop count wrong (1); it is fixed (3) and re-verified |
| G13 UI tests on desktop and mobile | PASS | [evidence/test-e2e.txt](evidence/test-e2e.txt), [evidence/screenshots/](evidence/screenshots/) |
| G14 Release: clean clone, CI, audit, Docker | PASS | See Release checks below |
| G15 Live deployment verified on the public URL | **PASS** | [evidence/live-check.json](evidence/live-check.json): 27/27 at 2026-11-13T13:11Z against https://firmhand-e2vl.onrender.com; [evidence/live-check-restart.json](evidence/live-check-restart.json): 3/3. Script: `scripts/live-check.mjs` |
| G16 Film | PASS (machine checks only) | [evidence/film-check.json](evidence/film-check.json), [../film/README.md](../film/README.md). No human has watched or listened to it |
| G17 Submission ready | READY, not submitted | [SUBMISSION.md](SUBMISSION.md) has the live URL, the public repo and the release. It still needs the owner's YouTube link, and the owner's submission |

## Release checks
| Check | Result |
|---|---|
| Secret and personal-data scan of tracked files | PASS: no credentials, tokens, e-mail addresses or private paths. The raw Codex logs are gitignored, and commits use the GitHub noreply author |
| Dependency audit | PASS: `npm audit`, 0 vulnerabilities |
| Licences | MIT, Apache-2.0, ISC, BSD-3-Clause and OFL-1.1. MPL-2.0 appears only in `lightningcss`, a build-time dependency that does not ship |
| Clean clone of commit `9d9077c`: `npm ci`, typecheck, build, tests | PASS: `npm ci`, typecheck and build all succeed, and `npm test` passes 52/52 on SQLite and 52/52 on PostgreSQL 16 |
| Docker build and smoke (from `git archive` of `9d9077c`) | PASS: the image builds (329 MB). In the container, `/api/health` returns `{"ok":true}`, the UI and favicon are served, and `/api/session` sets an HttpOnly, Secure, SameSite=Strict cookie. The process runs as `node` |
| GitHub Actions | PASS: run [43429524372](https://github.com/abuzaro21/firmhand/actions/runs/43429524372) on `c2f0916` ran every step green: typecheck, build, SQLite, PostgreSQL, reconciliation, Playwright, audit, and Docker build and smoke. The earlier runs while the repo was private never started, because of account billing. Billing was not changed |

## Owner actions remaining
1. **Upload the film to YouTube** as Unlisted. The file is attached to the release, and the title, description, tags and captions are in [SUBMISSION.md](SUBMISSION.md).
2. **Paste the YouTube link** into SUBMISSION.md, or give it to Claude to add.
3. **Submit to DOO.** Publishing the video is not a submission.
4. Before 2026-12-13, decide whether to replace the free database. A free one cannot be extended.

## How to continue
- Re-run the live checks: `node scripts/live-check.mjs https://firmhand-e2vl.onrender.com run` (wake the service first).
- The service deploys only through the Blueprint (`autoDeploy` off, auto-sync off). After pushing a change to `render.yaml` or the code, plan and approve a Blueprint sync, or trigger a deploy of `firmhand-e2vl`.
