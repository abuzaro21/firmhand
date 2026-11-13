import { useEffect, useMemo, useState } from 'react';
import { api, money, ROLE_LABEL, shortClock, type State } from './api.ts';
import { Linked } from './parts.tsx';

/** Day replay: a pure reducer over the stored event log. It never calls an agent or a command. */
export function Replay({ s, onTrace }: { s: State; onTrace: (id: string) => void }) {
  const ran = Math.min(7, Math.floor((s.company.clock - 1) / 8) + 1);
  const [day, setDay] = useState(Math.max(1, s.days.length ? s.days[s.days.length - 1].day : ran));
  const [r, setR] = useState<any>(null);
  const [i, setI] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (s.company.clock === 0) return;
    setR(null); setErr(null); setPlaying(false);
    api.replay(day).then((x) => { setR(x); setI(0); }).catch((e) => setErr(e.message));
  }, [day, s.company.clock === 0]);

  useEffect(() => {
    if (!playing || !r) return;
    if (i >= r.steps.length - 1) { setPlaying(false); return; }
    const t = setTimeout(() => setI((x) => Math.min(r.steps.length - 1, x + 1)), 60);
    return () => clearTimeout(t);
  }, [playing, i, r]);

  const step = r?.steps[i];
  const f = step?.frame ?? r?.start;
  const window = useMemo(() => (r ? r.steps.slice(Math.max(0, i - 6), i + 1).reverse() : []), [r, i]);

  if (s.company.clock === 0) return <div className="panel"><h2>Replay</h2><p className="muted">Run at least one hour first. Replay rebuilds any day from the event log alone.</p></div>;
  return (
    <div className="replay">
      <section className="panel">
        <h2>Replay a day
          <span className="seg" role="group" aria-label="Day">
            {[1, 2, 3, 4, 5, 6, 7].map((d) => <button key={d} disabled={d > ran} className={day === d ? 'on' : ''} onClick={() => setDay(d)}>D{d}</button>)}
          </span>
        </h2>
        <p className="muted">Replay applies the facts each stored event carries: journal postings, stock deltas and status changes. It runs no agents and no commands, so it cannot change the company. The server measures the company's digest before and after to prove that.</p>
        {err && <p className="bad">{err}</p>}
        {r && (
          <div className="proofline">
            <span className={`pill ${r.sideEffects?.none ? 'ok' : 'bad'}`}>side effects: {r.sideEffects?.none ? 'none' : 'DETECTED'}</span>
            <span className="muted small">business state unchanged (session housekeeping excluded)</span>
            <span className="muted small">digest {r.sideEffects?.digestBefore} → {r.sideEffects?.digestAfter}</span>
            {r.verified ? <span className={`pill ${r.verified.match ? 'ok' : 'bad'}`}>replay {r.verified.replayChecksum} {r.verified.match ? '=' : '≠'} close snapshot {r.verified.snapshotChecksum}</span> : <span className="pill">day not closed yet: no snapshot to compare</span>}
          </div>
        )}
      </section>
      {r && f && (
        <>
          <section className="panel scrub">
            <div className="scrub-row">
              <button className="btn" onClick={() => { if (i >= r.steps.length - 1) setI(0); setPlaying(!playing); }}>{playing ? 'Pause' : 'Play'}</button>
              <input type="range" min={0} max={r.steps.length - 1} value={i} onChange={(e) => { setPlaying(false); setI(Number(e.target.value)); }} aria-label="Replay position" />
              <span className="num">{i + 1}/{r.steps.length} · {step ? shortClock(step.at) : ''}</span>
            </div>
            <dl className="frame">
              <div><dt>Revenue</dt><dd className="num">{money(f.revenue)}</dd></div>
              <div><dt>Cash</dt><dd className="num">{money(f.cash)}</dd></div>
              <div><dt>Deposits held</dt><dd className="num">{money(f.deposits)}</dd></div>
              <div><dt>Net income</dt><dd className="num">{money(f.netIncome)}</dd></div>
              <div><dt>Orders booked</dt><dd className="num">{f.booked}</dd></div>
              <div><dt>Backlog</dt><dd className="num">{f.backlog}</dd></div>
              <div><dt>Shipped</dt><dd className="num">{f.shipped}</dd></div>
              <div><dt>Lost customers</dt><dd className="num">{f.churned}</dd></div>
              {Object.entries(f.units ?? {}).map(([k, v]) => <div key={k}><dt>{k} free</dt><dd className="num">{String(v)}</dd></div>)}
            </dl>
          </section>
          <section className="panel">
            <h2>Events up to this point</h2>
            <ol className="events">
              {window.map((e: any) => (
                <li key={e.seq} className={`ev a-${e.actor}`}>
                  <span className="ev-seq num">#{e.seq}</span><span className="ev-at num">{shortClock(e.at)}</span>
                  <span className={`ev-actor a-${e.actor}`}>{ROLE_LABEL[e.actor] ?? e.actor}</span><span className="ev-type">{e.type}</span>
                  <span className="ev-sum"><Linked text={e.summary} onTrace={onTrace} />{e.postings?.length ? <span className="postings"> {e.postings.map((p: any) => p.lines.map((l: any) => `${l[0]} ${l[1] ? '+' + money(l[1], true) : '−' + money(l[2], true)}`).join(' / ')).join('; ')}</span> : null}</span>
                </li>
              ))}
            </ol>
          </section>
        </>
      )}
    </div>
  );
}
