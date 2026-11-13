# Human approvals

The human is the COO. The agents act on their own inside fixed limits and stop at the edge. The limits are in `POLICY` (`src/model.ts`), version `policy-2026-11-13.1`.

| Action | Automatic up to | Needs you | Refused outright |
|---|---|---|---|
| Discount | 10% | above 10% | above 25% |
| Purchase order | $1,500, with cash after funding ≥ $3,000 | above either | cash after funding < $500 |
| Expedite (backup supplier) | within $1,500 per week | above | — |
| Goodwill credit or refund after shipment | $60 | above | above what was paid |
| Cancellation of an unshipped order | $500 | above | — |
| Advertising | $150 a day, with no spend freeze | above | — |
| Restarting a faulted agent | never | always | — |

## What an approval is bound to
`hash = sha256(company | kind | canonical(params) | canonical(bound record versions) | policy version)`

- **Bound records.** The record versions the action depends on, for example the quote and the customer, or the faulted agent row. The cockpit shows them as `quote/Q-31@v2`.
- **Showing the hash.** The inbox shows the hash. The browser must send back the hash it was shown, and the server rejects any other hash.
- **Single use.** An approval executes once and is then `executed`.
- **Expiry.** After 8 business hours an approval expires and can no longer be decided.
- **Revalidation.** At execution the kernel recomputes the hash from the current records. If anything it was bound to has changed since, for example the quote was revised or the policy version moved, the approval becomes `stale` and nothing executes. The agent then decides again.

The browser cannot approve on an agent's behalf, name an actor, or write a record or event. The only write endpoints are the operator controls: tick, day, pause or resume an agent, inject a scenario, approve or deny, and reset.

## When you deny
| Request | What the agent does instead |
|---|---|
| Discount | Offers the 10% maximum |
| Purchase | The purchase order is declined, and Sales pushes promise dates out |
| Credit or refund | Limited to $60 |
| Restart | Operations stays down. Sales keeps holding promises, and Finance keeps spending frozen |

## Proven by
`test/adversarial.test.ts`:
- *approval binding: tampered params, reuse, wrong company, wrong role, expiry and stale state all fail*
- *an approval cannot be decided after it expires*
- *restart: a pending approval … survive a process restart*

`test/http.test.ts`:
- *approvals are enforced by the backend*

`e2e/cockpit.spec.ts`:
- *a forged approval hash is refused by the server even if the browser is tampered with*
