// Mandatory adversarial regressions: each test tries to make the company do something it must never do.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.ts';
import { replayDay, replayChecksum } from '../src/replay.ts';
import { reconcile } from '../src/kpi.ts';
import { Ctx } from '../src/kernel.ts';
import { ACCOUNTS as A } from '../src/model.ts';
import { company, dropSchemas, durableName, newDb, placedOrder, q1, qa, run, runWeek } from './helpers.ts';

after(dropSchemas);
const n = async (p: Promise<any>) => Number((await p).n);

test('concurrent reservations for the last units: exactly one wins, stock never goes negative', async () => {
  const { db, id } = await company({ storyline: false });
  // Leave exactly 3 grinders free, then race two orders for 3 each.
  const inv = await q1(db, "SELECT on_hand FROM inventory WHERE company = ? AND sku = 'GRINDER'", [id]);
  const a = await placedOrder(db, id, 'GRINDER', inv.on_hand - 3);
  assert.equal((await run(db, id, 'finance', 'CapturePayment', { order: a.order })).outcome, 'committed');
  assert.equal((await run(db, id, 'operations', 'ReserveStock', { order: a.order })).outcome, 'committed');
  const b = await placedOrder(db, id, 'GRINDER', 3, 'R-02');
  const c = await placedOrder(db, id, 'GRINDER', 3, 'R-03');
  const [rb, rc] = await Promise.all([run(db, id, 'operations', 'ReserveStock', { order: b.order }), run(db, id, 'operations', 'ReserveStock', { order: c.order })]);
  assert.deepEqual([rb.outcome, rc.outcome].sort(), ['committed', 'rejected']);
  const after = await q1(db, "SELECT on_hand, reserved FROM inventory WHERE company = ? AND sku = 'GRINDER'", [id]);
  assert.equal(after.reserved, after.on_hand);
  assert.equal(await n(q1(db, "SELECT COUNT(*) AS n FROM reservations WHERE company = ? AND status = 'active'", [id])), 2);
  // The same order cannot be reserved twice either.
  const again = await run(db, id, 'operations', 'ReserveStock', { order: rb.outcome === 'committed' ? b.order : c.order });
  assert.equal(again.outcome, 'duplicate');
  await db.close();
});

test('duplicate payment: a retried capture and a re-delivered OrderPlaced never charge twice', async () => {
  const { db, e, id } = await company({ storyline: false });
  const o = await placedOrder(db, id, 'KETTLE', 2);
  const [r1, r2] = await Promise.all([run(db, id, 'finance', 'CapturePayment', { order: o.order }), run(db, id, 'finance', 'CapturePayment', { order: o.order })]);
  assert.deepEqual([r1.outcome, r2.outcome].sort(), ['committed', 'duplicate']);
  assert.equal(await n(q1(db, "SELECT COUNT(*) AS n FROM payments WHERE company = ? AND order_id = ?", [id, o.order])), 1);
  assert.equal(await n(q1(db, "SELECT COUNT(*) AS n FROM journal_entries WHERE company = ? AND source_id = ? AND kind = 'capture'", [id, o.order])), 1);
  // The payment network re-delivers the event; Finance processes its inbox; still one capture.
  await e.inject(id, 'duplicate-payment');
  await e.run(id, 2);
  assert.equal(await n(q1(db, "SELECT COUNT(*) AS n FROM payments WHERE company = ? AND order_id = ? AND kind = 'capture'", [id, o.order])), 1);
  const ev = await q1(db, "SELECT COUNT(*) AS n FROM events WHERE company = ? AND type = 'OrderPlaced' AND subject = ?", [id, o.order]);
  assert.equal(Number(ev.n), 2, 'the redelivery really happened');
  assert.ok((await db.tx(null, (q) => reconcile(q, id))).every((c) => c.ok));
  await db.close();
});

test('role violation: Sales cannot capture money and Operations cannot post journal entries', async () => {
  const { db, id } = await company({ storyline: false });
  const o = await placedOrder(db, id, 'DRIPPER', 1);
  const r = await run(db, id, 'sales', 'CapturePayment', { order: o.order });
  assert.equal(r.outcome, 'rejected'); assert.match(r.error!, /role violation/);
  assert.equal((await run(db, id, 'operations', 'IssueCredit', { order: o.order, amount: 100, reason: 'x' })).outcome, 'rejected');
  assert.equal((await run(db, id, 'finance', 'Dispatch', { order: o.order })).outcome, 'rejected');
  assert.equal(await n(q1(db, 'SELECT COUNT(*) AS n FROM payments WHERE company = ?', [id])), 0);
  assert.equal(await n(q1(db, "SELECT COUNT(*) AS n FROM events WHERE company = ? AND type = 'ActionRejected'", [id])), 3, 'every violation is on the record');
  await db.close();
});

