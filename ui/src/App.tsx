import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, clockLabel, money, ROLE_LABEL, ROLES, shortClock, type Approval, type Ev, type Role, type State } from './api.ts';
import { AgentLane, Checks, Drawer, Feed, FlowBand, Incidents, Inbox, KpiStrip, LineChart, Linked, Logo, Stock } from './parts.tsx';
import { beats, kpiHelp, type Beat } from './story.ts';
import { Replay } from './Replay.tsx';
import { Proof } from './Proof.tsx';

type Tab = 'run' | 'watch' | 'replay' | 'proof';
const SPEEDS = [{ label: '1×', ms: 1400, ticks: 1 }, { label: '3×', ms: 450, ticks: 1 }, { label: 'Fast', ms: 0, ticks: 2 }] as const;
const SEEDS = [7, 11, 23, 42, 101];
const SCENARIOS: { kind: string; label: string; hint: string }[] = [
  { kind: 'inventory-shock', label: 'Inventory shock', hint: 'Grinder demand ×4 and a 3-day supplier delay. The agents must handle it without you.' },
  { kind: 'operations-failure', label: 'Crash Operations', hint: 'Operations crashes part-way through its next turn. Watch who notices.' },
  { kind: 'big-discount', label: 'Big-discount request', hint: 'A café asks for 18% off six grinders. That is above Sales’ authority.' },
  { kind: 'duplicate-payment', label: 'Duplicate payment event', hint: 'The payment network re-delivers an order event. Nothing may be charged twice.' },
];

