// SALES: turns demand into commitments it can keep. It reads stock, inbound purchase orders, fulfilment backlog and
// its beliefs about the other roles (shortages, outages, spend freezes) before it promises anything.
import { AD_PER_DAY, POLICY, SHIP_CAPACITY_PER_TICK, TICKS_PER_DAY, dayOf, money, product } from '../model.ts';
import type { Policy, Turn } from './types.ts';
import { rebuild, track } from './continuations.ts';

type Promise_ = { tick: number; basis: string };

/** Sales's own available-to-promise model. With self-correction off (the naive baseline) it always promises next day. */
export async function promiseFor(t: Turn, sku: string, qty: number, ownWaiting = 0): Promise<Promise_> {
  const naive = t.clock + TICKS_PER_DAY;
  if (!t.policies.selfCorrect) return { tick: naive, basis: 'naive: always next day' };
  const s = await t.read(async (q) => {
    const inv = await q.one<any>('SELECT on_hand, reserved FROM inventory WHERE company = ? AND sku = ?', [t.company, sku]);
    const waiting = await q.one<any>(`SELECT COALESCE(SUM(l.qty),0) AS v FROM orders o JOIN order_lines l ON l.company = o.company AND l.order_id = o.id
      WHERE o.company = ? AND l.sku = ? AND o.status IN ('placed','backordered')`, [t.company, sku]);
    const backlog = await q.one<any>("SELECT COUNT(*) AS v FROM orders WHERE company = ? AND status IN ('placed','reserved','backordered','packed')", [t.company]);
    const inbound = await q.all<any>("SELECT qty, eta_tick FROM purchase_orders WHERE company = ? AND sku = ? AND status IN ('funded','arrived') ORDER BY eta_tick, CAST(SUBSTR(id, 4) AS INTEGER)", [t.company, sku]);
    // `free` may be negative: older orders already waiting have first claim on stock and on inbound purchases.
    return { free: inv.on_hand - inv.reserved - (Number(waiting.v) - ownWaiting), backlog: Number(backlog.v), inbound };
  });
  let tick = t.clock + TICKS_PER_DAY + Math.ceil(s.backlog / SHIP_CAPACITY_PER_TICK);
  let basis = `in stock; ${s.backlog} orders ahead in the fulfilment queue`;
  if (t.mem.opsDown) { tick = Math.max(tick, t.clock + 3 * TICKS_PER_DAY); basis = 'Operations is down: promise only after recovery'; }
  if (s.free >= qty) return { tick, basis };
  let need = qty - s.free;
  for (const po of s.inbound) {
    need -= po.qty;
    if (need <= 0) return { tick: Math.max(tick, po.eta_tick + 4), basis: `short now; covered by inbound stock arriving Day ${dayOf(po.eta_tick)}` };
  }
  return { tick: Math.max(tick, t.clock + 5 * TICKS_PER_DAY), basis: 'short with no inbound cover: long lead promise' };
}

