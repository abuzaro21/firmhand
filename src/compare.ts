// Isolated counterfactual runs. Each comparison builds two brand-new companies in a private in-memory database (never
// the visitor's company, never the hosted database), with the same seed and the same injected scenario, and runs
// both for the full week. Only the policies differ. The result is labelled as a simulation comparison.
import { SqliteDb } from './db.ts';
import { Engine } from './engine.ts';
import { DAYS, TICKS_PER_DAY, type Policies, type ScenarioKind } from './model.ts';

export const COMPARISONS = {
  'inventory-shock': { at: 2 * TICKS_PER_DAY + 1, title: 'Inventory shock: grinder demand ×4 and a 3-day supplier delay', naive: { selfCorrect: false, watchdog: true } },
  'operations-failure': { at: 4 * TICKS_PER_DAY + 3, title: 'Operations crashes mid-turn on a busy day', naive: { selfCorrect: false, watchdog: false } },
} as const;
export type ComparisonKind = keyof typeof COMPARISONS;

async function runOne(seed: number, kind: ComparisonKind, policies: Policies) {
  const db = new SqliteDb(':memory:');
  try {
    const e = new Engine(db);
    const { id } = await e.create({ seed, scenarios: [{ at: COMPARISONS[kind].at, kind: kind as ScenarioKind, by: 'operator' }], policies });
    let humanDecisions = 0; let firstAlertTick: number | null = null; let recoveredTick: number | null = null;
    for (let t = 0; t < DAYS * TICKS_PER_DAY; t++) {
      await e.tick(id);
      // Stated assumption: a human answers any escalation one hour after it appears, and approves it.
      const { clock, pending } = await db.tx(null, async (q) => ({
        clock: Number((await q.one<any>('SELECT clock FROM companies WHERE id = ?', [id])).clock),
        pending: await q.all<any>("SELECT id, hash, kind, requested_at FROM approvals WHERE company = ? AND status = 'pending' ORDER BY requested_at, CAST(SUBSTR(id, 4) AS INTEGER)", [id]),
      }));
      for (const a of pending) if (clock >= a.requested_at + 1) { await e.decide(id, a.id, true, a.hash); humanDecisions++; }
      // The alert that matters for each scenario: a shortage report for the shock, a stall incident for the crash.
      const inc = await db.tx(null, (q) => q.one<any>('SELECT opened_at FROM incidents WHERE company = ? AND kind = ? AND opened_at >= ? ORDER BY opened_at LIMIT 1',
        [id, kind === 'operations-failure' ? 'ops-stalled' : 'shortage', COMPARISONS[kind].at]));
      if (inc && firstAlertTick === null) firstAlertTick = inc.opened_at;
      const ops = await db.tx(null, (q) => q.one<any>("SELECT status FROM agents WHERE company = ? AND role = 'operations'", [id]));
      if (kind === 'operations-failure' && recoveredTick === null && firstAlertTick !== null && ops.status === 'running' && t > COMPARISONS[kind].at) recoveredTick = t;
    }
    const s = await e.state(id);
    const k = s.kpis;
    const expedite = await db.tx(null, (q) => q.one<any>("SELECT COALESCE(SUM(total),0) AS v FROM purchase_orders WHERE company = ? AND kind = 'expedite' AND status IN ('funded','arrived','received')", [id]));
    const opsState = s.agents.find((a: any) => a.role === 'operations');
    return {
      policies, humanDecisions, firstAlertTick, recoveredTick, operationsEndStatus: opsState.status,
      recognizedRevenue: k.recognizedRevenue, netIncome: k.netIncome, cash: k.cash, customerDeposits: k.customerDeposits,
      fulfilled: k.fulfilled, backlogOrders: k.backlogOrders, backordered: k.backordered,
      lateVsOriginal: k.lateVsOriginal, brokenPromises: k.brokenPromises, renegotiated: k.renegotiated,
      lateCancellations: k.lateCancellations, customersChurned: k.customersChurned, customersAtRisk: k.customersAtRisk,
      expediteSpend: Number(expedite.v), reconciliationOk: s.checks.every((c: any) => c.ok), checksFailed: s.checks.filter((c: any) => !c.ok).map((c: any) => c.name),
      series: s.series.filter((x: any) => (x.clock + 1) % 4 === 0).map((x: any) => ({ clock: x.clock, revenue: x.revenue, backlog: x.backlog, churned: x.churned, broken: x.broken })),
    };
  } finally { await db.close(); }
}

const cache = new Map<string, Promise<any>>();
export function compare(kind: ComparisonKind, seed: number) {
  const key = `${kind}:${seed}`;
  if (!cache.has(key)) {
    if (cache.size > 40) cache.clear();
    const p = (async () => {
      const managed = await runOne(seed, kind, { selfCorrect: true, watchdog: true });
      const naive = await runOne(seed, kind, COMPARISONS[kind].naive);
      return { kind, seed, title: COMPARISONS[kind].title, label: 'Simulation comparison on isolated synthetic companies (same seed, same injected event; only the policies differ)',
        assumption: 'Any escalation is answered (approved) by the human one simulated hour after it appears.', managed, naive };
    })();
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return cache.get(key)!;
}
