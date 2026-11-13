// Business commands. Each runs inside the Gate's transaction with the executing role already capability-checked.
// Handlers validate every precondition against current records (never against what the agent believed when it
// planned), enforce authority thresholds, and write records + journal + events atomically.
import { ACCOUNTS as A, POLICY, SHIPPING_COST, dayOf, money, product, type Role } from './model.ts';
import { Ctx, Duplicate, NotFound, Rejected, requireApproval, type Handler } from './kernel.ts';
import { checksum as stateChecksum, computeKpis, liveState, reconcile } from './kpi.ts';

const str = (v: unknown, name: string) => { if (typeof v !== 'string' || !v || v.length > 64) throw new Rejected(`${name} required`); return v; };
const int = (v: unknown, name: string, min = 0, max = 10_000_000) => {
  if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) throw new Rejected(`${name} must be an integer in [${min}, ${max}]`);
  return v as number;
};
async function order(ctx: Ctx, id: string) {
  const o = await ctx.q.one<any>('SELECT o.*, l.sku, l.qty FROM orders o JOIN order_lines l ON l.company = o.company AND l.order_id = o.id AND l.line = 1 WHERE o.company = ? AND o.id = ?', [ctx.company, id]);
  if (!o) throw new NotFound(`order ${id}`);
  return o;
}
async function world(ctx: Ctx) { return JSON.parse((await ctx.q.one<{ world: string }>('SELECT world FROM companies WHERE id = ?', [ctx.company]))!.world); }
async function setWorld(ctx: Ctx, w: any) { await ctx.q.run('UPDATE companies SET world = ? WHERE id = ?', [JSON.stringify(w), ctx.company]); }
export async function spendFrozen(ctx: Ctx) { return !!(await world(ctx)).freeze; }

