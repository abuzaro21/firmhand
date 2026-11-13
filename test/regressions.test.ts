// Regressions for the defects found by the independent Codex review (docs/reviews). Each test reproduces the reported
// failure first in its comment, then asserts the corrected behaviour.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { Engine } from '../src/engine.ts';
import { createApp } from '../src/server.ts';
import { reconcile } from '../src/kpi.ts';
import { Ctx } from '../src/kernel.ts';
import { promiseFor } from '../src/agents/sales.ts';
import { ACCOUNTS as A, POLICY } from '../src/model.ts';
import type { Db } from '../src/db.ts';
import { company, dropSchemas, newDb, placedOrder, q1, qa, run, runWeek } from './helpers.ts';

after(dropSchemas);
const n = async (p: Promise<any>) => Number((await p).n);

/** Simulate a process kill: the first write matching `pred` throws inside its transaction, which rolls back. */
function killAt(db: Db, pred: (sql: string, params: unknown[]) => boolean) {
  const orig = db.tx.bind(db);
  let armed = true;
  (db as any).tx = (co: string | null, fn: (q: any) => Promise<any>) => orig(co, (q: any) => fn(new Proxy(q, {
    get(target, key) {
      const v = target[key];
      if (key === 'run') return async (sql: string, params: unknown[] = []) => {
        if (armed && pred(sql, params)) { armed = false; throw new Error('simulated process kill'); }
        return v.call(target, sql, params);
      };
      return typeof v === 'function' ? v.bind(target) : v;
    },
  })));
  return () => { (db as any).tx = orig; };
}
const drainCash = (db: Db, id: string, amount: number, back = false) => db.tx(id, async (q) => {
  const ctx = new Ctx(q, id, 0, 'finance', 7);
  await ctx.post('test', `drain-${randomBytes(3).toString('hex')}`, 'test', 'test harness cash adjustment', back ? [[A.CASH, amount, 0], [A.ADS, 0, amount]] : [[A.ADS, amount, 0], [A.CASH, 0, amount]]);
});
const cashOf = async (db: Db, id: string) => Number((await q1(db, 'SELECT COALESCE(SUM(debit) - SUM(credit), 0) AS v FROM journal_lines WHERE company = ? AND account = ?', [id, A.CASH])).v);

test('R1-1/R3-1: a kill after the world phase commits but before its checkpoint cannot freeze the company', async () => {
  // Before the fix the world transaction and the phase marker were separate commits: a restart replayed the world
  // phase and threw "Duplicate event day-start:1" forever.
  const { db, e, id } = await company({ seed: 7 });
  const restore = killAt(db, (sql) => sql.startsWith('UPDATE companies SET phase'));
  await assert.rejects(e.tick(id), /simulated process kill/);
  restore();
  const mid = await q1(db, 'SELECT clock, phase FROM companies WHERE id = ?', [id]);
  assert.deepEqual([mid.clock, mid.phase], [0, 0], 'the world phase rolled back with its checkpoint');
  const e2 = new Engine(db); // a new process
  await e2.run(id, 3);
  assert.equal((await q1(db, 'SELECT clock FROM companies WHERE id = ?', [id])).clock, 3);
  assert.equal(await n(q1(db, "SELECT COUNT(*) AS n FROM events WHERE company = ? AND type = 'DayStarted'", [id])), 1);
  await db.close();
});

test('R1-2/R3-2: a parcel packed by a turn that died is dispatched by the next running Operations turn', async () => {
  // Before the fix Operations dispatched only parcels packed in the same turn; an interrupted pack stayed stranded.
  const { db, e, id } = await company({ storyline: false });
  const o = await placedOrder(db, id, 'KETTLE', 1);
  await run(db, id, 'finance', 'CapturePayment', { order: o.order });
  await run(db, id, 'operations', 'ReserveStock', { order: o.order });
  assert.equal((await run(db, id, 'operations', 'Pack', { order: o.order })).outcome, 'committed');
  assert.equal((await q1(db, "SELECT status FROM agents WHERE company = ? AND role = 'operations'", [id])).status, 'running', 'no fault was recorded');
  await e.tick(id);
  assert.equal((await q1(db, 'SELECT status FROM shipments WHERE company = ? AND order_id = ?', [id, o.order])).status, 'dispatched');
  assert.equal(await n(q1(db, "SELECT COUNT(*) AS n FROM journal_entries WHERE company = ? AND source_id = ? AND kind = 'shipment'", [id, o.order])), 1);
  await db.close();
});

