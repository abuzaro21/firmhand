// KPIs and reconciliation, computed only from records and journal lines. Nothing here is stored or animated: every
// figure is a query, and every reconciliation check compares the ledger against operational records it does not own.
import type { Q } from './db.ts';
import { ACCOUNTS as A, OPENING_CASH, PRODUCTS, canon, sha256 } from './model.ts';

export type Kpis = Awaited<ReturnType<typeof computeKpis>>;

export async function balances(q: Q, company: string): Promise<Record<string, number>> {
  const rows = await q.all<{ account: string; d: number; c: number }>('SELECT account, SUM(debit) AS d, SUM(credit) AS c FROM journal_lines WHERE company = ? GROUP BY account', [company]);
  const out: Record<string, number> = {};
  for (const r of rows) out[r.account] = Number(r.d) - Number(r.c); // debit-positive
  return out;
}

export async function computeKpis(q: Q, company: string) {
  const b = await balances(q, company);
  const g = (k: string) => b[k] ?? 0;
  const c = (await q.one<{ clock: number }>('SELECT clock FROM companies WHERE id = ?', [company]))!.clock;
  const n = async (sql: string, p: unknown[] = []) => Number((await q.one<any>(sql, [company, ...p]))?.v ?? 0);
  const revenue = -g(A.REVENUE); const refunds = g(A.REFUNDS); const cogs = g(A.COGS);
  const netRevenue = revenue - refunds; const grossProfit = netRevenue - cogs;
  const shipping = g(A.SHIPPING); const ads = g(A.ADS); const staff = g(A.STAFF);
  const stock = await q.all<any>('SELECT sku, on_hand, reserved, value_cents FROM inventory WHERE company = ? ORDER BY sku', [company]);
  return {
    clock: c,
    bookedValue: await n('SELECT SUM(total) AS v FROM orders WHERE company = ?'),
    ordersBooked: await n('SELECT COUNT(*) AS v FROM orders WHERE company = ?'),
    cancelledValue: await n("SELECT SUM(total) AS v FROM orders WHERE company = ? AND status = 'cancelled'"),
    recognizedRevenue: revenue, refundsAndCredits: refunds, netRevenue, cogs, grossProfit,
    grossMarginPct: netRevenue > 0 ? Math.round((grossProfit / netRevenue) * 1000) / 10 : 0,
    shipping, advertising: ads, staff, operatingCosts: shipping + ads + staff, netIncome: grossProfit - shipping - ads - staff,
    cash: g(A.CASH), cashCollected: await n("SELECT SUM(amount) AS v FROM payments WHERE company = ? AND kind = 'capture'"),
    customerDeposits: -g(A.DEPOSITS), supplierAdvances: g(A.ADVANCES), inventoryValue: g(A.INVENTORY),
    backlogOrders: await n("SELECT COUNT(*) AS v FROM orders WHERE company = ? AND status IN ('placed','reserved','backordered','packed')"),
    backlogValue: await n("SELECT SUM(total) AS v FROM orders WHERE company = ? AND status IN ('placed','reserved','backordered','packed')"),
    backordered: await n("SELECT COUNT(*) AS v FROM orders WHERE company = ? AND status = 'backordered'"),
    fulfilled: await n("SELECT COUNT(*) AS v FROM orders WHERE company = ? AND status IN ('shipped','delivered')"),
    avgFulfilHours: Math.round(Number((await q.one<any>("SELECT AVG(shipped_at - placed_at) AS v FROM orders WHERE company = ? AND shipped_at IS NOT NULL", [company]))?.v ?? 0) * 10) / 10,
    /** A promise is broken when dispatch happens after the promised hour, or the hour passed with the order unshipped. */
    brokenPromises: await n("SELECT COUNT(*) AS v FROM orders WHERE company = ? AND status <> 'cancelled' AND ((shipped_at IS NOT NULL AND shipped_at > promised_tick) OR (shipped_at IS NULL AND ? > promised_tick))", [c]),
    /** Stricter: measured against the date first promised, so renegotiating a date never hides a slip. */
    lateVsOriginal: await n("SELECT COUNT(*) AS v FROM orders WHERE company = ? AND status <> 'cancelled' AND ((shipped_at IS NOT NULL AND shipped_at > original_promise) OR (shipped_at IS NULL AND ? > original_promise))", [c]),
    renegotiated: await n('SELECT COUNT(*) AS v FROM orders WHERE company = ? AND notified = 1'),
    lateCancellations: await n("SELECT COUNT(*) AS v FROM orders WHERE company = ? AND status = 'cancelled' AND cancel_requested = 1"),
    customersActive: await n("SELECT COUNT(*) AS v FROM customers WHERE company = ? AND status = 'active'"),
    customersAtRisk: await n("SELECT COUNT(*) AS v FROM customers WHERE company = ? AND status = 'at_risk'"),
    customersChurned: await n("SELECT COUNT(*) AS v FROM customers WHERE company = ? AND status = 'churned'"),
    customersTotal: await n('SELECT COUNT(*) AS v FROM customers WHERE company = ?'),
    unitsAvailable: Object.fromEntries(stock.map((s) => [s.sku, s.on_hand - s.reserved])),
    unitsOnHand: Object.fromEntries(stock.map((s) => [s.sku, s.on_hand])),
    pendingApprovals: await n("SELECT COUNT(*) AS v FROM approvals WHERE company = ? AND status = 'pending'"),
    openIncidents: await n("SELECT COUNT(*) AS v FROM incidents WHERE company = ? AND status = 'open'"),
    unpostedForFinance: await n("SELECT COUNT(*) AS v FROM agent_tasks WHERE company = ? AND role = 'finance' AND status = 'queued'"),
  };
}

