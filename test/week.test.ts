// A full simulated week on several seeds: every invariant holds at every daily close, replay rebuilds the live
// state exactly, and the run is deterministic.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { company, dropSchemas, q1, qa, runWeek } from './helpers.ts';
import { reconcile, computeKpis } from '../src/kpi.ts';
import { replayChecksum } from '../src/replay.ts';

after(dropSchemas);

for (const seed of [7, 11, 23, 42, 101]) {
  test(`seed ${seed}: a full week closes 7 days, reconciles every day, and replays exactly`, async () => {
    const { db, e, id } = await company({ seed });
    await runWeek(e, id);
    const days = await qa(db, 'SELECT day, seq, checks, checksum FROM snapshots WHERE company = ? ORDER BY day', [id]);
    assert.equal(days.length, 7, 'Finance closed every business day');
    for (const d of days) {
      const failed = JSON.parse(d.checks).filter((c: any) => !c.ok);
      assert.deepEqual(failed, [], `day ${d.day} reconciliation`);
      // Replaying the event log up to the close reproduces the state Finance snapshotted at that moment.
      assert.equal((await replayChecksum(db, id, d.seq)).checksum, d.checksum, `day ${d.day} replay`);
    }
    assert.equal((await replayChecksum(db, id)).checksum, await e.checksumNow(id));
    const checks = await db.tx(null, (q) => reconcile(q, id));
    assert.ok(checks.every((c) => c.ok), JSON.stringify(checks.filter((c) => !c.ok)));
    const k = await db.tx(null, (q) => computeKpis(q, id));
    assert.ok(k.recognizedRevenue > 0 && k.recognizedRevenue < k.bookedValue, 'revenue is recognised on dispatch, not on booking');
    const shippedPosted = await q1(db, "SELECT SUM(total) AS v FROM orders o WHERE company = ? AND EXISTS (SELECT 1 FROM journal_entries j WHERE j.company = o.company AND j.source_id = o.id AND j.kind = 'shipment')", [id]);
    assert.equal(k.recognizedRevenue, Number(shippedPosted.v));
    const neg = await q1(db, 'SELECT COUNT(*) AS n FROM inventory WHERE company = ? AND (on_hand < 0 OR reserved < 0 OR reserved > on_hand OR value_cents < 0)', [id]);
    assert.equal(Number(neg.n), 0);
    const dupPay = await q1(db, "SELECT COUNT(*) AS n FROM (SELECT order_id FROM payments WHERE company = ? AND kind = 'capture' GROUP BY order_id HAVING COUNT(*) > 1) x", [id]);
    assert.equal(Number(dupPay.n), 0);
    const overCredit = await q1(db, `SELECT COUNT(*) AS n FROM orders o WHERE o.company = ? AND
      (SELECT COALESCE(SUM(amount),0) FROM payments p WHERE p.company = o.company AND p.order_id = o.id AND p.kind IN ('credit','deposit_refund')) > o.paid`, [id]);
    assert.equal(Number(overCredit.n), 0, 'no refund or credit beyond what was paid');
    const rejected = await q1(db, "SELECT COUNT(*) AS n FROM decisions WHERE company = ? AND outcome = 'rejected'", [id]);
    assert.equal(Number(rejected.n), 0, 'agents never attempted an action the kernel refused');
    await db.close();
  });
}

test('the same seed produces the same business, independent of company identity', async () => {
  const a = await company({ seed: 23 }); const b = await company({ seed: 23 }, a.db);
  await runWeek(a.e, a.id); await runWeek(b.e, b.id);
  assert.notEqual(a.id, b.id);
  assert.equal(await a.e.checksumNow(a.id), await b.e.checksumNow(b.id));
  const c = await company({ seed: 42 }, a.db); await runWeek(c.e, c.id);
  assert.notEqual(await a.e.checksumNow(a.id), await c.e.checksumNow(c.id), 'different seeds give different weeks');
  await a.db.close();
});

test('the week cannot run past day 7', async () => {
  const { db, e, id } = await company({ seed: 7, storyline: false });
  await e.run(id, 56);
  await assert.rejects(e.tick(id), /week is complete/);
  await db.close();
});