test('a paused or faulted agent cannot act, even if called directly', async () => {
  const { db, e, id } = await company({ storyline: false });
  const o = await placedOrder(db, id, 'DRIPPER', 1);
  await e.setPaused(id, 'finance', true);
  const r = await run(db, id, 'finance', 'CapturePayment', { order: o.order });
  assert.equal(r.outcome, 'rejected'); assert.match(r.error!, /paused/);
  await e.run(id, 3);
  const fin = await q1(db, "SELECT turns FROM agents WHERE company = ? AND role = 'finance'", [id]);
  const sales = await q1(db, "SELECT turns FROM agents WHERE company = ? AND role = 'sales'", [id]);
  assert.equal(fin.turns, 0); assert.equal(sales.turns, 3, 'the other agents keep running');
  await e.setPaused(id, 'finance', false);
  await e.run(id, 1);
  assert.equal(await n(q1(db, "SELECT COUNT(*) AS n FROM payments WHERE company = ? AND order_id = ?", [id, o.order])), 1, 'the queued work is processed after resume');
  await db.close();
});

test('negative stock is impossible: packing more than is on the shelf is refused by the kernel and the schema', async () => {
  const { db, id } = await company({ storyline: false });
  await assert.rejects(db.tx(id, async (q) => { const ctx = new Ctx(q, id, 0, 'operations', 7); await ctx.stock('GRINDER', -1000, 0, 0, 'test', 'x'); }));
  await assert.rejects(db.tx(id, (q) => q.run("UPDATE inventory SET on_hand = -1 WHERE company = ? AND sku = 'GRINDER'", [id])), /CHECK|check/);
  await assert.rejects(db.tx(id, (q) => q.run("UPDATE inventory SET reserved = on_hand + 1 WHERE company = ? AND sku = 'GRINDER'", [id])), /CHECK|check/);
  const o = await placedOrder(db, id, 'GRINDER', 2);
  await run(db, id, 'finance', 'CapturePayment', { order: o.order });
  assert.equal((await run(db, id, 'operations', 'Pack', { order: o.order })).outcome, 'rejected', 'cannot pack without a reservation');
  await db.close();
});

test('overdraft is impossible: the ledger refuses any posting that takes cash below zero', async () => {
  const { db, id } = await company({ storyline: false });
  const cash = Number((await q1(db, "SELECT SUM(debit) - SUM(credit) AS v FROM journal_lines WHERE company = ? AND account = ?", [id, A.CASH])).v);
  await assert.rejects(db.tx(id, async (q) => {
    const ctx = new Ctx(q, id, 0, 'finance', 7);
    await ctx.post('test', 'big', 'spend', 'drain', [[A.ADS, cash + 1, 0], [A.CASH, 0, cash + 1]]);
  }), /overdraft/);
  // And an unbalanced entry is refused outright.
  await assert.rejects(db.tx(id, async (q) => { const ctx = new Ctx(q, id, 0, 'finance', 7); await ctx.post('test', 'u', 'x', 'unbalanced', [[A.ADS, 100, 0], [A.CASH, 0, 99]]); }));
  // A purchase that would breach the hard cash floor is refused, not escalated.
  const po = await run(db, id, 'operations', 'ProposePurchase', { sku: 'GRINDER', qty: 500, supplier: 'SWIFTLINE', kind: 'expedite' });
  const f = await run(db, id, 'finance', 'FundPurchase', { po: po.result.po });
  assert.equal(f.outcome, 'rejected'); assert.match(f.error!, /hard floor/);
  await db.close();
});

test('refunds and credits can never exceed what the customer paid', async () => {
  const { db, id } = await company({ storyline: false });
  const o = await placedOrder(db, id, 'FILTERS', 1); // $12.00
  await run(db, id, 'finance', 'CapturePayment', { order: o.order });
  assert.equal((await run(db, id, 'finance', 'IssueCredit', { order: o.order, amount: 1000, reason: 'a' })).outcome, 'committed');
  const over = await run(db, id, 'finance', 'IssueCredit', { order: o.order, amount: 201, reason: 'b' });
  assert.equal(over.outcome, 'rejected'); assert.match(over.error!, /exceed/);
  assert.equal((await run(db, id, 'finance', 'IssueCredit', { order: o.order, amount: 1000, reason: 'a' })).outcome, 'duplicate', 'same credit twice');
  await db.close();
});