test('R1-3/R3-3: an escalation that committed before a crash keeps its continuation', async () => {
  // Before the fix the redelivered request returned `duplicate`, memory was never rebuilt, and the approved lead was
  // never quoted.
  const { db, e, id } = await company({ seed: 7 });
  await e.run(id, 10); // the big-discount lead arrives at 10
  const restore = killAt(db, (sql, p) => sql.startsWith('UPDATE agents SET memory') && p.includes('sales'));
  await assert.rejects(e.tick(id), /simulated process kill/);
  restore();
  const ap = await q1(db, "SELECT * FROM approvals WHERE company = ? AND kind = 'discount' AND status = 'pending'", [id]);
  assert.ok(ap, 'the escalation itself committed');
  const mem0 = JSON.parse((await q1(db, "SELECT memory FROM agents WHERE company = ? AND role = 'sales'", [id])).memory);
  assert.ok(!mem0.pending?.[ap.id], 'the crash lost the continuation');
  const e2 = new Engine(db);
  await e2.tick(id); // resumes the hour: Sales's tasks are redelivered
  const mem = JSON.parse((await q1(db, "SELECT memory FROM agents WHERE company = ? AND role = 'sales'", [id])).memory);
  assert.ok(mem.pending[ap.id], 'rebuilt from the durable approval');
  assert.equal(await n(q1(db, "SELECT COUNT(*) AS n FROM approvals WHERE company = ? AND kind = 'discount'", [id])), 1, 'no second request');
  await e2.decide(id, ap.id, true, ap.hash);
  await e2.run(id, 2);
  assert.equal((await q1(db, 'SELECT status FROM approvals WHERE company = ? AND id = ?', [id, ap.id])).status, 'executed');
  const params = JSON.parse(ap.params);
  assert.ok(await q1(db, 'SELECT 1 AS x FROM quotes WHERE company = ? AND lead = ?', [id, params.lead]), 'the lead was quoted');
  await db.close();
});

test('R2-2: an approval that expires before use falls back to what Sales may do alone', async () => {
  // Before the fix Sales deleted its memory, execution was rejected, and the lead stayed `new` forever.
  const { db, e, id } = await company({ seed: 7 });
  await e.run(id, 11);
  const ap = await q1(db, "SELECT * FROM approvals WHERE company = ? AND kind = 'discount' AND status = 'pending'", [id]);
  const lead = JSON.parse(ap.params).lead;
  await e.setPaused(id, 'sales', true);
  await e.decide(id, ap.id, true, ap.hash);
  await e.run(id, POLICY.approvalTtlTicks + 2);
  await e.setPaused(id, 'sales', false);
  await e.tick(id);
  const quote = await q1(db, 'SELECT discount_bp FROM quotes WHERE company = ? AND lead = ?', [id, lead]);
  assert.ok(quote, 'the customer got a quote');
  assert.equal(Number(quote.discount_bp), POLICY.discountAutoBp, 'at the most Sales may give on its own authority');
  assert.notEqual((await q1(db, 'SELECT status FROM approvals WHERE company = ? AND id = ?', [id, ap.id])).status, 'executed');
  await db.close();
});