export type Check = { name: string; ok: boolean; ledger: number | string; records: number | string; note: string };

/** Reconciliation: each check compares a ledger balance with a figure rebuilt from operational records. */
export async function reconcile(q: Q, company: string): Promise<Check[]> {
  const b = await balances(q, company); const g = (k: string) => b[k] ?? 0;
  const n = async (sql: string) => Number((await q.one<any>(sql, [company]))?.v ?? 0);
  const out: Check[] = [];
  const add = (name: string, ledger: number, records: number, note: string) => out.push({ name, ok: ledger === records, ledger, records, note });

  const tb = await q.one<any>('SELECT SUM(debit) AS d, SUM(credit) AS c FROM journal_lines WHERE company = ?', [company]);
  add('trial-balance', Number(tb?.d ?? 0), Number(tb?.c ?? 0), 'total debits equal total credits');

  const cashRecords = OPENING_CASH
    + await n("SELECT SUM(amount) AS v FROM payments WHERE company = ? AND kind = 'capture'")
    - await n("SELECT SUM(amount) AS v FROM payments WHERE company = ? AND kind IN ('deposit_refund','credit')")
    - await n('SELECT SUM(amount) AS v FROM expenses WHERE company = ?')
    - await n("SELECT SUM(total) AS v FROM purchase_orders WHERE company = ? AND status IN ('funded','arrived','received')");
  add('cash', g(A.CASH), cashRecords, 'opening + captures − refunds − credits − expenses − prepaid purchases');

  const invRecords = await n('SELECT SUM(value_cents) AS v FROM inventory WHERE company = ?')
    + await n("SELECT SUM(s.cost_value) AS v FROM shipments s WHERE s.company = ? AND NOT EXISTS (SELECT 1 FROM journal_entries j WHERE j.company = s.company AND j.source_type = 'order' AND j.source_id = s.order_id AND j.kind = 'shipment')")
    - await n("SELECT SUM(p.total) AS v FROM purchase_orders p WHERE p.company = ? AND p.status = 'received' AND NOT EXISTS (SELECT 1 FROM journal_entries j WHERE j.company = p.company AND j.source_type = 'po' AND j.source_id = p.id AND j.kind = 'receipt')");
  add('inventory', g(A.INVENTORY), invRecords, 'shelf value + packed/shipped cost not yet expensed − received goods not yet posted');

  const depRecords = await n(`SELECT SUM(o.paid) AS v FROM orders o WHERE o.company = ? AND (
      o.status IN ('placed','reserved','backordered','packed')
      OR (o.status IN ('shipped','delivered') AND NOT EXISTS (SELECT 1 FROM journal_entries j WHERE j.company = o.company AND j.source_type = 'order' AND j.source_id = o.id AND j.kind = 'shipment'))
      OR (o.status = 'cancelled' AND NOT EXISTS (SELECT 1 FROM journal_entries j WHERE j.company = o.company AND j.source_type = 'order' AND j.source_id = o.id AND j.kind = 'deposit_refund')))`);
  add('customer-deposits', -g(A.DEPOSITS), depRecords, 'money held for paid orders that have not shipped (or not yet been refunded)');

  const advRecords = await n("SELECT SUM(total) AS v FROM purchase_orders WHERE company = ? AND status IN ('funded','arrived')")
    + await n("SELECT SUM(p.total) AS v FROM purchase_orders p WHERE p.company = ? AND p.status = 'received' AND NOT EXISTS (SELECT 1 FROM journal_entries j WHERE j.company = p.company AND j.source_type = 'po' AND j.source_id = p.id AND j.kind = 'receipt')");
  add('supplier-advances', g(A.ADVANCES), advRecords, 'prepaid purchase orders whose goods are not yet in inventory');

  const revRecords = await n("SELECT SUM(o.total) AS v FROM orders o WHERE o.company = ? AND EXISTS (SELECT 1 FROM journal_entries j WHERE j.company = o.company AND j.source_type = 'order' AND j.source_id = o.id AND j.kind = 'shipment')");
  add('revenue', -g(A.REVENUE), revRecords, 'revenue equals the value of orders whose dispatch has been posted (never bookings)');
  const shippedNotDispatched = await n("SELECT COUNT(*) AS v FROM orders o JOIN shipments s ON s.company = o.company AND s.order_id = o.id WHERE o.company = ? AND o.status IN ('shipped','delivered') AND s.status = 'packed'");
  add('shipment-integrity', shippedNotDispatched, 0, 'every shipped order has exactly one dispatched shipment');
  const unposted = await n("SELECT COUNT(*) AS v FROM shipments s WHERE s.company = ? AND s.status IN ('dispatched','delivered') AND NOT EXISTS (SELECT 1 FROM journal_entries j WHERE j.company = s.company AND j.source_type = 'order' AND j.source_id = s.order_id AND j.kind = 'shipment')");
  add('shipments-posted', unposted, 0, 'every parcel that left the warehouse has its revenue and cost posted');

  const resv = await q.all<any>(`SELECT i.sku, i.reserved AS r, COALESCE((SELECT SUM(qty) FROM reservations x WHERE x.company = i.company AND x.sku = i.sku AND x.status = 'active'), 0) AS a
    FROM inventory i WHERE i.company = ?`, [company]);
  const bad = resv.filter((r) => Number(r.r) !== Number(r.a)).length;
  add('reservations', bad, 0, 'reserved stock per SKU equals the sum of active reservations');
  return out;
}

