# FIRMHAND

**One company. One shared truth. Many accountable hands.**

![The FIRMHAND cockpit during a run: the three agents' lanes, KPIs and the approval inbox](docs/evidence/screenshots/desktop-1-run.png)

FIRMHAND is a working slice of a small company run by three independent agents: Sales, Operations and Finance. They share one record system, a double-entry ledger and an event log. The human acts as COO through an approval inbox. You can run the week, break the company, watch it correct itself, and replay any day from the log.

The company, **Hearthbrew Coffee Gear**, is fictional. Every customer, supplier, order and amount is synthetic. FIRMHAND processes no real payments and contacts no one.

- **Live demo:** see [`docs/DEPLOY.md`](docs/DEPLOY.md) and [`docs/EXECUTION_STATE.md`](docs/EXECUTION_STATE.md) for the current URL. It runs on a free host that sleeps, so the first request can take about a minute.
- **Film (about 90 s):** to be attached to the v1.0.0 release when it is published (pending; see [`docs/EXECUTION_STATE.md`](docs/EXECUTION_STATE.md)). The storyboard and checks are in [`film/`](film/README.md).
- **Thesis:** [`docs/THESIS.md`](docs/THESIS.md)

## How it works
| | |
|---|---|
| **Three roles** | Sales quotes, takes orders and keeps promises. Operations reserves, packs, ships and buys stock. Finance captures payments, posts every journal entry, funds purchases and watches the others. Each role has its own inbox, memory, status and command permissions, and none of them calls another. See [AGENT-ROLES](docs/AGENT-ROLES.md). |
| **Shared state** | Every action is a command through one kernel. A command runs in one transaction: it checks the role's permission and the business rules, writes the records, appends event facts and posts balanced journal lines in integer cents. The roles coordinate only through those records and the events routed to their inboxes. See [ARCHITECTURE](docs/ARCHITECTURE.md). |
| **Invariants** | Debits equal credits, cash never goes below zero, stock never goes negative, refunds never exceed what was paid, and nine reconciliations run at every daily close. See [FINANCIAL-INVARIANTS](docs/FINANCIAL-INVARIANTS.md). |

## What you can do in the cockpit
| | |
|---|---|
| **Run the Company** | Run an hour, a day or the whole week at 1×, 3× or Fast. Pause or resume any single agent, inject a shock, or start a new company with another seed. The run stops on its own whenever a decision needs you. |
| **Your inbox** | Above-limit actions wait here: a big discount, a purchase over budget, restarting a crashed agent. Each item shows its evidence, the records and versions it is bound to, the policy version and the approval hash. The server rejects anything that does not match. |
| **KPIs** | Recognised revenue, bookings, cash, net income, backlog, late orders and lost customers, all derived from records. Click a KPI to see the rows behind it. Click an id (`O-12`, `PO-3`, `AP-1`) to trace it through events, decisions and journal entries. |
| **Watch a Company Day** | A narrated view. Every sentence comes from a real event in the log and names its sequence number. |
| **Replay** | Rebuild any day from stored event facts alone. The server measures the company's business-state digest before and after the replay, which shows that replay changed no business record. Session housekeeping is excluded from that digest. A closed day's replay checksum must equal the snapshot taken at close. See [REPLAY](docs/REPLAY.md). |
| **Proof** | Rebuild the whole company from the log and compare it with the live tables. See daily closes, the naive-baseline comparisons for both scenarios, and which role may do what. |

## The default week
| When | What happens | Who handles it |
|---|---|---|
| Day 2 | A café asks for 18% off six grinders. Sales may give 10% on its own. | **You** approve or deny |
| Day 3 | Grinder demand goes ×4 and the main supplier slips 3 days | **The agents, with no human.** Operations sizes an expedite, Finance funds it within budget, and Sales re-promises the customers who are waiting. |
| Day 5 | Operations crashes mid-turn with parcels packed but not dispatched | Finance's progress watchdog notices within about 2 hours. It freezes discretionary spend and asks **you** to restart Operations. Operations then reconciles and dispatches each parcel exactly once. |

### Approval walkthrough
1. Sales files the 18% discount. The kernel refuses to execute it and creates `AP-1`, bound to the lead's record version and the policy version, with a hash.
2. The run pauses. The inbox shows the evidence (requested discount, list and quoted value, margin at that price), the bound record and the hash.
3. **Approve:** the browser sends back the hash it was shown, and Sales executes the quote under `AP-1` once. **Deny:** Sales offers its own 10% maximum instead. Either way the outcome differs: the price the customer is quoted, and so the order's revenue and margin.
4. A tampered hash, a second use, another company's approval, or a lead changed after approval is refused. See [APPROVALS](docs/APPROVALS.md).

### Self-correction and the failure test
Measured on isolated copies with the same seed (seed 7). Only the policies differ:

| | FIRMHAND | Naive baseline |
|---|---:|---:|
| Inventory shock: customers lost / late vs first promise | 0 / 0 | 8 / 8 |
| Inventory shock: recognised revenue | $13,775 | $11,086 |
| Operations crash: backlog at week end / customers lost | 3 / 0 | 61 / 5 |
| Operations crash: Operations at week end | running | faulted |

Self-correction is not free. It spent $1,500 on expedited stock, and the comparison shows that. See [SELF-CORRECTION](docs/SELF-CORRECTION.md), [FAILURE-TEST](docs/FAILURE-TEST.md) and [`evidence/comparisons.md`](docs/evidence/comparisons.md).

## Run it locally
Requires Node 24.13+.
```bash
npm ci
npm run build          # UI -> public/
npm start              # http://localhost:3000, SQLite in data/firmhand.db
npm run typecheck
npm test               # invariant, adversarial, regression, HTTP and full-week tests (SQLite)
FIRMHAND_TEST_PG=postgres://user:pass@host:5432/db npm test   # the same suite on PostgreSQL 16
npm run test:e2e       # Playwright, desktop and mobile
```
`DATABASE_URL=postgres://…` switches the server to PostgreSQL. Docker and Render are covered in [DEPLOY](docs/DEPLOY.md).

**Test results for this release:** `npm test` passes 52 of 52 on SQLite and 52 of 52 on PostgreSQL 16. `npm run test:e2e` passes 6 of 6 in desktop and mobile Chromium. The logs are in [`docs/evidence/`](docs/evidence/).

## Documents
| | |
|---|---|
| [ARCHITECTURE](docs/ARCHITECTURE.md) · [DECISIONS](docs/ARCHITECTURE-DECISIONS.md) | How it works, and why it was built this way |
| [AGENT-ROLES](docs/AGENT-ROLES.md) · [BUSINESS-MODEL](docs/BUSINESS-MODEL.md) | Who does what, and in what kind of company |
| [FINANCIAL-INVARIANTS](docs/FINANCIAL-INVARIANTS.md) · [APPROVALS](docs/APPROVALS.md) | Rules the system cannot break, and where a human must decide |
| [SELF-CORRECTION](docs/SELF-CORRECTION.md) · [FAILURE-TEST](docs/FAILURE-TEST.md) · [REPLAY](docs/REPLAY.md) | The three judged behaviours, with evidence |
| [SECURITY](docs/SECURITY.md) · [DEPLOY](docs/DEPLOY.md) · [AI-DISCLOSURE](docs/AI-DISCLOSURE.md) | Hosting, limits and how it was built |
| [reviews/](docs/reviews/REVIEW-SUMMARY.md) · [evidence/](docs/evidence) · [EXECUTION_STATE](docs/EXECUTION_STATE.md) · [SUBMISSION](docs/SUBMISSION.md) | Independent reviews, captured evidence, gate status and entry notes |

## Limitations
- No LLM runs at runtime. The agents are deterministic policy modules, so a seed always gives the same week and every decision can be checked. They do not improvise outside their written policies.
- "Operator" is a demo role tied to a browser cookie. It is not a verified human identity.
- Checksums are SHA-256 digests used to compare a replay with the live state. They are not a signed or tamper-evident log.
- One week, one product line, two fictional suppliers. The simulation is a slice of a company, not an ERP.
- Free hosting sleeps after about 15 minutes idle, and its free database expires after 30 days.
- The name has not been through a trademark search.

## AI disclosure
Claude Code (Claude Opus 5.5) wrote the code, tests, documents and film pipeline. OpenAI Codex (`gpt-6.1-sol`, read-only) wrote a competing architecture and ran eight adversarial reviews and fix verifications. Claude fixed every finding, with a regression test wherever the finding was in code. The film's footage is a real capture of the running build. Its narration voice is synthetic (Kokoro-82M). No human has reviewed the film by watching it. Details are in [AI-DISCLOSURE](docs/AI-DISCLOSURE.md).

MIT licence.