export const HANDLERS: Record<string, Handler> = {
  // ---------------------------------------------------------------- Sales
  async IssueQuote(ctx, p, role) {
    const leadId = str(p.lead, 'lead');
    const discount = int(p.discount_bp, 'discount_bp', 0, 10_000);
    const promised = int(p.promised_tick, 'promised_tick', ctx.clock + 1, ctx.clock + 200);
    const lead = await ctx.q.one<any>('SELECT * FROM leads WHERE company = ? AND id = ?', [ctx.company, leadId]);
    if (!lead) throw new NotFound(`lead ${leadId}`);
    if (await ctx.q.one('SELECT 1 AS x FROM quotes WHERE company = ? AND lead = ?', [ctx.company, leadId])) throw new Duplicate(`lead ${leadId} already quoted`);
    if (!['new', 'escalated'].includes(lead.status)) throw new Rejected(`lead ${leadId} is ${lead.status}`);
    if (discount > POLICY.discountHardBp) throw new Rejected(`discount ${discount / 100}% exceeds the hard limit of ${POLICY.discountHardBp / 100}%`);
    const pr = product(lead.sku);
    const gross = pr.price * lead.qty;
    const total = Math.round((gross * (10_000 - discount)) / 10_000);
    if (discount > POLICY.discountAutoBp) {
      const margin = total - pr.std_cost * lead.qty;
      await requireApproval(ctx, role, {
        kind: 'discount', params: { lead: leadId, discount_bp: discount }, bound: [['leads', leadId, lead.version]],
        summary: `${discount / 100}% discount on ${lead.qty} × ${pr.name} for ${lead.customer} (${money(total)})`,
        evidence: { customer: lead.customer, requested_bp: lead.requested_discount_bp, list_value: gross, quoted_value: total, gross_margin_at_discount: margin,
          margin_pct: Math.round((margin / total) * 1000) / 10 },
        threshold: `discounts above ${POLICY.discountAutoBp / 100}% need a human (hard limit ${POLICY.discountHardBp / 100}%)`, idem: `discount:${leadId}`,
      }, p.approval_id);
    }
    const id = `Q-${await ctx.nextId('quote')}`;
    await ctx.q.run('INSERT INTO quotes (company, id, lead, customer, sku, qty, unit_price, discount_bp, total, promised_tick, status, at, approval_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [ctx.company, id, leadId, lead.customer, lead.sku, lead.qty, pr.price, discount, total, promised, 'open', ctx.clock, p.approval_id ?? null]);
    await ctx.q.run("UPDATE leads SET status = 'quoted', version = version + 1 WHERE company = ? AND id = ?", [ctx.company, leadId]);
    await ctx.emit('QuoteIssued', id, `Quote ${id}: ${lead.qty} × ${pr.name} ${money(total)}${discount ? ` (-${discount / 100}%)` : ''}, promised Day ${dayOf(promised)}`,
      { quote: id, lead: leadId, sku: lead.sku, qty: lead.qty, total, discount_bp: discount, promised_tick: promised });
    return { quote: id };
  },

  async PlaceOrder(ctx, p) {
    const quoteId = str(p.quote, 'quote');
    const qt = await ctx.q.one<any>('SELECT * FROM quotes WHERE company = ? AND id = ?', [ctx.company, quoteId]);
    if (!qt) throw new NotFound(`quote ${quoteId}`);
    if (await ctx.q.one('SELECT 1 AS x FROM orders WHERE company = ? AND quote = ?', [ctx.company, quoteId])) throw new Duplicate(`quote ${quoteId} already converted`);
    if (qt.status !== 'accepted') throw new Rejected(`quote ${quoteId} is ${qt.status}; only an accepted quote becomes an order`);
    const id = `O-${await ctx.nextId('order')}`;
    await ctx.q.run('INSERT INTO orders (company, id, quote, customer, total, promised_tick, original_promise, status, placed_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [ctx.company, id, quoteId, qt.customer, qt.total, qt.promised_tick, qt.promised_tick, 'placed', ctx.clock]);
    await ctx.q.run('INSERT INTO order_lines (company, order_id, line, sku, qty, unit_price, discount_bp, amount) VALUES (?,?,?,?,?,?,?,?)',
      [ctx.company, id, 1, qt.sku, qt.qty, qt.unit_price, qt.discount_bp, qt.total]);
    await ctx.q.run("UPDATE leads SET status = 'won', version = version + 1 WHERE company = ? AND id = ?", [ctx.company, qt.lead]);
    await ctx.q.run('UPDATE customers SET orders = orders + 1 WHERE company = ? AND id = ?', [ctx.company, qt.customer]);
    ctx.facts.orders.push({ id, status: 'placed', total: qt.total });
    await ctx.emit('OrderPlaced', id, `Order ${id} booked: ${qt.qty} × ${product(qt.sku).name}, ${money(qt.total)} (booked, not yet revenue)`,
      { order: id, customer: qt.customer, sku: qt.sku, qty: qt.qty, total: qt.total, promised_tick: qt.promised_tick });
    return { order: id };
  },

  async RequestAdSpend(ctx, p) {
    const day = int(p.day, 'day', 1, 100); const amount = int(p.amount, 'amount', 1, 1_000_000);
    if (day !== dayOf(ctx.clock)) throw new Rejected('ad spend can only be requested for the current day');
    await ctx.emit('AdSpendRequested', `ads:${day}`, `Sales requests ${money(amount)} of advertising for Day ${day} (${(p.skus ?? []).join(', ')})`,
      { day, amount, skus: Array.isArray(p.skus) ? p.skus.slice(0, 4) : [] }, `ads-request:${day}`);
  },

  async NotifyDelay(ctx, p) {
    const o = await order(ctx, str(p.order, 'order'));
    const promise = int(p.new_promise, 'new_promise', ctx.clock, ctx.clock + 200);
    if (!['placed', 'reserved', 'backordered'].includes(o.status)) throw new Rejected(`order ${o.id} is ${o.status}`);
    if (o.notified) throw new Duplicate(`order ${o.id} customer already notified`);
    await ctx.q.run('UPDATE orders SET notified = 1, promised_tick = ?, version = version + 1 WHERE company = ? AND id = ?', [promise, ctx.company, o.id]);
    await ctx.emit('CustomerNotified', o.id, `Sales told ${o.customer} that ${o.id} will now arrive Day ${dayOf(promise)}`, { order: o.id, customer: o.customer, old_promise: o.promised_tick, new_promise: promise });
  },

  async RequestCredit(ctx, p) {
    const o = await order(ctx, str(p.order, 'order'));
    const amount = int(p.amount, 'amount', 1, 1_000_000); const reason = str(p.reason, 'reason');
    await ctx.emit('CreditRequested', o.id, `Sales requests a ${money(amount)} goodwill credit for ${o.customer} (${reason})`, { order: o.id, amount, reason }, `credit-request:${o.id}:${reason}`);
  },

  async CancelOrder(ctx, p, role) {
    const o = await order(ctx, str(p.order, 'order'));
    if (o.status === 'cancelled') throw new Duplicate(`order ${o.id} already cancelled`);
    if (!['placed', 'reserved', 'backordered'].includes(o.status)) throw new Rejected(`order ${o.id} is ${o.status}; it can no longer be cancelled`);
    if (o.total > POLICY.cancelAutoCents) {
      await requireApproval(ctx, role, {
        kind: 'cancellation', params: { order: o.id }, bound: [['orders', o.id, o.version]],
        summary: `cancel ${o.id} for ${o.customer} and refund the ${money(o.paid)} deposit`,
        evidence: { order_total: o.total, paid: o.paid, status: o.status, reason: p.reason ?? '' },
        threshold: `cancelling a commitment above ${money(POLICY.cancelAutoCents)} needs a human`, idem: `cancel:${o.id}`,
      }, p.approval_id);
    }
    await ctx.orderStatus(o.id, ['placed', 'reserved', 'backordered'], 'cancelled');
    await ctx.emit('OrderCancelled', o.id, `Order ${o.id} cancelled (${String(p.reason ?? 'customer request')})`, { order: o.id, customer: o.customer, total: o.total, reason: p.reason ?? '' });
  },

  // ---------------------------------------------------------------- Operations
  async ReserveStock(ctx, p) {
    const o = await order(ctx, str(p.order, 'order'));
    if (await ctx.q.one("SELECT 1 AS x FROM reservations WHERE company = ? AND order_id = ? AND sku = ?", [ctx.company, o.id, o.sku])) throw new Duplicate(`order ${o.id} already has a reservation`);
    if (!['placed', 'backordered'].includes(o.status)) throw new Rejected(`order ${o.id} is ${o.status}`);
    await ctx.stock(o.sku, 0, o.qty, 0, 'reserve', o.id); // refuses if available < qty
    await ctx.q.run('INSERT INTO reservations (company, id, order_id, sku, qty, status, at) VALUES (?,?,?,?,?,?,?)', [ctx.company, `RES-${o.id}-${o.sku}`, o.id, o.sku, o.qty, 'active', ctx.clock]);
    await ctx.orderStatus(o.id, ['placed', 'backordered'], 'reserved');
    await ctx.emit('StockReserved', o.id, `Reserved ${o.qty} × ${o.sku} for ${o.id}`, { order: o.id, sku: o.sku, qty: o.qty });
  },

  async Backorder(ctx, p) {
    const o = await order(ctx, str(p.order, 'order'));
    if (o.status === 'backordered') throw new Duplicate(`order ${o.id} already backordered`);
    await ctx.orderStatus(o.id, ['placed'], 'backordered');
    await ctx.emit('OrderBackordered', o.id, `No free ${o.sku} for ${o.id}: backordered`, { order: o.id, sku: o.sku, qty: o.qty });
  },

  async ReleaseReservation(ctx, p) {
    const o = await order(ctx, str(p.order, 'order'));
    const r = await ctx.q.one<any>("SELECT * FROM reservations WHERE company = ? AND order_id = ?", [ctx.company, o.id]);
    if (!r || r.status !== 'active') throw new Duplicate(`order ${o.id} has no active reservation`);
    if (o.status !== 'cancelled') throw new Rejected(`order ${o.id} is ${o.status}; only cancelled orders release stock`);
    await ctx.stock(r.sku, 0, -r.qty, 0, 'release', o.id);
    await ctx.q.run("UPDATE reservations SET status = 'released' WHERE company = ? AND id = ? AND status = 'active'", [ctx.company, r.id]);
    await ctx.emit('ReservationReleased', o.id, `Released ${r.qty} × ${r.sku} from cancelled ${o.id}`, { order: o.id, sku: r.sku, qty: r.qty });
  },

  async Pack(ctx, p) {
    const o = await order(ctx, str(p.order, 'order'));
    if (await ctx.q.one('SELECT 1 AS x FROM shipments WHERE company = ? AND order_id = ?', [ctx.company, o.id])) throw new Duplicate(`order ${o.id} already has a shipment`);
    if (o.status !== 'reserved') throw new Rejected(`order ${o.id} is ${o.status}; only reserved orders are packed`);
    if (o.paid < o.total) throw new Rejected(`order ${o.id} is not paid; Operations never ships unpaid orders`);
    const r = await ctx.q.one<any>("SELECT * FROM reservations WHERE company = ? AND order_id = ? AND status = 'active'", [ctx.company, o.id]);
    if (!r) throw new Rejected(`order ${o.id} has no active reservation`);
    const inv = await ctx.q.one<any>('SELECT on_hand, value_cents FROM inventory WHERE company = ? AND sku = ?', [ctx.company, o.sku]);
    // Weighted-average cost in integer cents: take value proportionally; the last unit takes whatever value remains.
    const cost = inv.on_hand === o.qty ? inv.value_cents : Math.round((inv.value_cents * o.qty) / inv.on_hand);
    await ctx.stock(o.sku, -o.qty, -o.qty, -cost, 'pack', o.id);
    await ctx.q.run("UPDATE reservations SET status = 'consumed' WHERE company = ? AND id = ? AND status = 'active'", [ctx.company, r.id]);
    await ctx.q.run('INSERT INTO shipments (company, id, order_id, status, cost_value, packed_at) VALUES (?,?,?,?,?,?)', [ctx.company, `SH-${o.id}`, o.id, 'packed', cost, ctx.clock]);
    await ctx.orderStatus(o.id, ['reserved'], 'packed');
    await ctx.emit('ShipmentPacked', o.id, `Packed ${o.qty} × ${o.sku} for ${o.id} (cost ${money(cost)} leaves the shelf)`, { order: o.id, sku: o.sku, qty: o.qty, cost });
  },

  async Dispatch(ctx, p) {
    const o = await order(ctx, str(p.order, 'order'));
    const s = await ctx.q.one<any>('SELECT * FROM shipments WHERE company = ? AND order_id = ?', [ctx.company, o.id]);
    if (!s) throw new Rejected(`order ${o.id} has not been packed`);
    if (s.status !== 'packed') throw new Duplicate(`shipment ${s.id} already ${s.status}`);
    await ctx.q.run("UPDATE shipments SET status = 'dispatched', dispatched_at = ? WHERE company = ? AND id = ? AND status = 'packed'", [ctx.clock, ctx.company, s.id]);
    await ctx.orderStatus(o.id, ['packed'], 'shipped', ', shipped_at = ?', [ctx.clock]);
    await ctx.emit('ShipmentDispatched', o.id, `Dispatched ${o.id} to ${o.customer}${ctx.clock > o.promised_tick ? ' (late)' : ''}`,
      { order: o.id, shipment: s.id, total: o.total, cost: s.cost_value, late: ctx.clock > o.promised_tick });
  },

  async ReceiveGoods(ctx, p) {
    const po = await ctx.q.one<any>('SELECT * FROM purchase_orders WHERE company = ? AND id = ?', [ctx.company, str(p.po, 'po')]);
    if (!po) throw new NotFound('purchase order');
    if (po.status === 'received') throw new Duplicate(`${po.id} already received`);
    if (po.status !== 'arrived') throw new Rejected(`${po.id} is ${po.status}; only arrived goods can be received`);
    await ctx.stock(po.sku, po.qty, 0, po.total, 'receive', po.id);
    await ctx.q.run("UPDATE purchase_orders SET status = 'received', received_at = ?, version = version + 1 WHERE company = ? AND id = ?", [ctx.clock, ctx.company, po.id]);
    await ctx.emit('GoodsReceived', po.id, `Received ${po.qty} × ${po.sku} from ${po.supplier} (${po.id}, ${money(po.total)})`, { po: po.id, sku: po.sku, qty: po.qty, value: po.total });
  },

  async ProposePurchase(ctx, p) {
    const sku = str(p.sku, 'sku'); product(sku) ?? (() => { throw new Rejected('unknown sku'); })();
    const qty = int(p.qty, 'qty', 1, 500); const kind = p.kind === 'expedite' ? 'expedite' : 'replenish';
    const sup = await ctx.q.one<any>('SELECT * FROM suppliers WHERE company = ? AND id = ?', [ctx.company, str(p.supplier, 'supplier')]);
    if (!sup) throw new NotFound('supplier');
    const open = await ctx.q.one("SELECT id FROM purchase_orders WHERE company = ? AND sku = ? AND kind = ? AND status IN ('proposed','awaiting_approval')", [ctx.company, sku, kind]);
    if (open) throw new Duplicate(`an ${kind} purchase for ${sku} is already awaiting a decision`);
    const unit = Math.round((product(sku).std_cost * sup.cost_bp) / 10_000);
    const id = `PO-${await ctx.nextId('po')}`;
    await ctx.q.run('INSERT INTO purchase_orders (company, id, supplier, sku, qty, unit_cost, total, kind, status, proposed_at, reason) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [ctx.company, id, sup.id, sku, qty, unit, unit * qty, kind, 'proposed', ctx.clock, String(p.reason ?? '').slice(0, 200)]);
    await ctx.emit('PurchaseProposed', id, `Operations proposes ${id}: ${qty} × ${sku} from ${sup.id} (${kind}, ${money(unit * qty)})`, { po: id, sku, qty, supplier: sup.id, kind, total: unit * qty, reason: p.reason ?? '' });
    return { po: id };
  },

  async ReportShortage(ctx, p) {
    const sku = str(p.sku, 'sku');
    const open = await ctx.q.one("SELECT id FROM incidents WHERE company = ? AND kind = 'shortage' AND status = 'open' AND id LIKE ?", [ctx.company, `INC-shortage-${sku}-%`]);
    if (open) throw new Duplicate(`shortage for ${sku} already open`);
    const id = `INC-shortage-${sku}-${await ctx.nextId('inc')}`;
    await ctx.q.run('INSERT INTO incidents (company, id, kind, severity, status, opened_by, opened_at, summary, detail) VALUES (?,?,?,?,?,?,?,?,?)',
      [ctx.company, id, 'shortage', 'high', 'open', ctx.actor, ctx.clock, `Projected ${sku} shortfall of ${p.shortfall} units`, JSON.stringify(p.detail ?? {})]);
    await ctx.emit('ShortageDetected', sku, `Operations projects a ${sku} shortfall of ${p.shortfall} units`, { incident: id, sku, shortfall: p.shortfall, detail: p.detail ?? {} });
    return { incident: id };
  },

  async ResolveShortage(ctx, p) {
    const inc = await ctx.q.one<any>("SELECT * FROM incidents WHERE company = ? AND id = ?", [ctx.company, str(p.incident, 'incident')]);
    if (!inc) throw new NotFound('incident');
    if (inc.status !== 'open') throw new Duplicate('already resolved');
    await ctx.q.run("UPDATE incidents SET status = 'resolved', resolved_at = ?, resolved_by = ? WHERE company = ? AND id = ?", [ctx.clock, ctx.actor, ctx.company, inc.id]);
    await ctx.emit('ShortageResolved', String(p.sku), `Shortage closed: ${String(p.summary ?? '')}`, { incident: inc.id, sku: p.sku, summary: p.summary ?? '' });
  },

  // ---------------------------------------------------------------- Finance
  async CapturePayment(ctx, p) {
    const o = await order(ctx, str(p.order, 'order'));
    if (await ctx.q.one("SELECT 1 AS x FROM payments WHERE company = ? AND order_id = ? AND kind = 'capture'", [ctx.company, o.id])) throw new Duplicate(`payment for ${o.id} already captured`);
    if (o.status === 'cancelled') throw new Rejected(`order ${o.id} is cancelled`);
    await ctx.q.run('INSERT INTO payments (company, id, order_id, kind, amount, idem, at) VALUES (?,?,?,?,?,?,?)', [ctx.company, `PAY-${o.id}`, o.id, 'capture', o.total, `capture:${o.id}`, ctx.clock]);
    await ctx.q.run('UPDATE orders SET paid = ?, version = version + 1 WHERE company = ? AND id = ?', [o.total, ctx.company, o.id]);
    await ctx.post('order', o.id, 'capture', `Payment captured for ${o.id}`, [[A.CASH, o.total, 0], [A.DEPOSITS, 0, o.total]]);
    await ctx.emit('PaymentCaptured', o.id, `Captured ${money(o.total)} for ${o.id}: cash in, held as a customer deposit until shipment`, { order: o.id, amount: o.total });
  },

  async PostShipment(ctx, p) {
    const o = await order(ctx, str(p.order, 'order'));
    const s = await ctx.q.one<any>('SELECT * FROM shipments WHERE company = ? AND order_id = ?', [ctx.company, o.id]);
    if (!s || s.status === 'packed') throw new Rejected(`order ${o.id} has not shipped; revenue is recognised only on dispatch`);
    if (o.paid !== o.total) throw new Rejected(`order ${o.id} deposit missing`);
    await ctx.post('order', o.id, 'shipment', `Revenue recognised on dispatch of ${o.id}`, [
      [A.DEPOSITS, o.total, 0], [A.REVENUE, 0, o.total], [A.COGS, s.cost_value, 0], [A.INVENTORY, 0, s.cost_value], [A.SHIPPING, SHIPPING_COST, 0], [A.CASH, 0, SHIPPING_COST]].filter((l) => l[1] + l[2] > 0) as any);
    await ctx.q.run('INSERT INTO expenses (company, id, category, amount, ref, at) VALUES (?,?,?,?,?,?)', [ctx.company, `EX-ship-${o.id}`, 'shipping', SHIPPING_COST, o.id, ctx.clock]);
    await ctx.emit('RevenueRecognized', o.id, `Recognised ${money(o.total)} revenue and ${money(s.cost_value)} COGS for ${o.id}`, { order: o.id, revenue: o.total, cogs: s.cost_value, shipping: SHIPPING_COST });
  },

  async PostReceipt(ctx, p) {
    const po = await ctx.q.one<any>('SELECT * FROM purchase_orders WHERE company = ? AND id = ?', [ctx.company, str(p.po, 'po')]);
    if (!po || po.status !== 'received') throw new Rejected('goods not received');
    await ctx.post('po', po.id, 'receipt', `Goods received for ${po.id}`, [[A.INVENTORY, po.total, 0], [A.ADVANCES, 0, po.total]]);
    await ctx.emit('ReceiptPosted', po.id, `Moved ${money(po.total)} from supplier advances into inventory (${po.id})`, { po: po.id, value: po.total });
  },

  async RefundDeposit(ctx, p) {
    const o = await order(ctx, str(p.order, 'order'));
    if (o.status !== 'cancelled') throw new Rejected(`order ${o.id} is not cancelled`);
    if (o.paid <= 0) throw new Duplicate(`order ${o.id} holds no deposit`);
    if (await ctx.q.one("SELECT 1 AS x FROM journal_entries WHERE company = ? AND source_type = 'order' AND source_id = ? AND kind = 'deposit_refund'", [ctx.company, o.id])) {
      throw new Duplicate(`deposit for ${o.id} already settled`);
    }
    const credited = await creditsFor(ctx, o.id);
    const amount = o.paid - credited; // goodwill credits already paid out reduce the refundable balance
    const lines: [string, number, number][] = [[A.DEPOSITS, o.paid, 0]];
    if (amount > 0) {
      await ctx.q.run('INSERT INTO payments (company, id, order_id, kind, amount, idem, at) VALUES (?,?,?,?,?,?,?)', [ctx.company, `REF-${o.id}`, o.id, 'deposit_refund', amount, `deposit-refund:${o.id}`, ctx.clock]);
      lines.push([A.CASH, 0, amount]);
    }
    if (credited > 0) lines.push([A.REFUNDS, 0, credited]); // the credit was an advance on this refund: reclassify it
    // Credits can already have returned the whole deposit: then no cash moves, but the liability is still settled.
    await ctx.post('order', o.id, 'deposit_refund', amount > 0 ? `Deposit refunded for cancelled ${o.id}` : `Deposit for cancelled ${o.id} settled by earlier credits`, lines);
    await ctx.emit('DepositRefunded', o.id, amount > 0 ? `Refunded ${money(amount)} deposit for cancelled ${o.id}` : `Settled the deposit for cancelled ${o.id}: earlier credits already returned all ${money(o.paid)}`, { order: o.id, amount });
  },

  async IssueCredit(ctx, p, role) {
    const o = await order(ctx, str(p.order, 'order'));
    const amount = int(p.amount, 'amount', 1, 1_000_000); const reason = str(p.reason, 'reason');
    // An identical retry is a duplicate first, whatever the remaining balance.
    if (await ctx.q.one('SELECT 1 AS x FROM payments WHERE company = ? AND idem = ?', [ctx.company, `credit:${o.id}:${reason}`])) throw new Duplicate(`credit CR-${o.id}-${reason} already issued`);
    const already = await creditsFor(ctx, o.id);
    const refunded = (await ctx.q.one<any>("SELECT amount FROM payments WHERE company = ? AND order_id = ? AND kind = 'deposit_refund'", [ctx.company, o.id]))?.amount ?? 0;
    if (already + refunded + amount > o.paid) throw new Rejected(`credit would exceed what ${o.customer} paid for ${o.id} (${money(o.paid)})`);
    if (amount > POLICY.creditAutoCents) {
      await requireApproval(ctx, role, {
        kind: 'credit', params: { order: o.id, amount, reason }, bound: [['orders', o.id, o.version]],
        summary: `${money(amount)} credit to ${o.customer} on ${o.id} (${reason})`, evidence: { order_total: o.total, paid: o.paid, already_credited: already, status: o.status },
        threshold: `credits and refunds above ${money(POLICY.creditAutoCents)} need a human`, idem: `credit:${o.id}:${reason}`,
      }, p.approval_id);
    }
    const id = `CR-${o.id}-${reason}`;
    await ctx.q.run('INSERT INTO payments (company, id, order_id, kind, amount, idem, at, approval_id) VALUES (?,?,?,?,?,?,?,?)', [ctx.company, id, o.id, 'credit', amount, `credit:${o.id}:${reason}`, ctx.clock, p.approval_id ?? null]);
    await ctx.post('credit', id, 'credit', `Goodwill credit on ${o.id}: ${reason}`, [[A.REFUNDS, amount, 0], [A.CASH, 0, amount]]);
    await ctx.emit('CreditIssued', o.id, `Paid ${money(amount)} goodwill credit to ${o.customer} (${reason})`, { order: o.id, amount, reason });
  },

  async FundPurchase(ctx, p, role) {
    const po = await ctx.q.one<any>('SELECT * FROM purchase_orders WHERE company = ? AND id = ?', [ctx.company, str(p.po, 'po')]);
    if (!po) throw new NotFound('purchase order');
    if (po.status === 'funded' || po.status === 'arrived' || po.status === 'received') throw new Duplicate(`${po.id} already funded`);
    if (!['proposed', 'awaiting_approval'].includes(po.status)) throw new Rejected(`${po.id} is ${po.status}`);
    const cash = await ctx.balance(A.CASH);
    const after = cash - po.total;
    if (after < POLICY.cashFloorCents) throw new Rejected(`funding ${po.id} would leave ${money(after)}, below the ${money(POLICY.cashFloorCents)} hard floor`);
    const weekExpedite = Number((await ctx.q.one<any>("SELECT SUM(total) AS s FROM purchase_orders WHERE company = ? AND kind = 'expedite' AND status IN ('funded','arrived','received')", [ctx.company]))?.s ?? 0);
    const reasons: string[] = [], overrides: string[] = [];
    if (po.total > POLICY.purchaseAutoCents) { overrides.push('limit'); reasons.push(`over the ${money(POLICY.purchaseAutoCents)} purchase limit`); }
    if (after < POLICY.cashReserveCents) { overrides.push('reserve'); reasons.push(`leaves cash ${money(after)} below the ${money(POLICY.cashReserveCents)} operating reserve`); }
    if (po.kind === 'expedite' && weekExpedite + po.total > POLICY.expediteWeeklyCents) { overrides.push('expedite'); reasons.push(`exceeds the ${money(POLICY.expediteWeeklyCents)} weekly expedite budget`); }
    if (reasons.length) {
      // `overrides` is part of the hashed parameters: an approval to exceed the purchase limit is not an approval to
      // also dip below the reserve because other spending moved cash after the human decided.
      await requireApproval(ctx, role, {
        kind: 'purchase', params: { po: po.id, total: po.total, supplier: po.supplier, sku: po.sku, qty: po.qty, overrides: overrides.join('+') }, bound: [['purchase_orders', po.id, po.version]],
        summary: `fund ${po.id}: ${po.qty} × ${po.sku} from ${po.supplier} for ${money(po.total)}`,
        evidence: { cash_now: cash, cash_after: after, reserve: POLICY.cashReserveCents, expedite_spent_this_week: weekExpedite, kind: po.kind, reason: po.reason },
        threshold: reasons.join('; '), idem: `purchase:${po.id}:${overrides.join('+')}`,
      }, p.approval_id);
    }
    const sup = await ctx.q.one<any>('SELECT * FROM suppliers WHERE company = ? AND id = ?', [ctx.company, po.supplier]);
    const eta = ctx.clock + sup.lead_ticks + (sup.delay_sku === po.sku ? sup.delay_ticks : 0);
    await ctx.q.run("UPDATE purchase_orders SET status = 'funded', funded_at = ?, eta_tick = ?, approval_id = ?, version = version + 1 WHERE company = ? AND id = ?", [ctx.clock, eta, p.approval_id ?? null, ctx.company, po.id]);
    await ctx.post('po', po.id, 'funding', `Prepaid ${po.id} to ${po.supplier}`, [[A.ADVANCES, po.total, 0], [A.CASH, 0, po.total]]);
    await ctx.emit('PurchaseFunded', po.id, `Finance funded ${po.id} (${money(po.total)}); arrives Day ${dayOf(eta)}${p.approval_id ? ` under ${p.approval_id}` : ' within policy'}`,
      { po: po.id, sku: po.sku, qty: po.qty, total: po.total, eta_tick: eta, kind: po.kind, approval: p.approval_id ?? null });
  },

  async DeclinePurchase(ctx, p) {
    const po = await ctx.q.one<any>('SELECT * FROM purchase_orders WHERE company = ? AND id = ?', [ctx.company, str(p.po, 'po')]);
    if (!po) throw new NotFound('purchase order');
    if (po.status === 'declined') throw new Duplicate('already declined');
    if (!['proposed', 'awaiting_approval'].includes(po.status)) throw new Rejected(`${po.id} is ${po.status}`);
    await ctx.q.run("UPDATE purchase_orders SET status = 'declined', version = version + 1 WHERE company = ? AND id = ?", [ctx.company, po.id]);
    await ctx.emit('PurchaseDeclined', po.id, `Finance declined ${po.id}: ${String(p.reason ?? '')}`, { po: po.id, sku: po.sku, reason: p.reason ?? '' });
  },

  async PayAds(ctx, p, role) {
    const day = int(p.day, 'day', 1, 100); const amount = int(p.amount, 'amount', 1, 1_000_000);
    // Normalised once: the products that are hashed into an approval are exactly the products stored and advertised.
    const skus: string[] = Array.isArray(p.skus) ? p.skus.slice(0, 4).map(String) : [];
    if (await spendFrozen(ctx)) throw new Rejected('discretionary spend is frozen');
    if (amount > POLICY.adsDailyAutoCents) {
      // The approval binds which products the campaign advertises, so the human approves exactly what will run and a
      // continuation rebuilt after a crash runs that same campaign. The request key includes the campaign itself, so a
      // different campaign for the same day files its own request instead of matching this one.
      await requireApproval(ctx, role, { kind: 'ads', params: { day, amount, skus }, bound: [], summary: `${money(amount)} advertising for Day ${day} (${skus.join(', ') || 'all products'})`, evidence: {},
        threshold: `ad spend above ${money(POLICY.adsDailyAutoCents)}/day needs a human`, idem: `ads:${day}:${amount}:${skus.join('+')}` }, p.approval_id);
    }
    if (await ctx.q.one("SELECT 1 AS x FROM expenses WHERE company = ? AND id = ?", [ctx.company, `EX-ads-${day}`])) throw new Duplicate(`ads for day ${day} already paid`);
    await ctx.q.run('INSERT INTO expenses (company, id, category, amount, ref, at) VALUES (?,?,?,?,?,?)', [ctx.company, `EX-ads-${day}`, 'advertising', amount, JSON.stringify(skus), ctx.clock]);
    await ctx.post('ads', String(day), 'ads', `Advertising for Day ${day}`, [[A.ADS, amount, 0], [A.CASH, 0, amount]]);
    await ctx.emit('AdSpendPaid', `ads:${day}`, `Finance paid ${money(amount)} of advertising for Day ${day}`, { day, amount, skus });
  },

  async PayStaff(ctx, p) {
    const day = int(p.day, 'day', 1, 100); const amount = int(p.amount, 'amount', 1, 1_000_000);
    await ctx.q.run('INSERT INTO expenses (company, id, category, amount, ref, at) VALUES (?,?,?,?,?,?)', [ctx.company, `EX-staff-${day}`, 'staff', amount, `day ${day}`, ctx.clock]);
    await ctx.post('staff', String(day), 'staff', `Staff cost for Day ${day}`, [[A.STAFF, amount, 0], [A.CASH, 0, amount]]);
    await ctx.emit('StaffPaid', `staff:${day}`, `Finance paid ${money(amount)} staff cost for Day ${day}`, { day, amount });
  },

  async OpenIncident(ctx, p) {
    const kind = str(p.kind, 'kind');
    const open = await ctx.q.one("SELECT id FROM incidents WHERE company = ? AND kind = ? AND status = 'open'", [ctx.company, kind]);
    if (open) throw new Duplicate(`${kind} incident already open`);
    const id = `INC-${kind}-${await ctx.nextId('inc')}`;
    await ctx.q.run('INSERT INTO incidents (company, id, kind, severity, status, opened_by, opened_at, summary, detail, human_needed) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [ctx.company, id, kind, String(p.severity ?? 'high'), 'open', ctx.actor, ctx.clock, String(p.summary ?? ''), JSON.stringify(p.detail ?? {}), p.human_needed ? 1 : 0]);
    await ctx.emit('IncidentOpened', id, `${ctx.actor} opened ${id}: ${String(p.summary ?? '')}`, { incident: id, kind, detail: p.detail ?? {} });
    if (kind === 'ops-stalled') await ctx.emit('CapacityLost', 'operations', 'Fulfilment capacity is zero until Operations recovers: stop near-date promises', { incident: id, ...(p.detail ?? {}) });
    return { incident: id };
  },

  async ResolveIncident(ctx, p) {
    const inc = await ctx.q.one<any>('SELECT * FROM incidents WHERE company = ? AND id = ?', [ctx.company, str(p.incident, 'incident')]);
    if (!inc) throw new NotFound('incident');
    if (inc.status !== 'open') throw new Duplicate('already resolved');
    await ctx.q.run("UPDATE incidents SET status = 'resolved', resolved_at = ?, resolved_by = ? WHERE company = ? AND id = ?", [ctx.clock, ctx.actor, ctx.company, inc.id]);
    await ctx.emit('IncidentResolved', inc.id, `${inc.id} resolved: ${String(p.summary ?? '')}`, { incident: inc.id, summary: p.summary ?? '' });
    if (inc.kind === 'ops-stalled') await ctx.emit('CapacityRestored', 'operations', 'Operations is shipping again: normal promises resume', { incident: inc.id });
  },

  async SetSpendFreeze(ctx, p) {
    const w = await world(ctx); const on = !!p.on;
    if (!!w.freeze === on) throw new Duplicate('freeze already in that state');
    w.freeze = on ? { reason: String(p.reason ?? ''), since: ctx.clock } : null;
    await setWorld(ctx, w);
    await ctx.emit('SpendFreezeChanged', on ? 'freeze' : 'unfreeze', on ? `Finance froze discretionary spend: ${String(p.reason ?? '')}` : 'Finance lifted the spend freeze', { on, reason: p.reason ?? '' });
  },

  async RecoverAgent(ctx, p, role) {
    const target = str(p.role, 'role') as Role;
    const a = await ctx.q.one<any>('SELECT * FROM agents WHERE company = ? AND role = ?', [ctx.company, target]);
    if (!a) throw new NotFound('agent');
    if (a.status !== 'faulted') throw new Duplicate(`${target} is ${a.status}`);
    await requireApproval(ctx, role, {
      kind: 'recover-agent', params: { role: target }, bound: [['agents', target, a.version]],
      summary: `restart ${target} and let it reconcile its queued and half-finished work`, evidence: { fault: a.fault_reason },
      threshold: 'restarting a failed agent always needs a human', idem: `recover:${target}:${a.version}:${ctx.clock}`,
    }, p.approval_id);
    const mem = JSON.parse(a.memory); mem.recovering = true;
    await ctx.q.run("UPDATE agents SET status = 'running', fault_mode = '', memory = ?, version = version + 1 WHERE company = ? AND role = ?", [JSON.stringify(mem), ctx.company, target]);
    await ctx.emit('AgentRecovered', target, `${target} restarted under ${p.approval_id}; it will reconcile before taking new work`, { role: target, approval: p.approval_id });
  },

  async ReportRecovery(ctx, p) {
    const r = { packed_found: int(p.packed_found, 'packed_found', 0, 10_000), dispatched: int(p.dispatched, 'dispatched', 0, 10_000), inbox_backlog: int(p.inbox_backlog, 'inbox_backlog', 0, 100_000) };
    await ctx.emit('RecoveryReconciled', 'operations', `Operations reconciled after restart: ${r.packed_found} half-finished shipments found, ${r.dispatched} dispatched exactly once, ${r.inbox_backlog} queued tasks to drain`, r);
  },

  async CloseDay(ctx, p) {
    const day = int(p.day, 'day', 1, 100);
    if (await ctx.q.one('SELECT 1 AS x FROM snapshots WHERE company = ? AND day = ?', [ctx.company, day])) throw new Duplicate(`day ${day} already closed`);
    // Computed inside the closing transaction, so the snapshot is exactly the committed state at this seq.
    const kpis = await computeKpis(ctx.q, ctx.company);
    const checks = await reconcile(ctx.q, ctx.company);
    const checksum = stateChecksum(await liveState(ctx.q, ctx.company));
    const failed = checks.filter((c) => !c.ok).map((c) => c.name);
    await ctx.emit('DayClosed', `day:${day}`, `Finance closed Day ${day}: ${failed.length ? `FAILED ${failed.join(', ')}` : `all ${checks.length} reconciliation checks pass`}`, { day, checks, checksum });
    const seq = ctx.seqs.at(-1)!;
    await ctx.q.run('INSERT INTO snapshots (company, day, seq, kpis, checks, checksum) VALUES (?,?,?,?,?,?)', [ctx.company, day, seq, JSON.stringify(kpis), JSON.stringify(checks), checksum]);
  },
};

async function creditsFor(ctx: Ctx, orderId: string) {
  return Number((await ctx.q.one<any>("SELECT SUM(amount) AS s FROM payments WHERE company = ? AND order_id = ? AND kind = 'credit'", [ctx.company, orderId]))?.s ?? 0);
}