export const sales: Policy = async (t) => {
  const m = t.mem;
  m.constrained ??= {}; m.pending ??= {}; m.opsDown ??= false; m.freeze ??= false;
  await rebuild(t, (kind, p) => kind === 'discount' ? { kind, lead: p.lead, discount: p.discount_bp } : kind === 'cancellation' ? { kind, order: p.order } : null);
  let dayStarted = false;

  for (const task of t.tasks) {
    const p = task.payload;
    switch (task.kind) {
      case 'DayStarted': dayStarted = true; break;
      case 'ShortageDetected': m.constrained[p.sku] = { since: t.clock, incident: p.incident }; break;
      case 'ShortageResolved': delete m.constrained[p.sku]; break;
      case 'CapacityLost': m.opsDown = true; break;
      case 'CapacityRestored': m.opsDown = false; break;
      case 'AgentRecovered': break;
      case 'SpendFreezeChanged': m.freeze = !!p.on; break;
      case 'LeadArrived': await quoteLead(t, p.lead, task.seq); break;
      case 'QuoteAccepted':
        await t.exec('PlaceOrder', { quote: p.quote }, { rule: 'convert-accepted-quote', text: `customer accepted ${p.quote}; booking it as an order` }, task.seq);
        break;
      case 'CancellationRequested': {
        const r = await t.exec('CancelOrder', { order: p.order, reason: 'customer lost patience' },
          { rule: 'honour-cancellation', text: `${p.customer} waited past their patience; cancel and let Finance refund the deposit`, inputs: { order: p.order, total: p.total } }, task.seq);
        await track(t, r, { kind: 'cancellation', order: p.order }, onApproval);
        break;
      }
      case 'ApprovalGranted': case 'ApprovalDenied': case 'ApprovalExpired': case 'ApprovalStale':
        await onApproval(t, task.kind, p); break;
      default: break;
    }
    await t.done(task);
  }

  // Proactive: tell customers before a promise breaks, and pay them a small credit (inside Sales's request rights;
  // Finance pays). The naive baseline never does this.
  if (t.policies.selfCorrect) await warnLateOrders(t);

  if (dayStarted) {
    const skus = Object.keys(m.constrained).length || m.opsDown ? ['KETTLE', 'DRIPPER', 'GRINDER', 'FILTERS'].filter((s) => !m.constrained[s]) : ['KETTLE', 'DRIPPER', 'GRINDER', 'FILTERS'];
    if (!t.policies.selfCorrect || (!m.freeze && !m.opsDown && skus.length)) {
      await t.exec('RequestAdSpend', { day: dayOf(t.clock), amount: AD_PER_DAY, skus: t.policies.selfCorrect ? skus : ['KETTLE', 'DRIPPER', 'GRINDER', 'FILTERS'] },
        { rule: 'daily-campaign', text: m.constrained && Object.keys(m.constrained).length ? `advertise only in-stock lines; ${Object.keys(m.constrained).join(', ')} constrained` : 'normal daily campaign' });
    } else {
      t.plan(m.opsDown ? 'no advertising: Operations cannot ship' : 'no advertising: Finance froze discretionary spend');
    }
  }
  t.plan(`${Object.keys(m.constrained).length ? `constrained: ${Object.keys(m.constrained).join(', ')}; ` : ''}${m.opsDown ? 'holding near-date promises (Operations down); ' : ''}${Object.keys(m.pending).length} awaiting human decisions`);
};

async function quoteLead(t: Turn, leadId: string, causation: number, approvalId?: string, forcedDiscount?: number) {
  const lead = await t.read((q) => q.one<any>('SELECT l.*, c.kind AS ckind, c.status AS cstatus FROM leads l JOIN customers c ON c.company = l.company AND c.id = l.customer WHERE l.company = ? AND l.id = ?', [t.company, leadId]));
  if (!lead || !['new', 'escalated'].includes(lead.status)) return;
  const pr = product(lead.sku);
  const promise = await promiseFor(t, lead.sku, lead.qty);
  const constrained = !!t.mem.constrained[lead.sku] && t.policies.selfCorrect;
  let discount = 0; let rule = 'list-price'; let text = `quote ${lead.qty} × ${pr.name} at list; ${promise.basis}`;
  if (forcedDiscount !== undefined) { discount = forcedDiscount; rule = 'approval-outcome'; text = `quote at ${discount / 100}% after the human decision; ${promise.basis}`; }
  else if (lead.requested_discount_bp > 0) {
    if (constrained) { rule = 'no-discount-on-constrained-stock'; text = `${lead.customer} asked for ${lead.requested_discount_bp / 100}% but ${lead.sku} is short: quote at list`; }
    else { discount = lead.requested_discount_bp; rule = discount > POLICY.discountAutoBp ? 'request-discount-approval' : 'grant-requested-discount';
      text = `${lead.customer} asked for ${discount / 100}%${discount > POLICY.discountAutoBp ? ` (above my ${POLICY.discountAutoBp / 100}% authority)` : ''}; ${promise.basis}`; }
  } else if (lead.cstatus === 'at_risk' && !constrained) { discount = 500; rule = 'retention-offer'; text = `${lead.customer} is at risk of churning: 5% retention offer; ${promise.basis}`; }
  const r = await t.exec('IssueQuote', { lead: leadId, discount_bp: discount, promised_tick: promise.tick, ...(approvalId ? { approval_id: approvalId } : {}) },
    { rule, text, inputs: { sku: lead.sku, qty: lead.qty, requested_bp: lead.requested_discount_bp, promise_basis: promise.basis, constrained } }, causation);
  await track(t, r, { kind: 'discount', lead: leadId, discount }, onApproval);
  return r;
}