test('margin guard: discounts above the hard limit are refused; above the auto limit they wait for a human', async () => {
  const { db, id } = await company({ storyline: false });
  const hard = await placedOrder(db, id, 'GRINDER', 2, 'C-01', 3000);
  assert.equal(hard.quote.outcome, 'rejected'); assert.match(hard.quote.error!, /hard limit/);
  const soft = await placedOrder(db, id, 'GRINDER', 2, 'C-02', 1800);
  assert.equal(soft.quote.outcome, 'escalated');
  assert.equal(await n(q1(db, 'SELECT COUNT(*) AS n FROM quotes WHERE company = ?', [id])), 0, 'no quote exists until a human decides');
  const ap = await q1(db, "SELECT * FROM approvals WHERE company = ? AND status = 'pending'", [id]);
  const ev = JSON.parse(ap.evidence);
  assert.equal(ev.gross_margin_at_discount, ev.quoted_value - 2 * 6200, 'the approval shows the margin the discount leaves');
  await db.close();
});

test('approval binding: tampered params, reuse, wrong company, wrong role, expiry and stale state all fail', async () => {
  const { db, e, id } = await company({ storyline: false });
  const other = await company({ storyline: false }, db);
  const s = await placedOrder(db, id, 'GRINDER', 2, 'C-02', 1800);
  const ap = await q1(db, "SELECT * FROM approvals WHERE company = ? AND status = 'pending'", [id]);
  // The operator must present the hash they were shown; a forged one is refused.
  await assert.rejects(e.decide(id, ap.id, true, '0'.repeat(64)), /changed since you viewed/);
  // A different company cannot decide or use it.
  await assert.rejects(other.e.decide(other.id, ap.id, true, ap.hash), /approval/);
  await e.decide(id, ap.id, true, ap.hash);
  await assert.rejects(e.decide(id, ap.id, true, ap.hash), /only a pending request/);
  // Tampered parameters: the approval covered 18%, not 25%.
  const t = await run(db, id, 'sales', 'IssueQuote', { lead: s.lead, discount_bp: 2500, promised_tick: 20, approval_id: ap.id });
  assert.equal(t.outcome, 'rejected'); assert.match(t.error!, /does not cover/);
  // Wrong role presenting it.
  assert.equal((await run(db, id, 'finance', 'IssueQuote', { lead: s.lead, discount_bp: 1800, promised_tick: 20, approval_id: ap.id })).outcome, 'rejected');
  assert.equal((await run(other.db, other.id, 'sales', 'IssueQuote', { lead: s.lead, discount_bp: 1800, promised_tick: 20, approval_id: ap.id })).outcome, 'rejected');
  // Correct use succeeds exactly once.
  assert.equal((await run(db, id, 'sales', 'IssueQuote', { lead: s.lead, discount_bp: 1800, promised_tick: 20, approval_id: ap.id })).outcome, 'committed');
  const s2 = await placedOrder(db, id, 'GRINDER', 1, 'C-03', 1500);
  const ap2 = await q1(db, "SELECT * FROM approvals WHERE company = ? AND status = 'pending'", [id]);
  await e.decide(id, ap2.id, true, ap2.hash);
  assert.equal((await run(db, id, 'sales', 'IssueQuote', { lead: s.lead, discount_bp: 1800, promised_tick: 20, approval_id: ap.id })).outcome, 'duplicate', 'reuse of a used approval');
  // Approve, then the bound record changes before execution: the approval goes stale and nothing happens.
  await db.tx(id, (q) => q.run('UPDATE leads SET version = version + 1 WHERE company = ? AND id = ?', [id, s2.lead]));
  const st = await run(db, id, 'sales', 'IssueQuote', { lead: s2.lead, discount_bp: 1500, promised_tick: 20, approval_id: ap2.id });
  assert.equal(st.outcome, 'rejected'); assert.match(st.error!, /changed since/);
  assert.equal((await q1(db, 'SELECT status FROM approvals WHERE company = ? AND id = ?', [id, ap2.id])).status, 'stale');
  assert.equal(await n(q1(db, "SELECT COUNT(*) AS n FROM events WHERE company = ? AND type = 'ApprovalStale'", [id])), 1);
  await db.close();
});

