// The simulated environment: customers, suppliers, the carrier and the payment network. It is not an agent and makes
// no company decisions: it produces demand, answers quotes, delivers parcels, lands supplier shipments and loses
// patience — all from the seeded hash, so a seed and the same operator inputs give the same history.
import type { Q } from './db.ts';
import { Ctx } from './kernel.ts';
import { CARRIER_TICKS, POLICY, PRODUCTS, TICKS_PER_DAY, dayOf, draw, poisson, product, type Scenario } from './model.ts';

export async function worldPhase(q: Q, company: string, clock: number, seed: number) {
  const ctx = new Ctx(q, company, clock, 'world', seed);
  const day = dayOf(clock);
  if (clock % TICKS_PER_DAY === 0) await ctx.emit('DayStarted', `day:${day}`, `Day ${day} begins`, { day }, `day-start:${day}`);

  // Scenario injections due now (storyline or operator).
  const c = await q.one<any>('SELECT scenarios, world FROM companies WHERE id = ?', [company]);
  const scen: (Scenario & { done?: boolean })[] = JSON.parse(c.scenarios);
  let changed = false;
  for (const s of scen) {
    if (s.done || s.at > clock) continue;
    s.done = true; changed = true;
    await applyScenario(ctx, s);
  }
  if (changed) await q.run('UPDATE companies SET scenarios = ? WHERE id = ?', [JSON.stringify(scen), company]);

  // Temporary supplier delays end.
  const w0 = JSON.parse((await q.one<any>('SELECT world FROM companies WHERE id = ?', [company])).world);
  for (const [sup, until] of Object.entries<number>(w0.delays ?? {})) {
    if (clock < until) continue;
    delete w0.delays[sup];
    await q.run('UPDATE companies SET world = ? WHERE id = ?', [JSON.stringify(w0), company]);
    await q.run("UPDATE suppliers SET delay_ticks = 0, delay_sku = '', status = 'normal' WHERE company = ? AND id = ?", [company, sup]);
    await ctx.emit('SupplierRecovered', sup, `${sup} is back to normal lead times`, { supplier: sup });
  }

  // Approvals left undecided past their window expire; the requester decides again.
  for (const a of await q.all<any>("SELECT id, requester, summary FROM approvals WHERE company = ? AND status = 'pending' AND expires_at < ? ORDER BY CAST(SUBSTR(id, 4) AS INTEGER)", [company, clock])) {
    await q.run("UPDATE approvals SET status = 'expired' WHERE company = ? AND id = ?", [company, a.id]);
    await ctx.emit('ApprovalExpired', a.id, `${a.id} expired undecided: ${a.summary}`, { approval: a.id }, null, a.requester);
  }

  // Supplier shipments land at the dock.
  for (const po of await q.all<any>("SELECT id, sku, qty, supplier FROM purchase_orders WHERE company = ? AND status = 'funded' AND eta_tick <= ? ORDER BY CAST(SUBSTR(id, 4) AS INTEGER)", [company, clock])) {
    await q.run("UPDATE purchase_orders SET status = 'arrived', version = version + 1 WHERE company = ? AND id = ?", [company, po.id]);
    await ctx.emit('GoodsArrived', po.id, `${po.supplier} delivered ${po.qty} × ${po.sku} (${po.id}) to the dock`, { po: po.id, sku: po.sku, qty: po.qty });
  }

  // The carrier delivers parcels a day after dispatch; customers judge the promise.
  for (const s of await q.all<any>(`SELECT s.id, s.order_id, o.customer, o.promised_tick, o.shipped_at, o.notified FROM shipments s JOIN orders o ON o.company = s.company AND o.id = s.order_id
      WHERE s.company = ? AND s.status = 'dispatched' AND s.dispatched_at + ? <= ? ORDER BY CAST(SUBSTR(s.order_id, 3) AS INTEGER)`, [company, CARRIER_TICKS, clock])) {
    await q.run("UPDATE shipments SET status = 'delivered', delivered_at = ? WHERE company = ? AND id = ?", [clock, company, s.id]);
    await ctx.orderStatus(s.order_id, ['shipped'], 'delivered', ', delivered_at = ?', [clock]);
    const onTime = s.shipped_at <= s.promised_tick;
    const cu = await q.one<any>('SELECT satisfaction FROM customers WHERE company = ? AND id = ?', [company, s.customer]);
    const sat = Math.max(0, Math.min(100, cu.satisfaction + (onTime ? 4 : s.notified ? -3 : -10)));
    await q.run('UPDATE customers SET satisfaction = ? WHERE company = ? AND id = ?', [sat, company, s.customer]);
    await ctx.emit('OrderDelivered', s.order_id, `${s.customer} received ${s.order_id}${onTime ? ' on time' : ' late'}`, { order: s.order_id, customer: s.customer, on_time: onTime });
  }

  // Customers answer open quotes.
  for (const qt of await q.all<any>(`SELECT q.*, l.requested_discount_bp AS asked, c.kind AS ckind, c.satisfaction FROM quotes q JOIN leads l ON l.company = q.company AND l.id = q.lead
      JOIN customers c ON c.company = q.company AND c.id = q.customer WHERE q.company = ? AND q.status = 'open' AND q.at < ? ORDER BY CAST(SUBSTR(q.id, 3) AS INTEGER)`, [company, clock])) {
    const waitDays = (qt.promised_tick - qt.at) / TICKS_PER_DAY;
    let pAccept = 0.8 - Math.max(0, waitDays - 2) * 0.12 + (qt.discount_bp / 10_000) * 1.5 - (qt.asked > qt.discount_bp ? 0.25 : 0) + (qt.satisfaction - 70) / 400;
    pAccept = Math.max(0.05, Math.min(0.97, pAccept));
    const yes = draw(seed, 'accept', qt.id) < pAccept;
    await q.run('UPDATE quotes SET status = ? WHERE company = ? AND id = ?', [yes ? 'accepted' : 'declined', company, qt.id]);
    if (!yes) await q.run("UPDATE leads SET status = 'lost', version = version + 1 WHERE company = ? AND id = ?", [company, qt.lead]);
    await ctx.emit(yes ? 'QuoteAccepted' : 'QuoteDeclined', qt.id, `${qt.customer} ${yes ? 'accepted' : 'declined'} ${qt.id}`, { quote: qt.id, customer: qt.customer, p_accept: Math.round(pAccept * 100) / 100 });
  }

  // Patience: an order far past its promise makes the customer leave (observed churn in the simulation).
  for (const o of await q.all<any>(`SELECT o.id, o.customer, o.total, o.promised_tick, c.patience FROM orders o JOIN customers c ON c.company = o.company AND c.id = o.customer
      WHERE o.company = ? AND o.status IN ('placed','reserved','backordered') AND o.cancel_requested = 0 AND c.status <> 'churned' AND o.promised_tick + c.patience < ? ORDER BY CAST(SUBSTR(o.id, 3) AS INTEGER)`, [company, clock])) {
    await q.run('UPDATE orders SET cancel_requested = 1, version = version + 1 WHERE company = ? AND id = ?', [company, o.id]);
    await ctx.customerStatus(o.customer, 'churned');
    await ctx.emit('CancellationRequested', o.id, `${o.customer} gave up waiting for ${o.id} and is leaving`, { order: o.id, customer: o.customer, total: o.total });
  }
  // Modeled churn risk: a customer with an unshipped order past its promise is at risk.
  for (const cu of await q.all<any>(`SELECT c.id, c.status, c.satisfaction, (SELECT COUNT(*) FROM orders o WHERE o.company = c.company AND o.customer = c.id
      AND o.status IN ('placed','reserved','backordered','packed') AND o.promised_tick < ?) AS late FROM customers c WHERE c.company = ? AND c.status <> 'churned' ORDER BY c.id`, [clock, company])) {
    const risk = Number(cu.late) > 0 || cu.satisfaction < 50;
    if (risk && cu.status === 'active') await ctx.customerStatus(cu.id, 'at_risk');
    if (!risk && cu.status === 'at_risk') await ctx.customerStatus(cu.id, 'active');
  }
  if (ctx.facts.customers.length) await ctx.emit('ChurnRiskUpdated', 'customers', `Modeled churn risk changed for ${ctx.facts.customers.length} customers`, {});

  // New demand.
  const w = JSON.parse((await q.one<any>('SELECT world FROM companies WHERE id = ?', [company])).world);
  const adsToday = await q.one<any>('SELECT ref FROM expenses WHERE company = ? AND id = ?', [company, `EX-ads-${day}`]);
  const adSkus: string[] = adsToday ? JSON.parse(adsToday.ref) : [];
  const custs = await q.all<any>("SELECT id, kind FROM customers WHERE company = ? AND status <> 'churned' ORDER BY id", [company]);
  for (const p of PRODUCTS) {
    const surge = w.surge?.[p.sku] && w.surge[p.sku].until > clock ? w.surge[p.sku].factor : 1;
    const mean = (p.daily / TICKS_PER_DAY) * surge * (adSkus.includes(p.sku) ? 1.25 : 1);
    const k = poisson(seed, 'leads', `${clock}:${p.sku}`, mean);
    for (let i = 0; i < k && custs.length; i++) {
      const cu = custs[Math.floor(draw(seed, 'who', `${clock}:${p.sku}:${i}`) * custs.length)];
      const cafe = cu.kind === 'cafe';
      const qty = p.sku === 'FILTERS' ? (cafe ? 5 + Math.floor(draw(seed, 'qty', `${clock}:${p.sku}:${i}`) * 10) : 1 + Math.floor(draw(seed, 'qty', `${clock}:${p.sku}:${i}`) * 3))
        : cafe ? 2 + Math.floor(draw(seed, 'qty', `${clock}:${p.sku}:${i}`) * 4) : 1;
      const asked = cafe && draw(seed, 'ask', `${clock}:${p.sku}:${i}`) < 0.3 ? 500 + Math.floor(draw(seed, 'askpct', `${clock}:${p.sku}:${i}`) * 6) * 100 : 0;
      await newLead(ctx, cu.id, p.sku, qty, asked);
    }
  }
  return ctx.seqs;
}

