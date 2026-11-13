// FINANCE: owns the books and spending authority. It posts every journal entry from other roles' facts, funds
// purchases inside budget, escalates what is above it, watches the other roles' progress, and closes each day with
// reconciliation checks.
import { ACCOUNTS, POLICY, STAFF_PER_DAY, TICKS_PER_DAY, dayOf, money } from '../model.ts';
import type { Policy, Turn } from './types.ts';
import { rebuild, track } from './continuations.ts';

export const finance: Policy = async (t) => {
  const m = t.mem;
  m.pending ??= {};
  await rebuild(t, (kind, p) => kind === 'purchase' ? { kind, po: p.po }
    : kind === 'credit' ? { kind, order: p.order, amount: p.amount, reason: p.reason }
    : kind === 'ads' ? { kind, day: p.day, amount: p.amount, skus: p.skus ?? [] }
    : kind === 'recover-agent' ? { kind, role: p.role } : null);
  for (const task of t.tasks) {
    const p = task.payload;
    switch (task.kind) {
      case 'DayStarted':
        await t.exec('PayStaff', { day: p.day, amount: STAFF_PER_DAY }, { rule: 'daily-staff-cost', text: `pay Day ${p.day} staff cost` }, task.seq); break;
      case 'OrderPlaced':
        await t.exec('CapturePayment', { order: p.order }, { rule: 'capture-on-order', text: `capture ${money(p.total ?? 0)} for ${p.order}${p.redelivery ? ' (payment network re-delivered this event)' : ''}; hold as a deposit until it ships` }, task.seq); break;
      case 'ShipmentDispatched': {
        const r = await t.exec('PostShipment', { order: p.order }, { rule: 'recognise-on-dispatch', text: `${p.order} left the warehouse: recognise revenue, expense its cost` }, task.seq);
        if (r.outcome === 'rejected') continue; // a dispatched parcel must be posted: leave the task queued and retry next hour
        break;
      }
      case 'GoodsReceived': {
        const r = await t.exec('PostReceipt', { po: p.po }, { rule: 'capitalise-receipt', text: `${p.po} counted into stock: move its prepaid value into inventory` }, task.seq);
        if (r.outcome === 'rejected') continue;
        break;
      }
      case 'OrderCancelled':
        await t.exec('RefundDeposit', { order: p.order }, { rule: 'refund-cancelled-deposit', text: `${p.order} cancelled before shipping: return the deposit` }, task.seq); break;
      case 'CreditRequested': await credit(t, p.order, p.amount, p.reason, task.seq); break;
      case 'AdSpendRequested': {
        const r = await t.exec('PayAds', { day: p.day, amount: p.amount, skus: p.skus }, { rule: 'fund-campaign', text: `Sales asked for ${money(p.amount)} of ads for Day ${p.day}` }, task.seq);
        await track(t, r, { kind: 'ads', day: p.day, amount: p.amount, skus: p.skus }, onApproval);
        break;
      }
      case 'PurchaseProposed': await fund(t, p.po, task.seq); break;
      case 'ApprovalGranted': case 'ApprovalDenied': case 'ApprovalExpired': case 'ApprovalStale':
        await onApproval(t, task.kind, p); break;
      default: break; // ShortageDetected/Resolved, AgentRecovered: context only
    }
    await t.done(task);
  }

  if (t.policies.watchdog) await watchdog(t);
  await cashGuard(t);

  if (t.clock % TICKS_PER_DAY === TICKS_PER_DAY - 1) {
    await t.exec('CloseDay', { day: dayOf(t.clock) }, { rule: 'end-of-day-close', text: `close Day ${dayOf(t.clock)}: trial balance and reconciliations, then snapshot` });
  }
  t.plan(`${Object.keys(m.pending).length} decisions waiting on a human${m.watch ? `; watching: ${m.watch}` : ''}`);
};

async function fund(t: Turn, po: string, causation?: number) {
  const r = await t.exec('FundPurchase', { po }, { rule: 'fund-within-authority', text: `evaluate ${po} against cash, reserve, purchase limit and expedite budget` }, causation);
  await track(t, r, { kind: 'purchase', po }, onApproval);
  if (r.outcome === 'rejected' && /hard floor/.test(r.error ?? '')) {
    await t.exec('DeclinePurchase', { po, reason: r.error }, { rule: 'decline-below-floor', text: `cannot fund ${po} without breaching the cash floor` }, causation);
  }
  return r;
}