test('R1-4: a dispatched parcel whose posting is refused is retried until it is posted', async () => {
  // Before the fix Finance acknowledged the refused PostShipment task and the parcel was never recognised.
  const { db, e, id } = await company({ storyline: false });
  const o = await placedOrder(db, id, 'KETTLE', 1);
  await run(db, id, 'finance', 'CapturePayment', { order: o.order });
  await run(db, id, 'operations', 'ReserveStock', { order: o.order });
  await run(db, id, 'operations', 'Pack', { order: o.order });
  await run(db, id, 'operations', 'Dispatch', { order: o.order });
  const cash = await cashOf(db, id);
  await drainCash(db, id, cash); // no cash for the shipping charge: the posting is refused as an overdraft
  await e.tick(id);
  assert.equal(await n(q1(db, "SELECT COUNT(*) AS n FROM journal_entries WHERE company = ? AND source_id = ? AND kind = 'shipment'", [id, o.order])), 0);
  const task = await q1(db, "SELECT t.status FROM agent_tasks t JOIN events v ON v.company = t.company AND v.seq = t.source_seq WHERE t.company = ? AND t.role = 'finance' AND v.type = 'ShipmentDispatched' AND v.subject = ?", [id, o.order]);
  assert.equal(task.status, 'queued', 'the task stays queued');
  const check = (await db.tx(null, (q) => reconcile(q, id))).find((c) => c.name === 'shipments-posted')!;
  assert.equal(check.ok, false, 'the close would report the unposted parcel');
  await drainCash(db, id, cash, true);
  await e.tick(id);
  assert.equal(await n(q1(db, "SELECT COUNT(*) AS n FROM journal_entries WHERE company = ? AND source_id = ? AND kind = 'shipment'", [id, o.order])), 1);
  assert.ok((await db.tx(null, (q) => reconcile(q, id))).find((c) => c.name === 'shipments-posted')!.ok);
  await db.close();
});

test('R1-5: cancelling an order whose deposit was fully credited settles the deposit with no cash movement', async () => {
  // Before the fix RefundDeposit returned "nothing left to refund" and the liability stayed on the books forever.
  const { db, id } = await company({ storyline: false });
  const o = await placedOrder(db, id, 'FILTERS', 1); // $12.00
  await run(db, id, 'finance', 'CapturePayment', { order: o.order });
  assert.equal((await run(db, id, 'finance', 'IssueCredit', { order: o.order, amount: 1200, reason: 'a' })).outcome, 'committed');
  assert.equal((await run(db, id, 'sales', 'CancelOrder', { order: o.order, reason: 'test' })).outcome, 'committed');
  const cash = await cashOf(db, id);
  assert.equal((await run(db, id, 'finance', 'RefundDeposit', { order: o.order })).outcome, 'committed');
  assert.equal(await cashOf(db, id), cash, 'no cash moved');
  assert.equal((await run(db, id, 'finance', 'RefundDeposit', { order: o.order })).outcome, 'duplicate');
  const checks = await db.tx(null, (q) => reconcile(q, id));
  assert.ok(checks.every((c) => c.ok), JSON.stringify(checks.filter((c) => !c.ok)));
  await db.close();
});

test('R2-1: an approval to exceed the purchase limit does not also authorise breaching the reserve', async () => {
  // Before the fix a $1,860 purchase approved at $14,000 cash still executed after cash fell, leaving cash below the
  // $3,000 reserve without anyone approving that.
  const { db, e, id } = await company({ storyline: false });
  const po = (await run(db, id, 'operations', 'ProposePurchase', { sku: 'GRINDER', qty: 30, supplier: 'NORTHGATE' })).result.po;
  assert.equal((await run(db, id, 'finance', 'FundPurchase', { po })).outcome, 'escalated');
  const ap = await q1(db, "SELECT * FROM approvals WHERE company = ? AND kind = 'purchase' AND status = 'pending'", [id]);
  assert.equal(JSON.parse(ap.params).overrides, 'limit');
  await e.decide(id, ap.id, true, ap.hash);
  await drainCash(db, id, (await cashOf(db, id)) - 400_000); // other spending: $4,000 left, $2,140 after this PO
  const r = await run(db, id, 'finance', 'FundPurchase', { po, approval_id: ap.id });
  assert.equal(r.outcome, 'rejected');
  assert.notEqual((await q1(db, 'SELECT status FROM purchase_orders WHERE company = ? AND id = ?', [id, po])).status, 'funded', 'nothing was spent');
  const again = await run(db, id, 'finance', 'FundPurchase', { po });
  assert.equal(again.outcome, 'escalated', 'a fresh request for what is now needed');
  const ap2 = await q1(db, 'SELECT * FROM approvals WHERE company = ? AND id = ?', [id, again.approval]);
  assert.equal(JSON.parse(ap2.params).overrides, 'limit+reserve');
  await db.close();
});