/** A digest of the business state that replay must reproduce: account balances, stock, order and customer status. */
export async function liveState(q: Q, company: string) {
  const b = await balances(q, company);
  const stock = await q.all<any>('SELECT sku, on_hand, reserved, value_cents FROM inventory WHERE company = ? ORDER BY sku', [company]);
  const orders = await q.all<any>('SELECT id, status FROM orders WHERE company = ? ORDER BY id', [company]);
  const customers = await q.all<any>("SELECT id, status FROM customers WHERE company = ? ORDER BY id", [company]);
  return normaliseState({
    accounts: b,
    stock: Object.fromEntries(stock.map((s) => [s.sku, [Number(s.on_hand), Number(s.reserved), Number(s.value_cents)]])),
    orders: Object.fromEntries(orders.map((o) => [o.id, o.status])),
    customers: Object.fromEntries(customers.map((c) => [c.id, c.status])),
  });
}
export type State = { accounts: Record<string, number>; stock: Record<string, [number, number, number]>; orders: Record<string, string>; customers: Record<string, string> };
export function normaliseState(s: State): State {
  const accounts: Record<string, number> = {};
  for (const k of Object.keys(s.accounts).sort()) if (s.accounts[k] !== 0) accounts[k] = s.accounts[k];
  return { accounts, stock: s.stock, orders: s.orders, customers: s.customers };
}
export const checksum = (s: State) => sha256(canon(s)).slice(0, 16);
export const productSkus = PRODUCTS.map((p) => p.sku);
