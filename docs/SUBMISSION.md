# Submission notes

Ready to paste. The owner submits; nothing here has been submitted automatically.

## DOO Builders League entry

**Project:** FIRMHAND
**Tagline:** One company. One shared truth. Many accountable hands.
**Repository:** https://github.com/abuzaro21/firmhand
**Live demo:** _the Render URL, once deployed (see [EXECUTION_STATE](EXECUTION_STATE.md))_
**Film:** _the YouTube link, once the owner uploads it_ (the MP4 is also attached to the v1.0.0 release)

**What it is (short):**
FIRMHAND is a small company, Hearthbrew Coffee Gear, run for one simulated week by three independent agents: Sales, Operations and Finance. They never call each other. They act only through one command kernel over one shared record system, which holds a double-entry ledger in integer cents, an append-only event log, and per-role task inboxes. Anything above a role's authority waits in the human COO's approval inbox. Each approval is bound by a hash to its parameters, the record versions and the policy version, and it can be used once.

**What to try (about 3 minutes):**
1. Press **Run week**. The run stops on Day 2: Sales wants 18% off for a café and may only give 10%. Open the item and look at its evidence and hash, then approve or deny it. Each answer leads to a different outcome.
2. Day 3: grinder demand goes up four times and the supplier slips. Nobody asks you. Operations sizes an expedite, Finance funds it within budget, and Sales re-promises the customers who are waiting.
3. Day 5: Operations crashes mid-turn. Finance's watchdog notices that work stopped moving, freezes spend and asks you to restart it. Operations then dispatches its half-packed parcels exactly once.
4. Click any KPI to see the rows behind it. Open **Replay** to rebuild a day from the log alone, with before and after digests showing it changed nothing. Open **Proof** for the comparison against a naive company.

**Measured (seed 7, same world, only the policies differ):**
- Inventory shock: 0 customers lost against the naive baseline's 8, and $13,775 against $11,086 in recognised revenue. The expedite cost $1,500.
- Operations crash: a backlog of 3 against 61 at week end, and 0 customers lost against 5.

**Honest limits:**
- No LLM runs at runtime. The agents are deterministic policies, so every decision can be reproduced and checked.
- The operator is a demo role bound to a cookie. It is not a verified identity.
- Checksums compare replay with live state. They are not a tamper-evident log.
- All data is synthetic. No payments are made and no one is contacted.
- Hosting is free tier: it sleeps after idle, and the free database expires after 30 days.

**Built with:** Claude Code (Claude Opus 5.5) wrote the code and docs. OpenAI Codex (`gpt-6.1-sol`, read-only) produced the competing architecture and the adversarial reviews. See [AI-DISCLOSURE](AI-DISCLOSURE.md) and [reviews/](reviews/).

## YouTube (owner uploads, visibility **Unlisted**)
**Title:** FIRMHAND: three agents run a small company, and a human signs off (90 s)

**Description:**
```
FIRMHAND is a small fictional company, Hearthbrew Coffee Gear, run for one simulated week by three independent agents (Sales, Operations and Finance) over one shared ledger. A human COO approves only what is above each agent's authority.

In 90 seconds:
0:00 the company and its three agents
0:19 a hash-bound approval: an 18% discount that Sales may not give alone
0:31 an inventory shock the agents correct with no human
0:45 Operations crashes; Finance's watchdog asks for a restart
0:57 recovery: half-packed parcels dispatched exactly once
1:04 every KPI opens the records behind it
1:11 replay from the event log alone, and the comparison with a naive company

All product footage is a real capture of the running build. The narration voice is synthetic (Kokoro-82M). The company and all its data are fictional.

Code: https://github.com/abuzaro21/firmhand
Entry for the DOO Builders League.
```
**Tags:** firmhand, multi-agent, autonomous company, simulation, double-entry, event sourcing, approvals, typescript, postgresql, DOO Builders League

**Captions:** upload [`film/firmhand-film.srt`](../film/firmhand-film.srt) as English subtitles. The captions are also burned into the picture.
**Thumbnail:** the end frame, or `docs/evidence/screenshots/desktop-1-run.png`.

## Before pressing submit (owner)
- [ ] The live URL answers `/api/health` (wake it first; free tier sleeps).
- [ ] The YouTube video is Unlisted and plays, and its link is pasted above.
- [ ] The repository is public, and the v1.0.0 release has the MP4 and SRT.
- [ ] The DOO form is submitted. FIRMHAND is not submitted until this box is ticked; publishing the video alone is not a submission.