test('R3-4: promises against inbound stock respect the orders already waiting for it', async () => {
  const { db, id } = await company({ storyline: false });
  await db.tx(id, (q) => q.run("UPDATE inventory SET on_hand = 0, reserved = 0, value_cents = 0 WHERE company = ? AND sku = 'GRINDER'", [id]));
  for (let i = 0; i < 5; i++) await placedOrder(db, id, 'GRINDER', 1, `R-${String(i + 1).padStart(2, '0')}`);
  const po = (await run(db, id, 'operations', 'ProposePurchase', { sku: 'GRINDER', qty: 5, supplier: 'NORTHGATE' })).result.po;
  assert.equal((await run(db, id, 'finance', 'FundPurchase', { po })).outcome, 'committed');
  const t: any = { company: id, clock: 0, policies: { selfCorrect: true }, mem: {}, read: (fn: any) => db.tx(null, fn) };
  // Five waiting units, five inbound: a new two-unit order is NOT covered (before the fix: "covered by inbound stock").
  assert.match((await promiseFor(t, 'GRINDER', 2)).basis, /no inbound cover/);
  // Re-promising one of the five waiting orders: its own unit is not counted against itself, so it is covered.
  assert.match((await promiseFor(t, 'GRINDER', 1, 1)).basis, /covered by inbound/);
  await db.close();
});

test('R4-2/R4-5: every KPI drawer returns exactly the records its tile counts', async () => {
  const { db, e, id } = await company({ seed: 11 });
  await runWeek(e, id);
  const k: Record<string, number> = (await e.state(id)).kpis as any;
  for (const key of ['lateVsOriginal', 'brokenPromises', 'renegotiated', 'customersChurned', 'customersAtRisk', 'customersActive', 'backordered', 'fulfilled']) {
    const s = await e.sources(id, key);
    assert.equal(s.rows.length, Math.min(400, k[key]), `${key}: tile ${k[key]} vs drawer ${s.rows.length}`);
  }
  assert.ok((await e.sources(id, 'customersChurned')).rows.every((r: any) => r.status === 'churned'));
  await db.close();
});

// ---------------------------------------------------------------- HTTP admission and verification
const pub = join(tmpdir(), `firmhand-pub-${randomBytes(4).toString('hex')}`);
mkdirSync(pub, { recursive: true }); writeFileSync(join(pub, 'index.html'), '<!doctype html><title>t</title>');
async function server(opts: Record<string, unknown>) {
  const db = await newDb();
  const e = new Engine(db);
  const { server } = createApp({ engine: e, publicDir: pub, rateLimit: 1000, ticksPerMinute: 1000, ...opts } as any);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = async (method: string, path: string, cookie = '', body: unknown = {}) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', cookie }, body: method === 'POST' ? JSON.stringify(body) : undefined });
    return { status: r.status, cookie: r.headers.get('set-cookie')?.split(';')[0] ?? '', json: await r.json().catch(() => null) };
  };
  return { e, db, call, close: async () => { server.close(); await db.close(); } };
}

test('R2-3: concurrent session requests cannot exceed the company cap', async () => {
  const s = await server({ maxCompanies: 1, companiesPerMinute: 50 });
  const rs = await Promise.all(Array.from({ length: 8 }, () => s.call('POST', '/api/session')));
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 503, 503, 503, 503, 503, 503, 503]);
  assert.equal(await s.e.count(), 1);
  await s.close();
});

test('R2-4: a rate-limited reset keeps the visitor\'s existing company', async () => {
  const s = await server({ companiesPerMinute: 1 });
  const first = await s.call('POST', '/api/session');
  assert.equal(first.status, 200);
  assert.equal((await s.call('POST', '/api/reset', first.cookie)).status, 429);
  assert.equal((await s.call('GET', '/api/state', first.cookie)).status, 200, 'the company survived the refused reset');
  await s.close();
});

