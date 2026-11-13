# Execution state

_Last updated 2026-11-13. This file records what is actually true, with evidence. Nothing is marked PASS without it._

## Snapshot
| | |
|---|---|
| Repository | `abuzaro21/firmhand`, branch `main` (latest commit: see `git log -1`) |
| Visibility | private until the owner approves making it public |
| Running services | none. Locally, `firmhand-test-pg` (Docker, PostgreSQL 16) is used for the PostgreSQL suite only |
| Last Codex verdict | R9 (`gpt-6.1-sol`, read-only) on commit `9d9077c`: FAIL on two wording and link items, which are fixed but not re-verified. Every code finding from R1–R7 was verified FIXED by a later pass. See [reviews/REVIEW-SUMMARY.md](reviews/REVIEW-SUMMARY.md) |
| Tests | typecheck PASS · `npm test` 52/52 SQLite · 52/52 PostgreSQL 16 · e2e 6/6 (desktop and mobile Chromium) · `npm audit` 0 vulnerabilities |
| Deployment | **not deployed.** Needs a dedicated Render workspace, which only the owner can create, and approval to create the two free resources |
| Live URL | none yet |
| Free database expiry | not created yet (30 days after creation) |
| Film | built and machine-checked: `film/out/firmhand-film.mp4`, 89.47 s, 1080p30, H.264/AAC. Not yet attached to a release. Not uploaded to YouTube (the owner uploads it) |
| DOO submission | **not submitted** |

## Gates
| Gate | Status | Evidence |
|---|---|---|
| G1 Architecture: two independent proposals, reconciled | PASS | [reviews/architecture-A-claude.md](reviews/architecture-A-claude.md), [reviews/architecture-B-codex.md](reviews/architecture-B-codex.md), [ARCHITECTURE-DECISIONS.md](ARCHITECTURE-DECISIONS.md) |
| G2 Three independent agents | PASS | `src/agents/*.ts`; per-role inboxes, memory, status and permissions; R3 area 5 PASS; test *role violation…*, *a paused or faulted agent cannot act…* |
| G3 Shared durable state | PASS | One kernel and one transaction per command (`src/kernel.ts`); SQLite and PostgreSQL run the same DDL and the same 52 tests |
| G4 Real operations | PASS | Quotes, orders, payments, reservations, packing, dispatch, purchasing, receipts, credits, refunds, ads and staff, all posted to the journal |
| G5 KPIs reconcile and drill down | PASS | `src/kpi.ts` nine reconciliation checks; test *R4-2/R4-5: every KPI drawer returns exactly the records its tile counts* |
| G6 Week reproducible | PASS | `test/week.test.ts`: 5 seeds close 7 days; the same seed gives the same checksum |
| G7 Approval and denial change outcomes | PASS | Approve: the 18% quote is executed under the approval. Deny: the quote is 10% (test *R5: a discount denied…*); test *approval binding…* |
| G8 Self-correction vs naive | PASS | [SELF-CORRECTION.md](SELF-CORRECTION.md), [evidence/comparisons.md](evidence/comparisons.md): 0 vs 8 customers lost, $13,775 vs $11,086 |
| G9 Failure and compensation vs naive | PASS | [FAILURE-TEST.md](FAILURE-TEST.md): backlog 3 vs 61, 0 vs 5 customers lost; test *operations crash mid-turn…* |
| G10 Replay with no side effects | PASS | [REPLAY.md](REPLAY.md); tests *day replay is read-only…*, *replay over HTTP…*, R4-1 |
| G11 Durability | PASS | Tests *restart: a pending approval and a half-finished tick survive a process restart*, R1-1, R1-2, R1-3, R5 recovery |
| G12 Security | PASS (locally) | [SECURITY.md](SECURITY.md); `test/http.test.ts` (cookie flags, isolation, forged hash, traversal, rate limits); R2 and R8 server review |
| G13 UI tests on desktop and mobile | PASS | [evidence/test-e2e.txt](evidence/test-e2e.txt), [evidence/screenshots/](evidence/screenshots/) |
| G14 Release: clean clone, CI-equivalent, audit, Docker | PASS (local); GitHub Actions blocked by account billing | See the Release checks section |
| G15 Live deployment verified on the public URL | **BLOCKED (owner)** | No dedicated Render workspace yet. Planned checks once deployed: health and HTTPS, session cookie, agents run, KPI drill-down, approval, inventory shock, crash and recovery, replay, restart persistence, isolation between two sessions, rate limits, no secrets in responses |
| G16 Film | PASS (machine checks only) | [evidence/film-check.json](evidence/film-check.json), [../film/README.md](../film/README.md). No human has watched or listened to it |
| G17 Submission ready | PENDING | [SUBMISSION.md](SUBMISSION.md) is ready to paste. It needs the live URL, a public repo, the release with the film, and the YouTube link |

## Release checks
| Check | Result |
|---|---|
| Secret and personal-data scan of tracked files | PASS: no credentials, tokens, e-mail addresses or private paths. The raw Codex logs are gitignored |
| Dependency audit | PASS: `npm audit`, 0 vulnerabilities |
| Licences | MIT, Apache-2.0, ISC, BSD-3-Clause and OFL-1.1. MPL-2.0 appears only in `lightningcss`, a build-time dependency that does not ship |
| Clean clone of commit `9d9077c`: `npm ci`, typecheck, build, tests | PASS: `npm ci`, typecheck and build all succeed, `npm test` 52/52 on SQLite and 52/52 on PostgreSQL 16 |
| Docker build and smoke (from `git archive` of `9d9077c`) | PASS: the image builds (329 MB). In the container, `/api/health` returns `{"ok":true}`, the UI and favicon are served, and `/api/session` sets an HttpOnly, Secure, SameSite=Strict cookie. The process runs as `node`, not root |
| GitHub Actions | **NOT RUN.** Run 43336024239 on `9d9077c`: GitHub did not start the jobs ("recent account payments have failed or your spending limit needs to be increased"). No steps executed. Billing was not changed. Public repositories get free minutes, so CI is re-run after the visibility change |

## Blockers (owner action)
1. **Render workspace.** Create a workspace named FIRMHAND in the Render dashboard. The CLI cannot create one, and the active CLI workspace belongs to another project, so it must not be used.
2. **Approve creation** of the two free resources in [render.yaml](../render.yaml): one web service and one PostgreSQL 16 database.
3. **Approve public visibility** of `abuzaro21/firmhand`.
4. **Upload the film to YouTube** as Unlisted, using the text in [SUBMISSION.md](SUBMISSION.md).
5. **Submit to DOO.**

## How to continue
1. After the workspace exists: `render workspace set <FIRMHAND workspace>`, then create the Blueprint from `render.yaml` and deploy.
2. Run the G15 checks against the public URL, record them here, and set the database expiry date.
3. Make the repository public, tag `v1.0.0`, and create the release with `film/out/firmhand-film.mp4` and `film/firmhand-film.srt` attached. The MP4 is never committed.
4. Paste the live URL and the YouTube link into [SUBMISSION.md](SUBMISSION.md) and the README.