export function App() {
  const [s, setS] = useState<State | null>(null);
  const [tab, setTab] = useState<Tab>(() => (location.hash === '#watch' ? 'watch' : location.hash === '#replay' ? 'replay' : location.hash === '#proof' ? 'proof' : 'run'));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [auto, setAuto] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [stopNote, setStopNote] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<{ title: string; body: React.ReactNode } | null>(null);
  const [events, setEvents] = useState<Ev[]>([]);
  const autoRef = useRef(false);

  const absorb = useCallback((st: State) => {
    setS(st);
    setEvents((prev) => {
      const m = new Map(prev.map((e) => [e.seq, e]));
      for (const e of st.events) m.set(e.seq, e);
      const all = [...m.values()].sort((a, b) => a.seq - b.seq);
      return all.length > 1500 ? all.slice(-1500) : all;
    });
  }, []);

  const loadAllEvents = useCallback(async () => {
    let after = 0; const out: Ev[] = [];
    for (let i = 0; i < 12; i++) { const page = await api.events(after); if (!page.length) break; out.push(...page); after = page[page.length - 1].seq; if (page.length < 300) break; }
    setEvents(out.slice(-1500));
  }, []);

  useEffect(() => { api.session().then(async (st) => { absorb(st); await loadAllEvents(); }).catch((e) => setErr(String(e.message ?? e))); }, [absorb, loadAllEvents]);
  useEffect(() => { history.replaceState(null, '', tab === 'run' ? location.pathname : `#${tab}`); }, [tab]);

  const act = useCallback(async (fn: () => Promise<State>) => {
    setBusy(true); setErr(null);
    try { absorb(await fn()); return true; }
    catch (e) {
      if (e instanceof ApiError && e.status === 401) { absorb(await api.session()); setErr('Your session expired, so a new company was started.'); }
      else setErr((e as Error).message);
      return false;
    } finally { setBusy(false); }
  }, [absorb]);

  // Run-the-week loop. Stepping is request-driven: every hour is one call; nothing runs while nobody is watching.
  useEffect(() => {
    autoRef.current = auto;
    if (!auto) return;
    let cancelled = false;
    (async () => {
      while (!cancelled && autoRef.current) {
        const sp = SPEEDS[speed];
        const t0 = performance.now();
        let st: State;
        try { st = await api.tick(sp.ticks); } catch (e) { setErr((e as Error).message); setAuto(false); break; }
        if (cancelled) break;
        absorb(st);
        if (st.company.complete) { setAuto(false); setStopNote('The week is complete. Open Replay or Proof to inspect it.'); break; }
        const pending = st.approvals.filter((a) => a.status === 'pending');
        if (pending.length) { setAuto(false); setStopNote(`Paused: ${pending[0].id} needs your decision. ${pending[0].summary}.`); break; }
        const wait = sp.ms - (performance.now() - t0);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
    })();
    return () => { cancelled = true; };
  }, [auto, speed, absorb]);

  const openKpi = useCallback(async (key: string, label?: string) => {
    try {
      const r = await api.kpi(key === 'grossMarginPct' ? 'grossProfit' : key);
      setDrawer({ title: `Where “${label ?? key}” comes from`, body: <KpiSources r={r} help={kpiHelp[key]} onTrace={(id) => trace(id)} /> });
    } catch (e) { setErr((e as Error).message); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const trace = useCallback(async (id: string) => {
    try { const r = await api.trace(id); setDrawer({ title: `Trace ${id}`, body: <Trace r={r} onTrace={(x) => trace(x)} /> }); }
    catch (e) { setErr((e as Error).message); }
  }, []);

  const decide = (a: Approval, ok: boolean) => act(() => api.decide(a.id, ok, a.hash, ok ? 'approved in cockpit' : 'denied in cockpit')).then((r) => { if (r) setStopNote(null); });

  if (!s) return <div className="boot"><Logo size={44} /><p>{err ?? 'Opening your company…'}</p></div>;
  const pending = s.approvals.filter((a) => a.status === 'pending');
  const progress = Math.min(1, s.company.clock / 56);

  return (
    <div className="app">
      <header className="top">
        <div className="brand"><Logo /><div><b className="wordmark">FIRMHAND</b><span className="tagline">a company run by three agents, one ledger, and you</span></div></div>
        <div className="clock" aria-live="polite">
          <span className="clock-label">{s.company.complete ? 'Week complete' : clockLabel(s.company.clock)}</span>
          <span className="clock-co">{s.company.name} · fictional · seed {s.company.seed}</span>
          <span className="week-bar" aria-hidden="true"><i style={{ width: `${progress * 100}%` }} /></span>
        </div>
        <div className="controls">
          <button className="btn primary" data-testid="run-week" disabled={busy && !auto || s.company.complete} onClick={() => { setStopNote(null); setAuto(!auto); }}>
            {auto ? 'Pause' : s.company.clock === 0 ? 'Run the week' : 'Keep running'}
          </button>
          <button className="btn" disabled={busy || auto || s.company.complete} onClick={() => act(() => api.tick(1))} data-testid="run-hour">+1 hour</button>
          <button className="btn" disabled={busy || auto || s.company.complete} onClick={() => act(() => api.day())} data-testid="run-day">+1 day</button>
          <span className="seg" role="group" aria-label="Speed">
            {SPEEDS.map((x, i) => <button key={x.label} className={speed === i ? 'on' : ''} onClick={() => setSpeed(i)}>{x.label}</button>)}
          </span>
          <Menu label="Inject" disabled={busy || s.company.complete}>
            {SCENARIOS.map((x) => <button key={x.kind} onClick={() => act(() => api.inject(x.kind)).then((ok) => ok && setStopNote(`Scheduled “${x.label}” for the next hour. ${x.hint}`))}><b>{x.label}</b><span>{x.hint}</span></button>)}
          </Menu>
          <Menu label="New company" disabled={busy || auto}>
            {SEEDS.map((sd) => <button key={sd} onClick={() => act(() => api.reset(sd)).then(() => { setEvents([]); loadAllEvents(); setStopNote(null); })}><b>Seed {sd}</b><span>Same storyline, different customers and demand.</span></button>)}
            <button onClick={() => act(() => api.reset(s.company.seed, false)).then(() => { setEvents([]); loadAllEvents(); })}><b>Quiet week (seed {s.company.seed})</b><span>No scheduled shocks. Inject your own.</span></button>
          </Menu>
        </div>
      </header>

      <nav className="tabs" aria-label="Views">
        {([['run', 'Run the Company'], ['watch', 'Watch a Company Day'], ['replay', 'Replay'], ['proof', 'Proof']] as [Tab, string][]).map(([k, l]) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)} aria-current={tab === k ? 'page' : undefined}>{l}{k === 'run' && pending.length > 0 && <span className="count">{pending.length}</span>}</button>
        ))}
      </nav>

      {(err || stopNote) && (
        <div className={`banner ${err ? 'bad' : ''}`} role="status">
          <span>{err ?? stopNote}</span>
          <button className="btn ghost sm" onClick={() => { setErr(null); setStopNote(null); }}>Dismiss</button>
        </div>
      )}

      <main>
        {tab === 'run' && <Cockpit s={s} events={events} busy={busy} onKpi={openKpi} onTrace={trace} onDecide={decide} onPause={(r, p) => act(() => api.pause(r, p))} />}
        {tab === 'watch' && <Watch s={s} events={events} busy={busy} auto={auto} onPlay={() => { setStopNote(null); setSpeed(speed === 2 ? 1 : speed); setAuto(!auto); }} onKpi={openKpi} onTrace={trace} onDecide={decide} />}
        {tab === 'replay' && <Replay s={s} onTrace={trace} />}
        {tab === 'proof' && <Proof s={s} />}
      </main>

      <footer className="foot">
        <span>Fictional company. All data is synthetic. No real payments, customers or suppliers.</span>
        <span>The operator is a demo role, not a verified identity.</span>
        <a href="https://github.com/abuzaro21/firmhand" rel="noreferrer">Source</a>
      </footer>

      {drawer && <Drawer title={drawer.title} onClose={() => setDrawer(null)}>{drawer.body}</Drawer>}
    </div>
  );
}

function Menu({ label, disabled, children }: { label: string; disabled?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', off); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', off); document.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <div className="menu" ref={ref}>
      <button className="btn" disabled={disabled} aria-expanded={open} onClick={() => setOpen(!open)}>{label} ▾</button>
      {open && <div className="menu-pop" onClick={() => setOpen(false)}>{children}</div>}
    </div>
  );
}