test('R4-1: verification never reports a false mismatch while ticks run concurrently', async () => {
  const s = await server({ companiesPerMinute: 50 });
  const { cookie } = await s.call('POST', '/api/session');
  const calls: Promise<any>[] = [];
  for (let i = 0; i < 12; i++) { calls.push(s.call('POST', '/api/tick', cookie, { ticks: 1 })); calls.push(s.call('GET', '/api/verify', cookie)); }
  const out = await Promise.all(calls);
  const verifies = out.filter((r) => r.json && 'match' in r.json);
  assert.equal(verifies.length, 12);
  assert.ok(verifies.every((r) => r.json.match === true), JSON.stringify(verifies.map((r) => r.json)));
  await s.close();
});

// ---------------------------------------------------------------- second Codex pass (docs/reviews/R5-fix-verification-codex.md)
test('R5: a discount denied before the crashed request is redelivered still gets an answer', async () => {
  const { db, e, id } = await company({ seed: 7 });
  await e.run(id, 10);
  const restore = killAt(db, (sql, p) => sql.startsWith('UPDATE agents SET memory') && p.includes('sales'));
  await assert.rejects(e.tick(id), /simulated process kill/);
  restore();
  const ap = await q1(db, "SELECT * FROM approvals WHERE company = ? AND kind = 'discount' AND status = 'pending'", [id]);
  const e2 = new Engine(db);
  await e2.decide(id, ap.id, false, ap.hash); // decided while the continuation exists only in the durable record
  await e2.run(id, 2);
  const quote = await q1(db, 'SELECT discount_bp FROM quotes WHERE company = ? AND lead = ?', [id, JSON.parse(ap.params).lead]);
  assert.ok(quote, 'the lead was quoted');
  assert.equal(Number(quote.discount_bp), POLICY.discountAutoBp);
  await db.close();
});

test('R5: a recovery request whose continuation was lost still restarts Operations once approved', async () => {
  const { db, e, id } = await company({ seed: 7 });
  let filed = false;
  const restore = killAt(db, (sql, p) => {
    if (sql.startsWith('INSERT INTO approvals') && p.includes('recover-agent')) filed = true;
    return filed && sql.startsWith('UPDATE agents SET memory') && p.includes('finance');
  });
  let killed = false;
  for (let t = 0; t < 56 && !killed; t++) { try { await e.tick(id); } catch (err) { assert.match(String(err), /simulated process kill/); killed = true; } }
  restore();
  assert.ok(killed, 'the turn that filed the recovery request died');
  const ap = await q1(db, "SELECT * FROM approvals WHERE company = ? AND kind = 'recover-agent' AND status = 'pending'", [id]);
  assert.ok(ap);
  const e2 = new Engine(db);
  await e2.tick(id); // Finance's turn rebuilds the continuation from the approval record
  await e2.decide(id, ap.id, true, ap.hash);
  await e2.run(id, 2);
  assert.equal((await q1(db, 'SELECT status FROM approvals WHERE company = ? AND id = ?', [id, ap.id])).status, 'executed');
  assert.equal((await q1(db, "SELECT status FROM agents WHERE company = ? AND role = 'operations'", [id])).status, 'running');
  await db.close();
});

test('R5: an approved campaign that expires before use runs at Finance\'s own limit', async () => {
  const { db, e, id } = await company({ storyline: false });
  assert.equal((await run(db, id, 'sales', 'RequestAdSpend', { day: 1, amount: 20_000, skus: ['KETTLE'] })).outcome, 'committed');
  await e.tick(id);
  const ap = await q1(db, "SELECT * FROM approvals WHERE company = ? AND kind = 'ads' AND status = 'pending'", [id]);
  assert.ok(ap, 'above the daily limit: escalated');
  await e.setPaused(id, 'finance', true);
  await e.decide(id, ap.id, true, ap.hash);
  await e.run(id, POLICY.approvalTtlTicks + 2);
  await e.setPaused(id, 'finance', false);
  await e.tick(id);
  const ex = await q1(db, "SELECT amount FROM expenses WHERE company = ? AND id = 'EX-ads-1'", [id]);
  assert.ok(ex, 'the campaign was not silently dropped');
  assert.equal(Number(ex.amount), POLICY.adsDailyAutoCents);
  await db.close();
});