async function credit(t: Turn, order: string, amount: number, reason: string, causation?: number, approval?: string) {
  const r = await t.exec('IssueCredit', { order, amount, reason, ...(approval ? { approval_id: approval } : {}) }, { rule: 'pay-goodwill-credit', text: `${money(amount)} credit on ${order} (${reason})` }, causation);
  await track(t, r, { kind: 'credit', order, amount, reason }, onApproval);
  return r;
}

async function onApproval(t: Turn, kind: string, p: any) {
  const pend = t.mem.pending[p.approval];
  if (!pend) return;
  delete t.mem.pending[p.approval];
  const granted = kind === 'ApprovalGranted';
  if (pend.kind === 'purchase') {
    if (granted) {
      const r = await t.exec('FundPurchase', { po: pend.po, approval_id: p.approval }, { rule: 'execute-approved-purchase', text: `human approved ${pend.po}` });
      // Granted but no longer executable (stale, expired, or funding now needs an override the human did not grant):
      // evaluate afresh, which funds it within authority, uses a matching approval already granted, or files a new
      // request for exactly what is now needed.
      if (r.outcome !== 'committed' && r.outcome !== 'duplicate') await fund(t, pend.po);
    }
    const po = await t.read((q) => q.one<any>('SELECT status FROM purchase_orders WHERE company = ? AND id = ?', [t.company, pend.po]));
    const waiting = Object.values(t.mem.pending).some((e: any) => e.kind === 'purchase' && e.po === pend.po);
    if (po && ['proposed', 'awaiting_approval'].includes(po.status) && !waiting) {
      await t.exec('DeclinePurchase', { po: pend.po, reason: `${p.approval} ${kind.replace('Approval', '').toLowerCase()}` }, { rule: 'purchase-not-approved', text: `${pend.po} not approved: decline it; Operations and Sales re-plan` });
    }
  }
  if (pend.kind === 'credit') {
    const r = granted ? await credit(t, pend.order, pend.amount, pend.reason, undefined, p.approval) : undefined;
    if (!r || r.outcome === 'rejected') await credit(t, pend.order, POLICY.creditAutoCents, `${pend.reason}-capped`); // the most Finance may pay alone
  }
  if (pend.kind === 'ads' && granted) {
    const r = await t.exec('PayAds', { day: pend.day, amount: pend.amount, skus: pend.skus, approval_id: p.approval }, { rule: 'execute-approved-ads', text: 'human approved the campaign' });
    // Approved but no longer usable (it expired before Finance could act): run the campaign at Finance's own limit.
    if (r.outcome === 'rejected' && /stale|expired|changed/.test(r.error ?? '')) {
      await t.exec('PayAds', { day: pend.day, amount: Math.min(pend.amount, POLICY.adsDailyAutoCents), skus: pend.skus }, { rule: 'ads-within-authority', text: `${p.approval} could not be used; fund the campaign within Finance's own limit` });
    }
  }
  if (pend.kind === 'recover-agent') {
    if (granted) await t.exec('RecoverAgent', { role: pend.role, approval_id: p.approval }, { rule: 'execute-approved-recovery', text: `human authorised restarting ${pend.role}` });
    else t.mem.recoveryHold = t.clock; // ask again after a 4-hour hold, not every hour
  }
}

