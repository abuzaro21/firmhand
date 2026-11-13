// OPERATIONS: turns paid commitments into shipments without inventing stock. It reserves, packs and dispatches in
// promise order within capacity, watches projected supply against observed demand, and proposes purchases sized to
// stay inside Finance's pre-authorised limits whenever it can.
import { POLICY, PRODUCTS, SHIP_CAPACITY_PER_TICK, SUPPLIERS, TICKS_PER_DAY, dayOf, money, product } from '../model.ts';
import type { Policy, Turn } from './types.ts';

export const operations: Policy = async (t) => {
  const m = t.mem;
  if (m.recovering) await reconcileAfterRecovery(t);

  for (const task of t.tasks) {
    const p = task.payload;
    switch (task.kind) {
      case 'OrderPlaced': await reserveOrBackorder(t, p.order, task.seq); break;
      case 'OrderCancelled': {
        const r = await t.read((q) => q.one<any>("SELECT status FROM reservations WHERE company = ? AND order_id = ?", [t.company, p.order]));
        if (r?.status === 'active') await t.exec('ReleaseReservation', { order: p.order }, { rule: 'release-cancelled', text: `${p.order} was cancelled; return its stock to the shelf` }, task.seq);
        break;
      }
      case 'GoodsArrived': await t.exec('ReceiveGoods', { po: p.po }, { rule: 'receive-arrival', text: `${p.po} arrived at the dock; count it into stock` }, task.seq); break;
      case 'SupplierDelayed': m.delayed = { supplier: p.supplier, by: p.delay_ticks, at: t.clock }; break;
      default: break; // PaymentCaptured, PurchaseFunded/Declined, DayStarted, SpendFreezeChanged: read from shared records below
    }
    await t.done(task);
  }

  // Backorders get stock first, earliest promise first, as soon as any is free.
  const back = await t.read((q) => q.all<any>(`SELECT o.id FROM orders o WHERE o.company = ? AND o.status = 'backordered' ORDER BY o.promised_tick, o.placed_at, CAST(SUBSTR(o.id, 3) AS INTEGER)`, [t.company]));
  for (const o of back) await reserveOrBackorder(t, o.id);

  // Pack paid, reserved orders in promise order, within this hour's capacity.
  const ready = await t.read((q) => q.all<any>(`SELECT id, promised_tick FROM orders WHERE company = ? AND status = 'reserved' AND paid = total AND paid > 0
    ORDER BY promised_tick, placed_at, CAST(SUBSTR(id, 3) AS INTEGER) LIMIT ?`, [t.company, SHIP_CAPACITY_PER_TICK]));
  const packed: string[] = [];
  for (const o of ready) {
    const r = await t.exec('Pack', { order: o.id }, { rule: 'pack-by-promise', text: `${o.id} is paid and reserved; promise Day ${dayOf(o.promised_tick)} is the earliest in the queue` });
    if (r.outcome === 'committed') packed.push(o.id);
  }
  t.checkpoint('after-pack'); // an injected crash here leaves packed shipments that were never handed to the carrier
  // Dispatch from the durable record, not from this turn's memory: a parcel packed by a turn that died (process kill,
  // redeploy) is still on the bench and goes out now, exactly once (shipments are unique per order).
  const bench = await t.read((q) => q.all<any>("SELECT order_id FROM shipments WHERE company = ? AND status = 'packed' ORDER BY packed_at, CAST(SUBSTR(order_id, 3) AS INTEGER)", [t.company]));
  for (const s of bench) {
    const leftover = !packed.includes(s.order_id);
    await t.exec('Dispatch', { order: s.order_id }, leftover
      ? { rule: 'finish-interrupted-pack', text: `${s.order_id} was packed by an interrupted turn and never handed over; dispatch it once` }
      : { rule: 'hand-to-carrier', text: `hand ${s.order_id} to the carrier` });
  }

  await planSupply(t);
  const q = await t.read((q) => q.one<any>("SELECT COUNT(*) AS n FROM orders WHERE company = ? AND status IN ('placed','reserved','backordered','packed')", [t.company]));
  t.plan(`${packed.length} shipped this hour; ${q.n} orders in the fulfilment queue${m.delayed ? `; ${m.delayed.supplier} delayed` : ''}`);
};