async function onApproval(t: Turn, kind: string, p: any) {
  const pend = t.mem.pending[p.approval];
  if (!pend) return;
  delete t.mem.pending[p.approval];
  // Not granted, or granted but no longer executable (expired before use, or the records it covered changed): never leave
  // the customer hanging; fall back to what Sales may do on its own authority.
  if (pend.kind === 'discount') {
    const r = kind === 'ApprovalGranted' ? await quoteLead(t, pend.lead, 0, p.approval, pend.discount) : undefined;
    if (!r || r.outcome === 'rejected') await quoteLead(t, pend.lead, 0, undefined, POLICY.discountAutoBp); // the most Sales may give alone
  }
  if (pend.kind === 'cancellation') {
    const r = kind === 'ApprovalGranted' ? await t.exec('CancelOrder', { order: pend.order, reason: 'customer lost patience', approval_id: p.approval }, { rule: 'execute-approved-cancellation', text: `human approved cancelling ${pend.order}` }) : undefined;
    if (!r || r.outcome === 'rejected') await t.exec('RequestCredit', { order: pend.order, amount: POLICY.delayCreditCents * 2, reason: 'kept-order' }, { rule: 'cancellation-fallback', text: `${pend.order} stays open; offer a goodwill credit instead` });
  }
}

async function warnLateOrders(t: Turn) {
  const rows = await t.read((q) => q.all<any>(`SELECT o.id, o.customer, o.promised_tick, o.status, l.sku, l.qty FROM orders o JOIN order_lines l ON l.company = o.company AND l.order_id = o.id
    WHERE o.company = ? AND o.notified = 0 AND o.status IN ('placed','reserved','backordered') ORDER BY o.promised_tick, o.placed_at, CAST(SUBSTR(o.id, 3) AS INTEGER) LIMIT 40`, [t.company]));
  let n = 0;
  for (const o of rows) {
    if (n >= 8) break;
    const atRisk = o.status === 'backordered' ? true : t.mem.opsDown ? o.promised_tick <= t.clock + TICKS_PER_DAY : o.promised_tick <= t.clock;
    if (!atRisk) continue;
    const pr = o.status === 'backordered' ? await promiseFor(t, o.sku, o.qty, o.qty) : { tick: t.clock + (t.mem.opsDown ? 3 : 1) * TICKS_PER_DAY, basis: t.mem.opsDown ? 'Operations outage' : 'fulfilment queue' };
    if (pr.tick <= o.promised_tick) continue;
    const r = await t.exec('NotifyDelay', { order: o.id, new_promise: pr.tick }, { rule: 'warn-before-breaking-promise', text: `${o.id} will miss Day ${dayOf(o.promised_tick)} (${pr.basis}); tell ${o.customer} now`, inputs: { status: o.status, old: o.promised_tick, new: pr.tick } });
    if (r.outcome === 'committed') {
      n++;
      await t.exec('RequestCredit', { order: o.id, amount: POLICY.delayCreditCents, reason: 'delay' }, { rule: 'delay-goodwill', text: `${money(POLICY.delayCreditCents)} goodwill credit for the delay (inside policy)` });
    }
  }
}