/** Progress watchdog over Operations. Heartbeats prove nothing; the question is whether eligible work is moving. */
async function watchdog(t: Turn) {
  const s = await t.read(async (q) => {
    const ops = await q.one<any>("SELECT status, last_progress, fault_reason FROM agents WHERE company = ? AND role = 'operations'", [t.company]);
    const ready = await q.one<any>("SELECT COUNT(*) AS n FROM orders WHERE company = ? AND status = 'reserved' AND paid = total AND paid > 0", [t.company]);
    const packed = await q.one<any>("SELECT COUNT(*) AS n FROM shipments WHERE company = ? AND status = 'packed'", [t.company]);
    const stale = await q.one<any>("SELECT COUNT(*) AS n FROM agent_tasks WHERE company = ? AND role = 'operations' AND status = 'queued' AND created_at <= ?", [t.company, t.clock - POLICY.stallTicks]);
    const exposure = await q.one<any>("SELECT COUNT(*) AS n, COALESCE(SUM(paid),0) AS v FROM orders WHERE company = ? AND status IN ('placed','reserved','backordered','packed') AND paid > 0", [t.company]);
    const late = await q.one<any>("SELECT COUNT(*) AS n FROM orders WHERE company = ? AND status IN ('placed','reserved','backordered','packed') AND promised_tick < ?", [t.company, t.clock]);
    const inc = await q.one<any>("SELECT id FROM incidents WHERE company = ? AND kind = 'ops-stalled' AND status = 'open'", [t.company]);
    const rec = await q.one<any>("SELECT id, status FROM approvals WHERE company = ? AND kind = 'recover-agent' AND status = 'pending'", [t.company]);
    return { ops, eligible: Number(ready.n) + Number(packed.n) + Number(stale.n), packed: Number(packed.n), stale: Number(stale.n), exposure, late: Number(late.n), inc: inc?.id, rec };
  });
  const idle = t.clock - s.ops.last_progress;
  const stalled = s.eligible > 0 && idle >= POLICY.stallTicks;
  t.mem.watch = `operations idle ${idle}h, ${s.eligible} eligible items`;
  if (stalled && !s.inc) {
    await t.exec('OpenIncident', {
      kind: 'ops-stalled', severity: 'critical', human_needed: s.ops.status === 'faulted' ? 1 : 0,
      summary: `Operations made no progress for ${idle} hours with ${s.eligible} items waiting`,
      detail: { idle_hours: idle, ready_to_pack: s.eligible - s.packed - s.stale, packed_not_dispatched: s.packed, stale_tasks: s.stale,
        deposits_at_risk: Number(s.exposure.v), orders_at_risk: Number(s.exposure.n), late_orders: s.late, agent_status: s.ops.status },
    }, { rule: 'progress-watchdog', text: `eligible work idle ${idle}h ≥ ${POLICY.stallTicks}h: declare Operations stalled`, inputs: { idle, eligible: s.eligible } });
    await t.exec('SetSpendFreeze', { on: true, reason: 'Operations outage: do not buy demand we cannot ship' }, { rule: 'freeze-during-outage', text: 'stop discretionary spend while nothing ships' });
  }
  if ((stalled || s.inc) && s.ops.status === 'faulted' && !s.rec && t.mem.recoveryHold !== t.clock && !(t.mem.recoveryHold > t.clock - 4)) {
    const r = await t.exec('RecoverAgent', { role: 'operations' }, { rule: 'request-recovery', text: `Operations faulted (${s.ops.fault_reason}); only a human may authorise a restart`, inputs: { exposure: s.exposure } });
    await track(t, r, { kind: 'recover-agent', role: 'operations' }, onApproval);
  }
  if (s.inc && s.ops.status === 'running' && idle === 0 && s.packed === 0) {
    await t.exec('ResolveIncident', { incident: s.inc, summary: 'Operations is making progress again' }, { rule: 'outage-over', text: 'Operations committed work this hour and nothing is half-finished' });
  }
}

/** Keep cash above the operating reserve: freeze discretionary spend below it, lift the freeze when safe. */
async function cashGuard(t: Turn) {
  const s = await t.read(async (q) => {
    const b = await q.one<any>('SELECT SUM(debit) - SUM(credit) AS v FROM journal_lines WHERE company = ? AND account = ?', [t.company, ACCOUNTS.CASH]);
    const w = JSON.parse((await q.one<any>('SELECT world FROM companies WHERE id = ?', [t.company])).world);
    const inc = await q.one<any>("SELECT id FROM incidents WHERE company = ? AND kind = 'ops-stalled' AND status = 'open'", [t.company]);
    return { cash: Number(b.v), freeze: w.freeze, outage: !!inc };
  });
  if (!s.freeze && s.cash < POLICY.cashReserveCents) {
    await t.exec('SetSpendFreeze', { on: true, reason: `cash ${money(s.cash)} below the ${money(POLICY.cashReserveCents)} reserve` }, { rule: 'cash-reserve', text: 'protect the operating reserve' });
  } else if (s.freeze && !s.outage && s.cash >= POLICY.cashReserveCents * 1.5) {
    await t.exec('SetSpendFreeze', { on: false }, { rule: 'lift-freeze', text: `cash ${money(s.cash)} is comfortably above reserve and Operations is shipping` });
  }
}
