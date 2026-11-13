# Thesis

**A business loop can run through AI systems once authority lives in the record system, not in the agents.**

Most "AI company" demos give one model a big prompt and many tools. When something goes wrong, nobody can say who decided what, on which facts, or under which limit. That is not a company. It is a single point of failure that talks.

FIRMHAND inverts it. Each agent is narrow: Sales promises, Operations moves stock, and Finance moves money. Each has its own queue, its own beliefs and its own permission list. They never message each other. They change shared records, and each change is a transaction that writes the record, the journal entry and the event together. Coordination is therefore a property of the data, and every decision leaves a receipt pointing at the facts it read.

Authority is a policy table enforced by the kernel. An agent cannot exceed it, however confident it is. Above the limit, the action waits for a human. The human's approval is bound by hash to those exact parameters, record versions and policy version, so it cannot be replayed onto a different decision.

That structure is what makes self-correction and failure handling credible. When stock runs short, the agents fix it inside budgets a human set in advance, and the comparison shows what it cost. When Operations dies, nobody is told. Finance notices because work stops moving. It contains the damage and asks a human before anything restarts.

Today the planners are deterministic so the demo is reproducible. The thesis is that this is the right place to put models later: as planners proposing commands into a ledger that enforces limits, keeps receipts and replays every day. Better models do not make the record system optional. They make it necessary.