test('R5: when the needed overrides change twice, a matching approval already granted is used', async () => {
  const { db, e, id } = await company({ storyline: false });
  const po = (await run(db, id, 'operations', 'ProposePurchase', { sku: 'GRINDER', qty: 30, supplier: 'NORTHGATE' })).result.po;
  await e.tick(id); // Finance: over the purchase limit, so an approval for `limit`
  const ap1 = await q1(db, "SELECT * FROM approvals WHERE company = ? AND kind = 'purchase' AND status = 'pending'", [id]);
  assert.equal(JSON.parse(ap1.params).overrides, 'limit');
  await e.decide(id, ap1.id, true, ap1.hash);
  const drained = (await cashOf(db, id)) - 400_000;
  await drainCash(db, id, drained); // now funding would also breach the reserve
  await e.tick(id);
  const ap2 = await q1(db, "SELECT * FROM approvals WHERE company = ? AND kind = 'purchase' AND status = 'pending'", [id]);
  assert.equal(JSON.parse(ap2.params).overrides, 'limit+reserve');
  await drainCash(db, id, drained, true); // cash comes back before the human answers
  await e.decide(id, ap2.id, true, ap2.hash);
  await e.tick(id);
  const after = await q1(db, 'SELECT status, approval_id FROM purchase_orders WHERE company = ? AND id = ?', [id, po]);
  assert.equal(after.status, 'funded', 'funded under the approval that matches what is needed now');
  assert.equal(after.approval_id, ap1.id);
  await db.close();
});

test('R5: concurrent resets sharing one cookie cannot exceed the company cap', async () => {
  const s = await server({ maxCompanies: 1, companiesPerMinute: 50 });
  const { cookie } = await s.call('POST', '/api/session');
  const rs = await Promise.all(Array.from({ length: 8 }, () => s.call('POST', '/api/reset', cookie)));
  assert.equal(rs.filter((r) => r.status === 200).length, 1);
  assert.equal(await s.e.count(), 1);
  await s.close();
});

test('R5: if creating the replacement fails, a reset leaves the visitor\'s company intact', async () => {
  const s = await server({ companiesPerMinute: 50 });
  const { cookie } = await s.call('POST', '/api/session');
  const create = s.e.create.bind(s.e);
  (s.e as any).create = async () => { throw new Error('simulated creation failure'); };
  assert.equal((await s.call('POST', '/api/reset', cookie)).status, 500);
  (s.e as any).create = create;
  assert.equal((await s.call('GET', '/api/state', cookie)).status, 200);
  await s.close();
});

// ---------------------------------------------------------------- third Codex pass (docs/reviews/R6-fix-verification-2-codex.md)
test('R6: a campaign continuation rebuilt after a crash advertises exactly the approved products', async () => {
  // Before the fix rebuild() invented all four SKUs for a lost ads continuation, so a KETTLE-only request ran as a
  // four-product campaign. The approval now binds the SKUs and the rebuilt continuation reads them from it.
  const { db, e, id } = await company({ storyline: false });
  await run(db, id, 'sales', 'RequestAdSpend', { day: 1, amount: 20_000, skus: ['KETTLE'] });
  let filed = false;
  const restore = killAt(db, (sql, p) => {
    if (sql.startsWith('INSERT INTO approvals') && p.includes('ads')) filed = true;
    return filed && sql.startsWith('UPDATE agents SET memory') && p.includes('finance');
  });
  await assert.rejects(e.tick(id), /simulated process kill/);
  restore();
  const ap = await q1(db, "SELECT * FROM approvals WHERE company = ? AND kind = 'ads' AND status = 'pending'", [id]);
  assert.deepEqual(JSON.parse(ap.params).skus, ['KETTLE'], 'the human approves the products, not just the amount');
  // Spending is frozen while the request is redelivered, so only the rebuilt continuation survives the turn.
  await run(db, id, 'finance', 'SetSpendFreeze', { on: true, reason: 'test' });
  const e2 = new Engine(db);
  await e2.tick(id);
  const mem = JSON.parse((await q1(db, "SELECT memory FROM agents WHERE company = ? AND role = 'finance'", [id])).memory);
  assert.deepEqual(mem.pending[ap.id]?.skus, ['KETTLE'], 'rebuilt from the approval record');
  await e2.decide(id, ap.id, true, ap.hash);
  await e2.run(id, 2);
  const ex = await q1(db, "SELECT amount, ref FROM expenses WHERE company = ? AND id = 'EX-ads-1'", [id]);
  assert.ok(ex, 'the approved campaign ran');
  assert.deepEqual(JSON.parse(ex.ref), ['KETTLE']);
  assert.equal(Number(ex.amount), 20_000);
  await db.close();
});

