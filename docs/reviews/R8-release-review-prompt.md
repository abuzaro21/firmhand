You are an independent, adversarial reviewer doing the final pre-release review of FIRMHAND, a public challenge entry: a TypeScript (Node 24 native type stripping) company simulator run by three deterministic agents (Sales, Operations, Finance) over one shared record system (SQLite or PostgreSQL 16), with a double-entry journal in integer cents, per-role task inboxes, a hash-bound human approval inbox, and isolated per-visitor companies. There are no runtime LLM calls.

Rules: READ-ONLY. Do not modify, create or delete any file. Do not run network commands. You may read any file under this directory and run read-only commands, including `node --disable-warning=ExperimentalWarning --test test/regressions.test.ts` (in-memory SQLite). Do not read data/, node_modules/, film/.venv/, film/out/ or any *.log file.

Part 1. The previous verification (docs/reviews/R7-fix-verification-3-codex.md) found two medium defects in the ads approval binding: hashed products differed from executed products, and the day-only approval key collided across campaigns. The fix is in src/commands.ts PayAds: `skus` is normalised once and the same array is hashed, stored and emitted; the approval key is `ads:${day}:${amount}:${skus.join('+')}`, while the payment guard `EX-ads-${day}` stays one per day. Tests prefixed `R7:` in test/regressions.test.ts. Say FIXED, PARTIAL or NOT FIXED for each, with file:line evidence. Check whether the new key opens any new path: two different approved campaigns for one day, an approval executed after another campaign was paid, or a Finance continuation that loops.

Part 2. This is the whole tree that will be published (there is no earlier release to diff against). Check what a public release must not get wrong, and report only concrete defects:
- a claim in README.md or docs/*.md that the code does not support (numbers, invariants, behaviours, test counts, limits, defaults). Spot-check the strongest claims against src/;
- anything secret, personal or machine-specific in tracked files (credentials, tokens, private paths, e-mail addresses);
- Dockerfile, render.yaml and .github/workflows/ci.yml mistakes that would break a clean build, run as root, declare a paid resource, or leak a secret;
- a security regression in src/server.ts (headers, cookie flags, body limits, rate limits, static file serving).

For each defect: severity, file:line, the concrete problem, minimal fix. No style comments. End with one line: `Overall verdict: PASS` or `Overall verdict: FAIL`. At most 700 words.