test('an approval cannot be decided after it expires', async () => {
  const { db, e, id } = await company({ storyline: false });
  await placedOrder(db, id, 'GRINDER', 2, 'C-02', 1800);
  const ap = await q1(db, "SELECT * FROM approvals WHERE company = ? AND status = 'pending'", [id]);
  await e.setPaused(id, 'sales', true); // keep Sales from re-quoting in the meantime
  await e.run(id, 10);
  const now = await q1(db, 'SELECT status FROM approvals WHERE company = ? AND id = ?', [id, ap.id]);
  assert.equal(now.status, 'expired');
  await assert.rejects(e.decide(id, ap.id, true, ap.hash), /expired/);
  await db.close();
});

test('restart: a pending approval and a half-finished tick survive a process restart and resume exactly once', async () => {
  const file = durableName();
  let db = await newDb(file);
  let e = new Engine(db);
  const { id } = await e.create({ seed: 7 });
  await e.run(id, 11); // the big-discount request appears at 10
  const ap = await q1(db, "SELECT * FROM approvals WHERE company = ? AND status = 'pending'", [id]);
  assert.ok(ap, 'a discount approval is waiting');
  // Crash inside a tick: the world and Sales phases commit, then the process dies before Operations runs.
  (e as any).runRole = async function (company: string, role: string, ...rest: any[]) {
    if (role === 'operations') throw new Error('simulated process crash');
    return (Engine.prototype as any).runRole.call(this, company, role, ...rest);
  };
  await assert.rejects(e.tick(id), /simulated process crash/);
  const mid = await q1(db, 'SELECT clock, phase FROM companies WHERE id = ?', [id]);
  assert.deepEqual([mid.clock, mid.phase], [11, 2]);
  await db.close();
  // New process, same durable store.
  db = await newDb(file); e = new Engine(db);
  const still = await q1(db, 'SELECT status, hash FROM approvals WHERE company = ? AND id = ?', [id, ap.id]);
  assert.equal(still.status, 'pending');
  await e.tick(id);
  const c = await q1(db, 'SELECT clock, phase FROM companies WHERE id = ?', [id]);
  assert.deepEqual([c.clock, c.phase], [12, 0]);
  assert.equal(await n(q1(db, "SELECT COUNT(*) AS n FROM tick_metrics WHERE company = ? AND clock = 11", [id])), 1);
  const sales11 = await q1(db, "SELECT turns FROM agents WHERE company = ? AND role = 'sales'", [id]);
  assert.equal(sales11.turns, 12, 'Sales did not take a second turn in the resumed hour');
  await e.decide(id, ap.id, true, still.hash);
  await e.run(id, 2);
  assert.equal((await q1(db, 'SELECT status FROM approvals WHERE company = ? AND id = ?', [id, ap.id])).status, 'executed');
  assert.equal((await replayChecksum(db, id)).checksum, await e.checksumNow(id));
  await db.close();
});

test('operations crash mid-turn: detection, compensation, human-approved recovery, exactly-once dispatch', async () => {
  const { db, e, id } = await company({ seed: 7 });
  await e.run(id, 36); // crash is scheduled at 35
  const ops = await q1(db, "SELECT status, fault_reason FROM agents WHERE company = ? AND role = 'operations'", [id]);
  assert.equal(ops.status, 'faulted'); assert.match(ops.fault_reason, /after-pack/);
  const stranded = await n(q1(db, "SELECT COUNT(*) AS n FROM shipments WHERE company = ? AND status = 'packed'", [id]));
  assert.ok(stranded > 0, 'the crash left packed-but-not-dispatched shipments (a real partial commit)');
  // Nobody is told the agent died: the failure event has no subscribers.
  assert.equal(await n(q1(db, "SELECT COUNT(*) AS n FROM agent_tasks t JOIN events v ON v.company = t.company AND v.seq = t.source_seq WHERE t.company = ? AND v.type = 'AgentFailed'", [id])), 0);
  let recoveredAt = -1;
  for (let t = 36; t < 56; t++) {
    await e.tick(id);
    for (const a of await qa(db, "SELECT id, hash, kind FROM approvals WHERE company = ? AND status = 'pending'", [id])) await e.decide(id, a.id, true, a.hash);
    if (recoveredAt < 0 && (await q1(db, "SELECT status FROM agents WHERE company = ? AND role = 'operations'", [id])).status === 'running') recoveredAt = t;
  }
  const inc = await q1(db, "SELECT * FROM incidents WHERE company = ? AND kind = 'ops-stalled'", [id]);
  assert.ok(inc, 'Finance detected the stall from missing progress');
  assert.ok(inc.opened_at - 35 <= 3, 'detected within three hours');
  assert.equal(inc.status, 'resolved');
  assert.ok(await q1(db, "SELECT 1 AS x FROM events WHERE company = ? AND type = 'SpendFreezeChanged' AND subject = 'freeze' AND at >= 35", [id]), 'compensation: discretionary spend frozen');
  assert.ok(await q1(db, "SELECT 1 AS x FROM events WHERE company = ? AND type = 'CapacityLost'", [id]), 'Sales is told capacity is gone and re-promises');
  assert.ok(await q1(db, "SELECT 1 AS x FROM approvals WHERE company = ? AND kind = 'recover-agent' AND status = 'executed'", [id]), 'restart went through a human');
  assert.ok(recoveredAt > 35);
  assert.ok(await q1(db, "SELECT 1 AS x FROM events WHERE company = ? AND type = 'RecoveryReconciled'", [id]));
  // Exactly once: no order has two shipments, two dispatch events, two revenue postings.
  assert.equal(await n(q1(db, "SELECT COUNT(*) AS n FROM (SELECT subject FROM events WHERE company = ? AND type = 'ShipmentDispatched' GROUP BY subject HAVING COUNT(*) > 1) x", [id])), 0);
  assert.equal(await n(q1(db, "SELECT COUNT(*) AS n FROM (SELECT source_id FROM journal_entries WHERE company = ? AND kind = 'shipment' GROUP BY source_id HAVING COUNT(*) > 1) x", [id])), 0);
  assert.ok((await db.tx(null, (q) => reconcile(q, id))).every((c) => c.ok));
  await db.close();
});