test('R7: an ads approval cannot be stretched to advertise a product the human did not approve', async () => {
  // Before the fix the hash covered the first four SKUs but the expense stored the whole list, so a fifth product rode along.
  const { db, e, id } = await company({ storyline: false });
  const four = ['KETTLE', 'KETTLE', 'KETTLE', 'KETTLE'];
  const r = await run(db, id, 'finance', 'PayAds', { day: 1, amount: 20_000, skus: four });
  assert.equal(r.outcome, 'escalated');
  const ap = await q1(db, 'SELECT * FROM approvals WHERE company = ? AND id = ?', [id, r.approval]);
  await e.decide(id, ap.id, true, ap.hash);
  await run(db, id, 'finance', 'PayAds', { day: 1, amount: 20_000, skus: [...four, 'GRINDER'], approval_id: ap.id });
  const ex = await q1(db, "SELECT ref FROM expenses WHERE company = ? AND id = 'EX-ads-1'", [id]);
  assert.ok(!ex || !JSON.parse(ex.ref).includes('GRINDER'), 'only approved products are advertised');
  const paid = await q1(db, "SELECT payload FROM events WHERE company = ? AND type = 'AdSpendPaid'", [id]);
  assert.ok(!paid || !JSON.parse(paid.payload).skus.includes('GRINDER'));
  await db.close();
});

test('R7: a different campaign for the same day files its own approval instead of matching an earlier one', async () => {
  // Before the fix the request key was the day alone: a DRIPPER campaign matched the KETTLE approval, failed the hash
  // check at execution, and was dropped with no request for the human.
  const { db, e, id } = await company({ storyline: false });
  const a = await run(db, id, 'finance', 'PayAds', { day: 1, amount: 20_000, skus: ['KETTLE'] });
  const apA = await q1(db, 'SELECT * FROM approvals WHERE company = ? AND id = ?', [id, a.approval]);
  await e.decide(id, apA.id, true, apA.hash);
  const b = await run(db, id, 'finance', 'PayAds', { day: 1, amount: 20_000, skus: ['DRIPPER'] });
  assert.equal(b.outcome, 'escalated', 'a new request for the new campaign');
  assert.notEqual(b.approval, apA.id);
  assert.deepEqual(JSON.parse((await q1(db, 'SELECT params FROM approvals WHERE company = ? AND id = ?', [id, b.approval])).params).skus, ['DRIPPER']);
  const again = await run(db, id, 'finance', 'PayAds', { day: 1, amount: 20_000, skus: ['KETTLE'] });
  assert.equal(again.approval, apA.id, 'the same campaign still matches its own request');
  await db.close();
});

test('R6: if deleting the old company fails, a reset leaves one company and no capacity is lost', async () => {
  // Before the fix the replacement stayed behind without a cookie, holding the only slot: every retry returned 503.
  const s = await server({ maxCompanies: 1, companiesPerMinute: 50 });
  const { cookie } = await s.call('POST', '/api/session');
  const drop = s.e.drop.bind(s.e);
  let calls = 0;
  (s.e as any).drop = async (c: string) => { if (calls++ === 0) throw new Error('simulated deletion failure'); return drop(c); };
  assert.equal((await s.call('POST', '/api/reset', cookie)).status, 500);
  (s.e as any).drop = drop;
  assert.equal(await s.e.count(), 1, 'the replacement was undone');
  assert.equal((await s.call('GET', '/api/state', cookie)).status, 200, 'the visitor keeps the company they had');
  assert.equal((await s.call('POST', '/api/reset', cookie)).status, 200, 'a retry succeeds');
  assert.equal(await s.e.count(), 1);
  await s.close();
});
