// Approval continuations: what a role still owes a request it sent to the human. They live in the role's memory, which
// is persisted only at the end of a turn. A crash can lose them at three points, and each is recovered from the durable
// approval record, never from belief:
// 1. the escalation committed but the turn died: the redelivered request comes back as a duplicate carrying the live
//    approval, and rebuild() at the start of every turn restores it from the approvals table;
// 2. the human decided before the role's next turn: the decision is still queued in the role's inbox, so rebuild()
//    restores the entry before the inbox is processed;
// 3. the decision was already delivered (or the request was re-filed and matched an older decided approval): track()
//    acts on the recorded decision at once, instead of waiting for an event that will never come again.
import type { Turn } from './types.ts';

export type Outcome = (t: Turn, kind: string, p: { approval: string }) => Promise<void>;
const EVENT: Record<string, string> = { approved: 'ApprovalGranted', denied: 'ApprovalDenied', expired: 'ApprovalExpired', stale: 'ApprovalStale' };

/** Restore continuations for this role's requests that are undecided, or whose decision is still in its inbox. */
export async function rebuild(t: Turn, entry: (kind: string, params: any) => Record<string, unknown> | null) {
  const rows = await t.read((q) => q.all<any>(`SELECT a.id, a.kind, a.params FROM approvals a WHERE a.company = ? AND a.requester = ? AND (a.status = 'pending'
      OR EXISTS (SELECT 1 FROM agent_tasks k WHERE k.company = a.company AND k.role = a.requester AND k.status = 'queued' AND k.subject = a.id))
    ORDER BY a.requested_at, CAST(SUBSTR(a.id, 4) AS INTEGER)`, [t.company, t.role]));
  for (const a of rows) {
    if (t.mem.pending[a.id]) continue;
    const e = entry(a.kind, JSON.parse(a.params));
    if (e) t.mem.pending[a.id] = e;
  }
}

/** Remember an open request; if the kernel reports it was already decided, act on that decision now (at most once per
 *  approval per turn, so a fallback can never loop). */
export async function track(t: Turn, r: { outcome: string; approval?: string; approvalStatus?: string }, entry: Record<string, unknown>, onOutcome: Outcome) {
  if (!r.approval || (r.outcome !== 'escalated' && r.outcome !== 'duplicate')) return;
  t.mem.pending[r.approval] = entry;
  const kind = r.outcome === 'duplicate' ? EVENT[r.approvalStatus ?? ''] : undefined;
  if (!kind) return; // still pending: wait for the human
  const acted: Set<string> = ((t as any).acted ??= new Set<string>());
  if (acted.has(r.approval)) { delete t.mem.pending[r.approval]; return; }
  acted.add(r.approval);
  await onOutcome(t, kind, { approval: r.approval });
}