function Cockpit({ s, events, busy, onKpi, onTrace, onDecide, onPause }: {
  s: State; events: Ev[]; busy: boolean; onKpi: (k: string, label?: string) => void; onTrace: (id: string) => void; onDecide: (a: Approval, ok: boolean) => void; onPause: (r: Role, p: boolean) => void;
}) {
  const marks = s.company.scenarios.filter((x) => x.at <= s.company.clock).map((x) => ({ at: x.at, label: x.kind === 'inventory-shock' ? 'shock' : x.kind === 'operations-failure' ? 'crash' : x.kind === 'big-discount' ? 'discount ask' : 'dup event' }));
  return (
    <div className="cockpit">
      <KpiStrip k={s.kpis} onOpen={onKpi} />
      <FlowBand s={s} />
      <div className="grid-main">
        <div className="lanes">
          {ROLES.map((r) => { const a = s.agents.find((x) => x.role === r)!; return <AgentLane key={r} a={a} clock={s.company.clock} busy={busy} onTrace={onTrace} onToggle={() => onPause(r, a.status !== 'paused')} />; })}
        </div>
        <div className="side">
          <Inbox approvals={s.approvals} clock={s.company.clock} busy={busy} onDecide={onDecide} onTrace={onTrace} />
          <Incidents incidents={s.incidents} onTrace={onTrace} />
        </div>
      </div>
      <div className="grid-3">
        <section className="panel"><h2>Bookings vs recognised revenue</h2>
          <LineChart series={s.series as any} marks={marks} lines={[{ key: 'booked', label: 'Bookings', cls: 'c-booked', dash: true }, { key: 'revenue', label: 'Recognised revenue', cls: 'c-revenue' }, { key: 'netIncome', label: 'Net income', cls: 'c-ni' }]} />
        </section>
        <section className="panel"><h2>Backlog, late orders and lost customers</h2>
          <LineChart series={s.series as any} money={false} marks={marks} lines={[{ key: 'backlog', label: 'Backlog', cls: 'c-backlog' }, { key: 'broken', label: 'Late vs promise', cls: 'c-broken' }, { key: 'churned', label: 'Lost', cls: 'c-churn' }]} />
        </section>
        <Checks checks={s.checks} />
      </div>
      <div className="grid-2">
        <Stock s={s} />
        <Feed events={events} onTrace={onTrace} />
      </div>
    </div>
  );
}