async function newLead(ctx: Ctx, customer: string, sku: string, qty: number, askedBp: number, note = '') {
  const id = `L-${await ctx.nextId('lead')}`;
  await ctx.q.run('INSERT INTO leads (company, id, customer, sku, qty, requested_discount_bp, at) VALUES (?,?,?,?,?,?,?)', [ctx.company, id, customer, sku, qty, askedBp, ctx.clock]);
  await ctx.emit('LeadArrived', id, `${customer} wants ${qty} × ${product(sku).name}${askedBp ? ` and asks for ${askedBp / 100}% off` : ''}${note}`, { lead: id, customer, sku, qty, requested_discount_bp: askedBp });
}

async function applyScenario(ctx: Ctx, s: Scenario) {
  const { q, company, clock } = ctx;
  const by = s.by === 'operator' ? 'operator-injected' : 'storyline';
  if (s.kind === 'inventory-shock') {
    const w = JSON.parse((await q.one<any>('SELECT world FROM companies WHERE id = ?', [company])).world);
    w.surge = { ...(w.surge ?? {}), GRINDER: { factor: 4, until: clock + 2 * TICKS_PER_DAY } };
    w.delays = { ...(w.delays ?? {}), NORTHGATE: clock + 3 * TICKS_PER_DAY };
    await q.run('UPDATE companies SET world = ? WHERE id = ?', [JSON.stringify(w), company]);
    await ctx.emit('DemandSurge', 'GRINDER', `A coffee magazine features the Burr grinder: demand ×4 for two days (${by}; no agent is told)`, { sku: 'GRINDER', factor: 4, until: clock + 16, by });
    const delay = 3 * TICKS_PER_DAY;
    // The grinder line at Northgate stalls: open grinder orders slip 3 days, and new ones carry the delay until it clears.
    await q.run("UPDATE suppliers SET delay_ticks = ?, delay_sku = 'GRINDER', status = 'delayed' WHERE company = ? AND id = 'NORTHGATE'", [delay, company]);
    const slipped = await q.run("UPDATE purchase_orders SET eta_tick = eta_tick + ?, version = version + 1 WHERE company = ? AND supplier = 'NORTHGATE' AND sku = 'GRINDER' AND status = 'funded'", [delay, company]);
    await ctx.emit('SupplierDelayed', 'NORTHGATE', `Northgate reports a 3-day delay (${slipped} open grinder shipment${slipped === 1 ? '' : 's'} slipped; new orders delayed until it clears) (${by})`, { supplier: 'NORTHGATE', delay_ticks: delay, slipped, by });
  }
  if (s.kind === 'operations-failure') {
    await q.run("UPDATE agents SET fault_mode = 'crash_mid_turn', version = version + 1 WHERE company = ? AND role = 'operations' AND status <> 'faulted'", [company]);
    await ctx.emit('FaultInjected', 'operations', `Fault injected into the Operations runtime: it will crash mid-turn (${by}); nobody is told`, { role: 'operations', mode: 'crash_mid_turn', by });
  }
  if (s.kind === 'big-discount') {
    await newLead(ctx, 'C-03', 'GRINDER', 6, 1800, ` (${by})`);
  }
  if (s.kind === 'duplicate-payment') {
    const o = await q.one<any>("SELECT o.id, o.total FROM orders o WHERE o.company = ? AND o.paid > 0 ORDER BY o.placed_at DESC, CAST(SUBSTR(o.id, 3) AS INTEGER) DESC LIMIT 1", [company]);
    if (o) await ctx.emit('OrderPlaced', o.id, `The payment network re-delivered OrderPlaced for ${o.id} (${by} duplicate)`, { order: o.id, total: o.total, redelivery: true });
  }
  void POLICY;
}