async function reserveOrBackorder(t: Turn, orderId: string, causation?: number) {
  const o = await t.read((q) => q.one<any>(`SELECT o.status, l.sku, l.qty, i.on_hand - i.reserved AS free FROM orders o JOIN order_lines l ON l.company = o.company AND l.order_id = o.id
    JOIN inventory i ON i.company = o.company AND i.sku = l.sku WHERE o.company = ? AND o.id = ?`, [t.company, orderId]));
  if (!o || !['placed', 'backordered'].includes(o.status)) return;
  if (o.free >= o.qty) {
    await t.exec('ReserveStock', { order: orderId }, { rule: 'reserve-on-order', text: `${o.qty} × ${o.sku} free (${o.free} available); reserve for ${orderId}`, inputs: { free: o.free } }, causation);
  } else if (o.status === 'placed') {
    await t.exec('Backorder', { order: orderId }, { rule: 'backorder-not-oversell', text: `only ${o.free} ${o.sku} free for ${o.qty} ordered; backorder rather than oversell`, inputs: { free: o.free } }, causation);
  }
}

/** Supply planning. Shortfall = waiting demand + two days of observed demand − free stock − stock arriving in two days. */
async function planSupply(t: Turn) {
  const horizon = 2 * TICKS_PER_DAY;
  const facts = await t.read(async (q) => {
    const out: Record<string, any> = {};
    const spent = await q.one<any>("SELECT COALESCE(SUM(total),0) AS v FROM purchase_orders WHERE company = ? AND kind = 'expedite' AND status IN ('funded','arrived','received')", [t.company]);
    for (const p of PRODUCTS) {
      const inv = await q.one<any>('SELECT on_hand, reserved FROM inventory WHERE company = ? AND sku = ?', [t.company, p.sku]);
      const waiting = await q.one<any>(`SELECT COALESCE(SUM(l.qty),0) AS v FROM orders o JOIN order_lines l ON l.company = o.company AND l.order_id = o.id WHERE o.company = ? AND l.sku = ? AND o.status IN ('placed','backordered')`, [t.company, p.sku]);
      const recent = await q.one<any>('SELECT COALESCE(SUM(qty),0) AS v, COUNT(*) AS n FROM leads WHERE company = ? AND sku = ? AND at > ? AND at <= ?', [t.company, p.sku, t.clock - TICKS_PER_DAY, t.clock]);
      const inSoon = await q.one<any>("SELECT COALESCE(SUM(qty),0) AS v FROM purchase_orders WHERE company = ? AND sku = ? AND status IN ('funded','arrived') AND eta_tick <= ?", [t.company, p.sku, t.clock + horizon]);
      const inAll = await q.one<any>("SELECT COALESCE(SUM(qty),0) AS v FROM purchase_orders WHERE company = ? AND sku = ? AND status IN ('funded','arrived')", [t.company, p.sku]);
      const pending = await q.all<any>("SELECT id, kind, qty FROM purchase_orders WHERE company = ? AND sku = ? AND status IN ('proposed','awaiting_approval') ORDER BY " + "CAST(SUBSTR(id, 4) AS INTEGER)", [t.company, p.sku]);
      const incident = await q.one<any>("SELECT id FROM incidents WHERE company = ? AND kind = 'shortage' AND status = 'open' AND id LIKE ?", [t.company, `INC-shortage-${p.sku}-%`]);
      out[p.sku] = { free: inv.on_hand - inv.reserved, waiting: Number(waiting.v), recent: Number(recent.v), recentLeads: Number(recent.n), inSoon: Number(inSoon.v), inAll: Number(inAll.v), pending, incident: incident?.id };
    }
    return { skus: out, expediteSpent: Number(spent.v) };
  });
  for (const p of PRODUCTS) {
    const f = facts.skus[p.sku];
    // Expected demand: what customers actually asked for in the last business day (at least the catalogue norm).
    const demand2d = Math.max(f.recent, p.daily_units) * 2 * 0.8; // ~80% of asks convert
    const shortfall = Math.ceil(f.waiting + demand2d - f.free - f.inSoon);
    const surging = f.recentLeads >= Math.max(p.daily * 2, p.daily + 3 * Math.sqrt(p.daily)); // well beyond normal day-to-day noise

    if (t.policies.selfCorrect) {
      if (shortfall > 0 && (f.waiting > 0 || surging) && !f.incident) {
        await t.exec('ReportShortage', { sku: p.sku, shortfall, detail: { free: f.free, waiting: f.waiting, demand_last_day: f.recent, inbound_2d: f.inSoon } },
          { rule: 'project-shortage', text: `${p.sku}: ${f.waiting} waiting + ~${Math.round(demand2d)} expected vs ${f.free} free + ${f.inSoon} arriving in 2 days`, inputs: f });
      }
      if (shortfall > 0 && (f.waiting > 0 || surging) && !f.pending.some((x: any) => x.kind === 'expedite')) {
        const backup = SUPPLIERS[1]; const unit = Math.round((p.std_cost * backup.cost_bp) / 10_000);
        const budgetLeft = POLICY.expediteWeeklyCents - facts.expediteSpent;
        const qty = Math.min(shortfall + 2, Math.floor(budgetLeft / unit), Math.floor(POLICY.purchaseAutoCents / unit));
        if (qty > 0) await t.exec('ProposePurchase', { sku: p.sku, qty, supplier: backup.id, kind: 'expedite', reason: `shortfall ${shortfall}; sized to the remaining ${money(budgetLeft)} expedite budget` },
          { rule: 'expedite-within-budget', text: `${backup.id} delivers in 1 day at +35%; ${qty} units fits the pre-authorised expedite budget`, inputs: { shortfall, budgetLeft, unit } });
      }
      if (f.incident && shortfall <= 0 && f.waiting === 0) {
        await t.exec('ResolveShortage', { incident: f.incident, sku: p.sku, summary: `${p.sku} covered: ${f.free} free, nothing waiting` }, { rule: 'close-shortage', text: `${p.sku} supply covers demand again` });
      }
    }
    // Ordinary replenishment from the primary supplier.
    const position = f.free + f.inAll + f.pending.filter((x: any) => x.kind === 'replenish').reduce((s: number, x: any) => s + x.qty, 0) - f.waiting;
    if (position < p.reorder_point && !f.pending.some((x: any) => x.kind === 'replenish')) {
      const qty = p.target_stock - position;
      await t.exec('ProposePurchase', { sku: p.sku, qty, supplier: SUPPLIERS[0].id, kind: 'replenish', reason: `stock position ${position} below reorder point ${p.reorder_point}` },
        { rule: 'reorder-point', text: `${p.sku} position ${position} < reorder point ${p.reorder_point}: replenish to ${p.target_stock}`, inputs: { position, ...f } });
    }
  }
}

/** After an authorised restart: finish half-done work exactly once before taking anything new. */
async function reconcileAfterRecovery(t: Turn) {
  const packed = await t.read((q) => q.all<any>("SELECT order_id FROM shipments WHERE company = ? AND status = 'packed' ORDER BY packed_at, CAST(SUBSTR(order_id, 3) AS INTEGER)", [t.company]));
  let dispatched = 0;
  for (const s of packed) {
    const r = await t.exec('Dispatch', { order: s.order_id }, { rule: 'recovery-finish-packed', text: `${s.order_id} was packed before the crash but never handed over; dispatch it once` });
    if (r.outcome === 'committed') dispatched++;
  }
  const queued = t.tasks.length;
  await t.exec('ReportRecovery', { packed_found: packed.length, dispatched, inbox_backlog: queued }, { rule: 'recovery-report', text: 'record what the restart found and finished' });
  t.mem.recovering = false;
  t.mem.lastRecovery = { at: t.clock, packedFound: packed.length, dispatched, inboxBacklog: queued };
  t.plan(`recovered: ${packed.length} half-finished shipments found, ${dispatched} dispatched once; draining ${queued} queued tasks`);
  void product;
}
