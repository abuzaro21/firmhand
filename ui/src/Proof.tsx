import { useEffect, useState } from 'react';
import { api, money, ROLE_LABEL, type State } from './api.ts';

const ROWS: { key: string; label: string; fmt: (v: number) => string; better: 'high' | 'low' }[] = [
  { key: 'recognizedRevenue', label: 'Recognised revenue', fmt: (v) => money(v), better: 'high' },
  { key: 'netIncome', label: 'Net income', fmt: (v) => money(v), better: 'high' },
  { key: 'fulfilled', label: 'Orders shipped', fmt: String, better: 'high' },
  { key: 'backlogOrders', label: 'Backlog at week end', fmt: String, better: 'low' },
  { key: 'lateVsOriginal', label: 'Late vs first promise', fmt: String, better: 'low' },
  { key: 'renegotiated', label: 'Orders re-promised', fmt: String, better: 'high' },
  { key: 'customersChurned', label: 'Customers lost', fmt: String, better: 'low' },
  { key: 'customersAtRisk', label: 'Customers at risk', fmt: String, better: 'low' },
  { key: 'expediteSpend', label: 'Expedite spend', fmt: (v) => money(v), better: 'low' },
  { key: 'humanDecisions', label: 'Human decisions needed', fmt: String, better: 'low' },
];

function Compare({ kind, seed }: { kind: string; seed: number }) {
  const [c, setC] = useState<any>(null); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setC(null); api.compare(kind, seed).then(setC).catch((e) => setErr(e.message)); }, [kind, seed]);
  if (err) return <p className="bad">{err}</p>;
  if (!c) return <p className="muted">Running both companies for a full week…</p>;
  const naiveLabel = kind === 'inventory-shock' ? 'No self-correction' : 'No watchdog, no compensation';
  return (
    <div>
      <h3>{c.title}</h3>
      <p className="muted small">{c.label}. {c.assumption}</p>
      <table className="tbl cmp">
        <thead><tr><th>Seed {seed}, full week</th><th className="r">FIRMHAND policies</th><th className="r">{naiveLabel}</th></tr></thead>
        <tbody>
          {ROWS.map((r) => {
            const a = Number(c.managed[r.key] ?? 0); const b = Number(c.naive[r.key] ?? 0);
            const win = a === b ? '' : (r.better === 'high' ? a > b : a < b) ? 'win' : 'lose';
            return <tr key={r.key}><td>{r.label}</td><td className={`r num ${win}`}>{r.fmt(a)}</td><td className="r num">{r.fmt(b)}</td></tr>;
          })}
          {kind === 'operations-failure' && <tr><td>Operations at week end</td><td className="r">{c.managed.operationsEndStatus}</td><td className="r">{c.naive.operationsEndStatus}</td></tr>}
          {kind === 'operations-failure' && <tr><td>Stall detected at</td><td className="r num">{c.managed.firstAlertTick != null ? `hour ${c.managed.firstAlertTick}` : '—'}</td><td className="r">never</td></tr>}
          <tr><td>Books reconcile</td><td className="r">{c.managed.reconciliationOk ? 'yes' : 'NO'}</td><td className="r">{c.naive.reconciliationOk ? 'yes' : 'NO'}</td></tr>
        </tbody>
      </table>
      <p className="muted small">Better does not mean free. Self-correction spends real money on expedited stock, and the comparison shows that spend.</p>
    </div>
  );
}

export function Proof({ s }: { s: State }) {
  const [v, setV] = useState<any>(null); const [pol, setPol] = useState<any>(null);
  useEffect(() => { api.policy().then(setPol).catch(() => {}); }, []);
  const seed = [7, 11, 23, 42, 101].includes(s.company.seed) ? s.company.seed : 7;
  return (
    <div className="proof">
      <section className="panel">
        <h2>Does the record explain itself?</h2>
        <p>Rebuild this company from its event log alone and compare the result with the live tables: every account balance, stock level, order status and customer status.</p>
        <button className="btn primary" onClick={() => api.verify().then(setV)} data-testid="verify">Verify now</button>
        {v && <p className={v.match ? 'ok' : 'bad'} data-testid="verify-result">{v.match ? 'Match' : 'MISMATCH'}: live <code>{v.live}</code> {v.match ? '=' : '≠'} replay <code>{v.replay}</code></p>}
        <h3>Daily closes</h3>
        {!s.days.length && <p className="muted">Finance closes each day at 16:00. No day has closed yet.</p>}
        <ul className="closes">{s.days.map((d) => <li key={d.day}><b>Day {d.day}</b> <span className={`pill ${d.checks.every((c) => c.ok) ? 'ok' : 'bad'}`}>{d.checks.filter((c) => c.ok).length}/{d.checks.length} checks</span> <code>{d.checksum}</code> <span className="muted">at event #{d.seq}</span></li>)}</ul>
      </section>
      <section className="panel"><h2>Measured against a naive baseline</h2><Compare kind="inventory-shock" seed={seed} /></section>
      <section className="panel"><Compare kind="operations-failure" seed={seed} /></section>
      {pol && (
        <section className="panel">
          <h2>Who may do what</h2>
          <p className="muted small">The kernel checks every command against the executing agent's own role, not against anything the browser sends. An agent asking for a command outside its list is refused and the refusal is logged.</p>
          <div className="caps">
            {Object.entries(pol.capabilities as Record<string, string[]>).map(([r, cmds]) => <div key={r} className={`cap r-${r}`}><b>{ROLE_LABEL[r]}</b><ul>{cmds.map((c) => <li key={c}><code>{c}</code></li>)}</ul></div>)}
          </div>
          <h3>Authority limits (policy {pol.policy.version})</h3>
          <ul className="limits">
            <li>Discounts up to {pol.policy.discountAutoBp / 100}% are automatic. Up to {pol.policy.discountHardBp / 100}% needs you. Anything above that is refused outright.</li>
            <li>Purchases up to {money(pol.policy.purchaseAutoCents)} are automatic, while cash stays above the {money(pol.policy.cashReserveCents)} reserve. No purchase may be funded if it would leave cash below {money(pol.policy.cashFloorCents)}, and the ledger never lets cash go below zero.</li>
            <li>The weekly expedite budget is {money(pol.policy.expediteWeeklyCents)}. Credits above {money(pol.policy.creditAutoCents)}, cancellations above {money(pol.policy.cancelAutoCents)}, and ads above {money(pol.policy.adsDailyAutoCents)} a day need you.</li>
            <li>Restarting a crashed agent always needs you. An approval is single-use, expires after {pol.policy.approvalTtlTicks} business hours, and is bound to its exact parameters, record versions and policy version.</li>
          </ul>
        </section>
      )}
    </div>
  );
}