test('day replay is read-only: zero side effects, and it reproduces the closing snapshot', async () => {
  const { db, e, id } = await company({ seed: 11 });
  await runWeek(e, id);
  const before = await e.digest(id);
  for (let d = 1; d <= 7; d++) {
    const r = await replayDay(db, id, d);
    assert.ok(r.verified?.match, `day ${d}`);
    assert.ok(r.steps.length > 0);
  }
  assert.equal(await e.digest(id), before);
  await db.close();
});

test('self-correction needs no human: the inventory shock is handled with zero approvals and a bounded budget', async () => {
  const { db, e, id } = await company({ seed: 7, scenarios: [{ at: 17, kind: 'inventory-shock', by: 'operator' }] });
  await e.run(id, 40);
  assert.equal(await n(q1(db, 'SELECT COUNT(*) AS n FROM approvals WHERE company = ?', [id])), 0, 'no human was involved');
  const exp = await q1(db, "SELECT COALESCE(SUM(total),0) AS v FROM purchase_orders WHERE company = ? AND kind = 'expedite' AND status IN ('funded','arrived','received')", [id]);
  assert.ok(Number(exp.v) > 0 && Number(exp.v) <= 150_000, `expedite spend ${exp.v} within the weekly budget`);
  assert.ok(await q1(db, "SELECT 1 AS x FROM incidents WHERE company = ? AND kind = 'shortage'", [id]), 'Operations reported the shortage');
  assert.ok(Number((await q1(db, 'SELECT COUNT(*) AS n FROM orders WHERE company = ? AND notified = 1', [id])).n) > 0, 'Sales renegotiated affected promises');
  const ads = await qa(db, "SELECT payload FROM events WHERE company = ? AND type = 'AdSpendRequested' AND at >= 17", [id]);
  for (const a of ads) assert.ok(!JSON.parse(a.payload).skus.includes('GRINDER'), 'Sales stopped advertising the constrained product');
  // Side effects stay within role: no agent tried anything the kernel refused.
  assert.equal(await n(q1(db, "SELECT COUNT(*) AS n FROM decisions WHERE company = ? AND outcome = 'rejected'", [id])), 0);
  await db.close();
});

test('isolation: one company never sees or changes another company', async () => {
  const a = await company({ seed: 7 }); const b = await company({ seed: 7 }, a.db);
  await a.e.run(a.id, 16);
  const bBefore = await b.e.digest(b.id);
  assert.equal(await n(q1(a.db, 'SELECT COUNT(*) AS n FROM events WHERE company = ?', [b.id])), 1, 'B only has its founding event');
  const tr = await b.e.trace(b.id, 'O-1');
  assert.equal(tr.events.length, 0, "B's trace cannot reach A's order");
  await assert.rejects(b.e.decide(b.id, 'AP-1', true, 'x'), /approval/);
  assert.equal(await b.e.digest(b.id), bBefore);
  await a.db.close();
});