function Watch({ s, events, busy, auto, onPlay, onKpi, onTrace, onDecide }: {
  s: State; events: Ev[]; busy: boolean; auto: boolean; onPlay: () => void; onKpi: (k: string, label?: string) => void; onTrace: (id: string) => void; onDecide: (a: Approval, ok: boolean) => void;
}) {
  const bs = useMemo(() => beats(events), [events]);
  const latest = bs.slice(-7).reverse();
  const listRef = useRef<HTMLOListElement>(null);
  const pending = s.approvals.filter((a) => a.status === 'pending');
  return (
    <div className="watch">
      <section className="story" aria-label="What is happening">
        <header>
          <h2>Watch a company day</h2>
          <p className="muted">Press play. The narration below is generated from the event log as it happens, and every beat links to the record behind it. The run stops whenever a decision needs you.</p>
          <button className="btn primary big" onClick={onPlay} disabled={busy && !auto || s.company.complete} data-testid="watch-play">{auto ? 'Pause' : s.company.complete ? 'Week complete' : s.company.clock === 0 ? 'Play the week' : 'Continue'}</button>
        </header>
        <ol className="beats" ref={listRef} aria-live="polite">
          {latest.map((b: Beat, i) => (
            <li key={`${b.seq}-${b.title}`} className={`beat t-${b.tone} ${i === 0 ? 'now' : ''}`}>
              <span className="beat-at num">{shortClock(b.at)} · #{b.seq}</span>
              <b>{b.title}</b>
              <p><Linked text={b.body} onTrace={onTrace} /></p>
            </li>
          ))}
        </ol>
      </section>
      <div className="watch-side">
        {pending.length > 0 && <Inbox approvals={s.approvals} clock={s.company.clock} busy={busy} onDecide={onDecide} onTrace={onTrace} />}
        <KpiStrip k={s.kpis} onOpen={onKpi} />
        <div className="mini-lanes">
          {s.agents.map((a) => (
            <div key={a.role} className={`mini r-${a.role} st-${a.status}`}>
              <b>{ROLE_LABEL[a.role]}</b> <span className={`pill st-${a.status}`}>{a.status === 'faulted' ? 'crashed' : a.status}</span>
              <p>{a.status === 'faulted' ? a.fault_reason : a.plan}</p>
              {a.decisions[0] && <p className="muted small">Last: {a.decisions[0].command} ({a.decisions[0].outcome}). {a.decisions[0].why}</p>}
            </div>
          ))}
        </div>
        <LineChart series={s.series as any} height={130} lines={[{ key: 'booked', label: 'Bookings', cls: 'c-booked', dash: true }, { key: 'revenue', label: 'Recognised revenue', cls: 'c-revenue' }]} />
        <p className="muted small">Cash {money(s.kpis.cash)} · deposits held {money(s.kpis.customerDeposits)} · reconciliation {s.checks.every((c) => c.ok) ? 'all pass' : 'FAILING'}</p>
      </div>
    </div>
  );
}

