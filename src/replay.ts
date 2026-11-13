// Replay: a pure reducer over the persisted event log. It never calls planners, commands or inbox delivery; it only
// reads events and applies the facts each one carries (journal postings, stock deltas, order and customer status).
// Its checksum must equal the live tables' checksum — proof that the event log is a complete record of the business.
import type { Db } from './db.ts';
import { ACCOUNTS as A, TICKS_PER_DAY, dayOf } from './model.ts';
import { checksum, normaliseState, type State } from './kpi.ts';
import { NotFound } from './kernel.ts';

type Ev = { seq: number; at: number; type: string; actor: string; subject: string; causation: number | null; summary: string; payload: any };

export function emptyState(): State { return { accounts: {}, stock: {}, orders: {}, customers: {} }; }
export function apply(s: State, e: Ev) {
  const f = e.payload?.facts;
  if (!f) return;
  for (const p of f.postings ?? []) for (const [acct, d, c] of p.lines) s.accounts[acct] = (s.accounts[acct] ?? 0) + d - c;
  for (const m of f.stock ?? []) { const x = s.stock[m.sku] ?? [0, 0, 0]; s.stock[m.sku] = [x[0] + m.qty, x[1] + m.reserved, x[2] + m.value]; }
  for (const o of f.orders ?? []) s.orders[o.id] = o.status;
  for (const c of f.customers ?? []) s.customers[c.id] = c.status;
}
const sortedState = (s: State): State => normaliseState({
  accounts: s.accounts,
  stock: Object.fromEntries(Object.keys(s.stock).sort().map((k) => [k, s.stock[k]])),
  orders: Object.fromEntries(Object.keys(s.orders).sort().map((k) => [k, s.orders[k]])),
  customers: Object.fromEntries(Object.keys(s.customers).sort().map((k) => [k, s.customers[k]])),
});

/** Headline figures recomputable from the replayed state alone. */
export function frame(s: State) {
  const g = (k: string) => s.accounts[k] ?? 0;
  const revenue = -g(A.REVENUE); const refunds = g(A.REFUNDS); const cogs = g(A.COGS);
  const opex = g(A.SHIPPING) + g(A.ADS) + g(A.STAFF);
  const statuses = Object.values(s.orders);
  return {
    revenue, cash: g(A.CASH), cogs, opex, netIncome: revenue - refunds - cogs - opex, deposits: -g(A.DEPOSITS),
    booked: statuses.length, backlog: statuses.filter((x) => ['placed', 'reserved', 'backordered', 'packed'].includes(x)).length,
    shipped: statuses.filter((x) => x === 'shipped' || x === 'delivered').length, cancelled: statuses.filter((x) => x === 'cancelled').length,
    units: Object.fromEntries(Object.entries(s.stock).map(([k, v]) => [k, v[0] - v[1]])),
    churned: Object.values(s.customers).filter((x) => x === 'churned').length, atRisk: Object.values(s.customers).filter((x) => x === 'at_risk').length,
  };
}

async function load(db: Db, company: string, toSeq = 2_147_483_647): Promise<Ev[]> {
  return db.tx(null, (q) => q.all<any>('SELECT seq, at, type, actor, subject, causation, summary, payload FROM events WHERE company = ? AND seq <= ? ORDER BY seq', [company, toSeq]))
    .then((r) => r.map((e) => ({ ...e, payload: JSON.parse(e.payload) })));
}

/** Rebuild the whole business from events and return its checksum. */
export async function replayChecksum(db: Db, company: string, toSeq?: number) {
  const s = emptyState();
  for (const e of await load(db, company, toSeq)) apply(s, e);
  return { checksum: checksum(sortedState(s)), state: sortedState(s) };
}

/** One business day, observationally: the state at the start of the day, then every event of the day with the
 *  frame after it. Read-only by construction (GET; no command path is reachable from here). */
export async function replayDay(db: Db, company: string, day: number) {
  const events = await load(db, company);
  if (!events.length) throw new NotFound('company');
  const from = (day - 1) * TICKS_PER_DAY; const to = day * TICKS_PER_DAY;
  const s = emptyState();
  let i = 0;
  while (i < events.length && events[i].at < from && !(events[i].type === 'DayStarted' && dayOf(events[i].at) === day)) apply(s, events[i++]);
  const start = frame(s);
  const steps: any[] = [];
  for (; i < events.length && events[i].at < to; i++) {
    const e = events[i]; apply(s, e);
    const { facts, ...payload } = e.payload ?? {};
    steps.push({ seq: e.seq, at: e.at, type: e.type, actor: e.actor, subject: e.subject, causation: e.causation, summary: e.summary, payload,
      postings: facts?.postings ?? [], frame: frame(s) });
  }
  if (!steps.length) throw new NotFound(`day ${day} has not run yet`);
  const lastSeq = steps.at(-1).seq;
  const snap = await db.tx(null, (q) => q.one<any>('SELECT seq, checksum FROM snapshots WHERE company = ? AND day = ?', [company, day]));
  // Compare against Finance's end-of-day snapshot when the day closed: replaying up to that seq must reproduce it.
  let verified: { snapshotSeq: number; snapshotChecksum: string; replayChecksum: string; match: boolean } | null = null;
  if (snap) {
    const r = await replayChecksum(db, company, snap.seq);
    verified = { snapshotSeq: snap.seq, snapshotChecksum: snap.checksum, replayChecksum: r.checksum, match: r.checksum === snap.checksum };
  }
  return { day, start, end: steps.at(-1).frame, lastSeq, steps, verified };
}
