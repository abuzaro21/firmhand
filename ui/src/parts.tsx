import { useMemo, useState, type ReactNode } from 'react';
import { ROLE_LABEL, money, shortClock, type Agent, type Approval, type Check, type Ev, type Incident, type Kpis, type State } from './api.ts';
import { kpiHelp } from './story.ts';

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="logo">
      <rect width="32" height="32" rx="7" className="logo-bg" />
      <rect x="7" y="9" width="4" height="12" rx="2" className="r-sales-fill" />
      <rect x="14" y="6" width="4" height="15" rx="2" className="r-operations-fill" />
      <rect x="21" y="11" width="4" height="10" rx="2" className="r-finance-fill" />
      <rect x="6" y="23" width="20" height="3" rx="1.5" className="logo-base" />
    </svg>
  );
}

/** Any record id in text becomes a link that traces it through every role. */
const ID = /\b((?:O|PO|AP|L|Q|INC-[a-z]+(?:-[A-Z]+)?)-\d+)\b/g;
export function Linked({ text, onTrace }: { text: string; onTrace: (id: string) => void }) {
  const parts: ReactNode[] = []; let last = 0; let m: RegExpExecArray | null;
  ID.lastIndex = 0;
  while ((m = ID.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const id = m[1];
    parts.push(<button key={m.index} className="idlink" onClick={() => onTrace(id)} title={`Trace ${id} through every role`}>{id}</button>);
    last = m.index + id.length;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
}

const TILES: { key: string; label: string; fmt: (k: Kpis) => string; sub: (k: Kpis) => string; tone?: (k: Kpis) => string }[] = [
  { key: 'recognizedRevenue', label: 'Recognised revenue', fmt: (k) => money(k.recognizedRevenue), sub: (k) => `${k.fulfilled} orders shipped` },
  { key: 'bookedValue', label: 'Bookings', fmt: (k) => money(k.bookedValue), sub: (k) => `${k.ordersBooked} orders · not revenue` },
  { key: 'cash', label: 'Cash', fmt: (k) => money(k.cash), sub: (k) => `${money(k.customerDeposits)} held as deposits`, tone: (k) => (k.cash < 300_000 ? 'warn' : '') },
  { key: 'netIncome', label: 'Net income', fmt: (k) => money(k.netIncome), sub: (k) => `${k.grossMarginPct}% gross margin`, tone: (k) => (k.netIncome < 0 ? 'bad' : '') },
  { key: 'backlogOrders', label: 'Backlog', fmt: (k) => String(k.backlogOrders), sub: (k) => `${k.backordered} waiting for stock`, tone: (k) => (k.backordered > 8 ? 'warn' : '') },
  { key: 'lateVsOriginal', label: 'Late vs first promise', fmt: (k) => String(k.lateVsOriginal), sub: (k) => `${k.renegotiated} orders re-promised`, tone: (k) => (k.lateVsOriginal > 5 ? 'warn' : '') },
  { key: 'customersChurned', label: 'Customers lost', fmt: (k) => String(k.customersChurned), sub: (k) => `${k.customersAtRisk} at risk of ${k.customersTotal}`, tone: (k) => (k.customersChurned > 0 ? 'bad' : '') },
];

export function KpiStrip({ k, onOpen }: { k: Kpis; onOpen: (key: string, label?: string) => void }) {
  return (
    <section className="kpis" aria-label="Key figures, derived from records">
      {TILES.map((t) => (
        <button key={t.key} className={`kpi ${t.tone?.(k) ?? ''}`} onClick={() => onOpen(t.key, t.label)} title={`${kpiHelp[t.key] ?? ''} Click for the records behind it.`}>
          <span className="kpi-label">{t.label}</span>
          <span className="kpi-value num">{t.fmt(k)}</span>
          <span className="kpi-sub">{t.sub(k)}</span>
        </button>
      ))}
    </section>
  );
}

export function FlowBand({ s }: { s: State }) {
  const o = s.flow?.orders ?? {};
  const steps = [
    { label: 'Leads', n: s.flow?.leads ?? 0, role: 'world' },
    { label: 'Quoted', n: s.flow?.quotes ?? 0, role: 'sales' },
    { label: 'Ordered', n: s.kpis.ordersBooked, role: 'sales' },
    { label: 'Waiting', n: (o.placed ?? 0) + (o.backordered ?? 0), role: 'operations', hint: `${o.backordered ?? 0} backordered` },
    { label: 'Reserved', n: o.reserved ?? 0, role: 'operations' },
    { label: 'Packed', n: o.packed ?? 0, role: 'operations' },
    { label: 'In transit', n: o.shipped ?? 0, role: 'finance', hint: 'revenue posted' },
    { label: 'Delivered', n: o.delivered ?? 0, role: 'sales' },
  ];
  return (
    <section className="flow" aria-label="Order pipeline">
      {steps.map((x, i) => (
        <div key={x.label} className={`flow-step r-${x.role}`}>
          <span className="flow-n num">{x.n}</span>
          <span className="flow-l">{x.label}</span>
          {x.hint && <span className="flow-h">{x.hint}</span>}
          {i < steps.length - 1 && <span className="flow-arrow" aria-hidden="true" />}
        </div>
      ))}
      {(o.cancelled ?? 0) > 0 && <div className="flow-step flow-cancel"><span className="flow-n num">{o.cancelled}</span><span className="flow-l">Cancelled</span></div>}
    </section>
  );
}

const ROLE_BLURB: Record<string, string> = {
  sales: 'Quotes leads, sets promise dates, places orders, keeps customers informed. Cannot touch stock or money.',
  operations: 'Reserves, packs and dispatches stock, proposes purchases, reports shortages. Cannot post to the ledger.',
  finance: 'Captures and posts every cent, funds purchases within budget, watches the other agents, closes each day.',
};

export function AgentLane({ a, clock, busy, onToggle, onTrace }: { a: Agent; clock: number; busy: boolean; onToggle: () => void; onTrace: (id: string) => void }) {
  const [open, setOpen] = useState<number | null>(null);
  const idle = a.last_progress == null ? null : clock - a.last_progress;
  return (
    <article className={`lane r-${a.role} st-${a.status}`} aria-label={`${ROLE_LABEL[a.role]} agent`}>
      <header className="lane-head">
        <span className="lane-dot" aria-hidden="true" />
        <h3>{ROLE_LABEL[a.role]}</h3>
        <span className={`pill st-${a.status}`}>{a.status === 'faulted' ? 'crashed' : a.status}</span>
        <button className="btn ghost sm" disabled={busy || a.status === 'faulted'} onClick={onToggle} title={a.status === 'faulted' ? 'A crashed agent restarts only through a human-approved recovery' : ''}>
          {a.status === 'paused' ? 'Resume' : 'Pause'}
        </button>
      </header>
      <p className="lane-blurb">{ROLE_BLURB[a.role]}</p>
      <div className="lane-plan">{a.status === 'faulted' ? <span className="bad">{a.fault_reason}</span> : a.plan || 'Waiting for the first turn.'}</div>
      <dl className="lane-stats">
        <div><dt>Inbox</dt><dd className="num">{a.queued}</dd></div>
        <div><dt>Committed</dt><dd className="num">{a.committed}</dd></div>
        <div><dt>Asked you</dt><dd className="num">{a.escalated}</dd></div>
        <div><dt>Refused</dt><dd className={`num ${a.rejected ? 'bad' : ''}`}>{a.rejected}</dd></div>
        <div><dt>Since progress</dt><dd className="num">{idle == null ? '—' : `${idle}h`}</dd></div>
      </dl>
      <ol className="receipts" aria-label="Latest decisions">
        {a.decisions.slice(0, 6).map((d) => (
          <li key={d.id} className={`rc oc-${d.outcome}`}>
            <button className="rc-head" onClick={() => setOpen(open === d.id ? null : d.id)} aria-expanded={open === d.id}>
              <span className="rc-time num">{shortClock(d.at)}</span>
              <span className="rc-cmd">{d.command}</span>
              <span className={`rc-oc oc-${d.outcome}`}>{d.outcome}</span>
            </button>
            <div className="rc-why"><Linked text={d.why} onTrace={onTrace} /></div>
            {open === d.id && (
              <div className="rc-more">
                <div><b>Rule</b> <code>{d.rule}</code></div>
                <div><b>Params</b> <code>{JSON.stringify(d.params)}</code></div>
                {d.detail && <div><b>Result</b> {d.detail}</div>}
                {Object.keys(d.inputs ?? {}).length > 0 && <div><b>Inputs</b> <code>{JSON.stringify(d.inputs)}</code></div>}
                {d.first_seq != null && <div><b>Events</b> #{d.first_seq}{d.last_seq !== d.first_seq ? `–#${d.last_seq}` : ''}</div>}
              </div>
            )}
          </li>
        ))}
        {!a.decisions.length && <li className="muted">No decisions yet.</li>}
      </ol>
    </article>
  );
}

export function Inbox({ approvals, clock, busy, onDecide, onTrace }: { approvals: Approval[]; clock: number; busy: boolean; onDecide: (a: Approval, ok: boolean) => void; onTrace: (id: string) => void }) {
  const pending = approvals.filter((a) => a.status === 'pending');
  const past = approvals.filter((a) => a.status !== 'pending').slice(0, 5);
  return (
    <section className="panel inbox" aria-label="Human approval inbox">
      <h2>Your inbox {pending.length > 0 && <span className="count">{pending.length}</span>}</h2>
      {!pending.length && <p className="muted">Nothing needs you. The agents act on their own inside their policy limits and ask only when they cross one.</p>}
      {pending.map((a) => (
        <article key={a.id} className="ap" data-testid="approval">
          <header><span className={`tag r-${a.requester}`}>{ROLE_LABEL[a.requester]}</span> <b>{a.id}</b> <span className="muted">expires {shortClock(a.expires_at)} ({Math.max(0, a.expires_at - clock)}h)</span></header>
          <p className="ap-sum"><Linked text={a.summary} onTrace={onTrace} /></p>
          <p className="ap-why">Why you: {a.threshold}</p>
          <Evidence ev={a.evidence} />
          <p className="ap-bind">Bound to <code>{a.bound.map(([t, id, v]) => `${t}/${id}@v${v}`).join(', ')}</code> · policy <code>{a.policy_version}</code> · hash <code>{a.hash.slice(0, 12)}…</code></p>
          <div className="ap-actions">
            <button className="btn primary" disabled={busy} onClick={() => onDecide(a, true)}>Approve</button>
            <button className="btn" disabled={busy} onClick={() => onDecide(a, false)}>Deny</button>
          </div>
        </article>
      ))}
      {past.length > 0 && (
        <ul className="ap-past">
          {past.map((a) => <li key={a.id}><b>{a.id}</b> <span className={`pill ap-${a.status}`}>{a.status}</span> <span className="muted"><Linked text={a.summary} onTrace={onTrace} /></span></li>)}
        </ul>
      )}
    </section>
  );
}

function Evidence({ ev }: { ev: Record<string, any> }) {
  const rows = Object.entries(ev ?? {}).filter(([, v]) => v !== '' && v != null).slice(0, 8);
  if (!rows.length) return null;
  const fmt = (k: string, v: any) => (typeof v === 'number' && /value|total|cash|paid|credited|reserve|margin_at|spent|order_total|amount/.test(k) && !/pct/.test(k) ? money(v, true) : typeof v === 'object' ? JSON.stringify(v) : String(v));
  return <dl className="evidence">{rows.map(([k, v]) => <div key={k}><dt>{k.replace(/_/g, ' ')}</dt><dd className="num">{fmt(k, v)}</dd></div>)}</dl>;
}

export function Incidents({ incidents, onTrace }: { incidents: Incident[]; onTrace: (id: string) => void }) {
  if (!incidents.length) return <section className="panel"><h2>Incidents</h2><p className="muted">None. Finance watches every agent for missing progress, with no heartbeat needed.</p></section>;
  return (
    <section className="panel" aria-label="Incidents">
      <h2>Incidents</h2>
      <ul className="inc">
        {incidents.slice(0, 6).map((i) => (
          <li key={i.id} className={`inc-${i.status}`}>
            <span className={`pill inc-${i.status}`}>{i.status}</span> <b>{i.id}</b> <span className="muted num">{shortClock(i.opened_at)}{i.resolved_at != null ? `–${shortClock(i.resolved_at)}` : ''}</span>
            <div><Linked text={i.summary} onTrace={onTrace} /></div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function LineChart({ series, lines, money: isMoney = true, height = 150, marks = [] }: {
  series: Record<string, number>[]; lines: { key: string; label: string; cls: string; dash?: boolean }[]; money?: boolean; height?: number; marks?: { at: number; label: string }[];
}) {
  const W = 560; const H = height; const P = { l: 46, r: 10, t: 10, b: 20 };
  const xs = series.map((p) => p.clock);
  const maxX = 56; const vals = series.flatMap((p) => lines.map((l) => Number(p[l.key] ?? 0)));
  const maxY = Math.max(1, ...vals) * 1.08; const minY = Math.min(0, ...vals);
  const x = (c: number) => P.l + ((c + 1) / maxX) * (W - P.l - P.r);
  const y = (v: number) => P.t + (1 - (v - minY) / (maxY - minY)) * (H - P.t - P.b);
  const ticks = [minY, (maxY + minY) / 2, maxY / 1.08];
  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={lines.map((l) => l.label).join(', ')}>
        {[1, 2, 3, 4, 5, 6].map((d) => <line key={d} x1={x(d * 8 - 1)} x2={x(d * 8 - 1)} y1={P.t} y2={H - P.b} className="grid" />)}
        {ticks.map((t, i) => <g key={i}><line x1={P.l} x2={W - P.r} y1={y(t)} y2={y(t)} className="grid" /><text x={P.l - 6} y={y(t) + 4} className="axis" textAnchor="end">{isMoney ? money(t) : Math.round(t)}</text></g>)}
        {[1, 2, 3, 4, 5, 6, 7].map((d) => <text key={d} x={x(d * 8 - 5)} y={H - 5} className="axis" textAnchor="middle">D{d}</text>)}
        {marks.map((m, i) => <g key={m.label + m.at}><line x1={x(m.at)} x2={x(m.at)} y1={P.t} y2={H - P.b} className="mark" /><text x={x(m.at) + 3} y={P.t + 9 + (i % 3) * 11} className="mark-l">{m.label}</text></g>)}
        {series.length > 0 && lines.map((l) => (
          <polyline key={l.key} className={`ln ${l.cls}`} strokeDasharray={l.dash ? '4 3' : undefined} fill="none" points={series.map((p, i) => `${x(xs[i])},${y(Number(p[l.key] ?? 0))}`).join(' ')} />
        ))}
      </svg>
      <figcaption className="legend">{lines.map((l) => <span key={l.key}><i className={`sw ${l.cls}`} />{l.label}</span>)}</figcaption>
    </figure>
  );
}

export function Checks({ checks }: { checks: Check[] }) {
  const ok = checks.every((c) => c.ok);
  return (
    <section className="panel" aria-label="Reconciliation">
      <h2>Reconciliation <span className={`pill ${ok ? 'ok' : 'bad'}`}>{ok ? `${checks.length}/${checks.length} pass` : 'FAIL'}</span></h2>
      <ul className="checks">
        {checks.map((c) => (
          <li key={c.name} title={c.note}>
            <span className={c.ok ? 'ok-dot' : 'bad-dot'} aria-label={c.ok ? 'pass' : 'fail'} />
            <span className="ck-name">{c.name}</span>
            <span className="ck-v num">{typeof c.ledger === 'number' && !['shipment-integrity', 'shipments-posted', 'reservations'].includes(c.name) ? money(c.ledger, true) : String(c.ledger)}</span>
          </li>
        ))}
      </ul>
      <p className="muted small">Each check compares a ledger balance with a figure rebuilt from operational records it does not own.</p>
    </section>
  );
}

export function Stock({ s }: { s: State }) {
  return (
    <section className="panel" aria-label="Inventory and purchasing">
      <h2>Stock &amp; purchasing</h2>
      <table className="tbl">
        <thead><tr><th>SKU</th><th className="r">Free</th><th className="r">Reserved</th><th className="r">Value</th></tr></thead>
        <tbody>
          {s.inventory.map((i) => (
            <tr key={i.sku} className={s.company.surge?.[i.sku] && s.company.surge[i.sku].until > s.company.clock ? 'hot' : ''}>
              <td>{i.name}{s.company.surge?.[i.sku] && s.company.surge[i.sku].until > s.company.clock ? <span className="pill warn">surge ×{s.company.surge[i.sku].factor}</span> : null}</td>
              <td className="r num">{i.on_hand - i.reserved}</td><td className="r num">{i.reserved}</td><td className="r num">{money(i.value_cents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="pos">
        {s.purchases.slice(0, 5).map((p) => (
          <li key={p.id}><b>{p.id}</b> {p.qty} × {p.sku} · {p.supplier === 'SWIFTLINE' ? 'Swiftline (backup)' : 'Northgate'} · {money(p.total)} <span className={`pill po-${p.status}`}>{p.status}</span>{p.eta_tick != null && ['funded'].includes(p.status) ? <span className="muted"> eta {shortClock(p.eta_tick)}</span> : null}</li>
        ))}
      </ul>
    </section>
  );
}

export function Feed({ events, onTrace, filter }: { events: Ev[]; onTrace: (id: string) => void; filter?: string }) {
  const [role, setRole] = useState(filter ?? 'all');
  const shown = useMemo(() => events.filter((e) => role === 'all' || e.actor === role).slice(-120).reverse(), [events, role]);
  return (
    <section className="panel feed" aria-label="Event log">
      <h2>Event log
        <span className="seg" role="group" aria-label="Filter by actor">
          {['all', 'sales', 'operations', 'finance', 'world', 'operator', 'system'].map((r) => <button key={r} className={role === r ? 'on' : ''} onClick={() => setRole(r)}>{r === 'all' ? 'All' : ROLE_LABEL[r]}</button>)}
        </span>
      </h2>
      <ol className="events">
        {shown.map((e) => (
          <li key={e.seq} className={`ev a-${e.actor}`}>
            <span className="ev-seq num">#{e.seq}</span>
            <span className="ev-at num">{shortClock(e.at)}</span>
            <span className={`ev-actor a-${e.actor}`}>{ROLE_LABEL[e.actor] ?? e.actor}</span>
            <span className="ev-type">{e.type}</span>
            <span className="ev-sum"><Linked text={e.summary} onTrace={onTrace} /></span>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="drawer-wrap" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <header><h2>{title}</h2><button className="btn ghost" onClick={onClose} aria-label="Close">Close</button></header>
        <div className="drawer-body">{children}</div>
      </aside>
    </div>
  );
}