function KpiSources({ r, help, onTrace }: { r: Awaited<ReturnType<typeof api.kpi>>; help?: string; onTrace: (id: string) => void }) {
  return (
    <div>
      {help && <p>{help}</p>}
      {r.kind === 'journal' && (
        <>
          <p className="muted small">Journal lines on {r.accounts?.join(', ')} (latest {r.rows.length}). Every line belongs to a balanced entry that a specific event caused.</p>
          <table className="tbl">
            <thead><tr><th>When</th><th>Entry</th><th>Account</th><th className="r">Debit</th><th className="r">Credit</th><th>Event</th></tr></thead>
            <tbody>{r.rows.map((x, i) => <tr key={i}><td className="num">{shortClock(x.at)}</td><td><Linked text={x.memo} onTrace={onTrace} /></td><td>{x.account}</td><td className="r num">{x.debit ? money(x.debit, true) : ''}</td><td className="r num">{x.credit ? money(x.credit, true) : ''}</td><td className="num">#{x.event_seq}</td></tr>)}</tbody>
          </table>
        </>
      )}
      {r.kind === 'orders' && (
        <table className="tbl">
          <thead><tr><th>Order</th><th>Customer</th><th>Item</th><th>Status</th><th className="r">Total</th><th>Promised</th><th>Shipped</th></tr></thead>
          <tbody>{r.rows.map((o) => <tr key={o.id}><td><button className="idlink" onClick={() => onTrace(o.id)}>{o.id}</button></td><td>{o.customer}</td><td>{o.qty} × {o.sku}</td><td>{o.status}</td><td className="r num">{money(o.total, true)}</td><td className="num">{shortClock(o.promised_tick)}{o.original_promise !== o.promised_tick ? ` (was ${shortClock(o.original_promise)})` : ''}</td><td className="num">{o.shipped_at != null ? shortClock(o.shipped_at) : '—'}</td></tr>)}</tbody>
        </table>
      )}
      {r.kind === 'customers' && (
        <table className="tbl">
          <thead><tr><th>Customer</th><th>Kind</th><th>Status</th><th className="r">Satisfaction</th><th className="r">Orders</th></tr></thead>
          <tbody>{r.rows.map((c) => <tr key={c.id}><td>{c.name} <span className="muted">{c.id}</span></td><td>{c.kind}</td><td>{c.status}</td><td className="r num">{c.satisfaction}</td><td className="r num">{c.orders}</td></tr>)}</tbody>
        </table>
      )}
    </div>
  );
}

function Trace({ r, onTrace }: { r: Awaited<ReturnType<typeof api.trace>>; onTrace: (id: string) => void }) {
  return (
    <div className="trace">
      <h3>Events</h3>
      <ol className="events">{r.events.map((e) => <li key={e.seq} className={`ev a-${e.actor}`}><span className="ev-seq num">#{e.seq}</span><span className="ev-at num">{shortClock(e.at)}</span><span className={`ev-actor a-${e.actor}`}>{ROLE_LABEL[e.actor] ?? e.actor}</span><span className="ev-type">{e.type}</span><span className="ev-sum"><Linked text={e.summary} onTrace={onTrace} /></span></li>)}</ol>
      {!r.events.length && <p className="muted">No events mention {r.subject} in this company.</p>}
      {r.decisions.length > 0 && <><h3>Agent decisions</h3>
        <ol className="receipts">{r.decisions.map((d) => <li key={d.id} className={`rc oc-${d.outcome}`}><div className="rc-head static"><span className="rc-time num">{shortClock(d.at)}</span><span className={`tag r-${d.role}`}>{ROLE_LABEL[d.role]}</span><span className="rc-cmd">{d.command}</span><span className={`rc-oc oc-${d.outcome}`}>{d.outcome}</span></div><div className="rc-why">{d.why}{d.detail ? ` · ${d.detail}` : ''}</div></li>)}</ol></>}
      {r.journal.length > 0 && <><h3>Ledger</h3>
        <table className="tbl"><thead><tr><th>When</th><th>Entry</th><th>Account</th><th className="r">Debit</th><th className="r">Credit</th></tr></thead>
          <tbody>{r.journal.map((x, i) => <tr key={i}><td className="num">{shortClock(x.at)}</td><td>{x.memo}</td><td>{x.account}</td><td className="r num">{x.debit ? money(x.debit, true) : ''}</td><td className="r num">{x.credit ? money(x.credit, true) : ''}</td></tr>)}</tbody></table></>}
    </div>
  );
}
