// The company engine: genesis, the scheduler (which only hands out turns), the role runtime, operator controls and
// read models. The scheduler contains no commercial policy; each role's decisions live in src/agents/<role>.ts.
import { randomBytes } from 'node:crypto';
import type { Db, Q } from './db.ts';
import { TABLES } from './db.ts';
import { HANDLERS } from './commands.ts';
import { Ctx, InjectedFault, NotFound, Rejected, companyRow, exec } from './kernel.ts';
import { checksum, computeKpis, liveState, reconcile } from './kpi.ts';
import { ACCOUNTS as A, COMPANY, DAYS, OPENING_CASH, PRODUCTS, ROLES, SCENARIOS, STORYLINE, SUPPLIERS, TICKS_PER_DAY, dayOf, fmtClock, sha256,
  type Policies, type Role, type Scenario, type ScenarioKind } from './model.ts';
import { worldPhase } from './world.ts';
import { sales } from './agents/sales.ts';
import { operations } from './agents/operations.ts';
import { finance } from './agents/finance.ts';
import type { Policy, Task, Turn } from './agents/types.ts';

const POLICIES: Record<Role, Policy> = { sales, operations, finance };
const PHASES = ['world', 'sales', 'operations', 'finance'] as const;
const RETAIL = ['Amara K.', 'Ben O.', 'Chloé D.', 'Dev P.', 'Eli R.', 'Farah S.', 'Gus T.', 'Hana M.', 'Iris W.', 'Jonah B.', 'Kai L.', 'Lena V.', 'Milo F.',
  'Nora A.', 'Omar H.', 'Priya N.', 'Quinn E.', 'Rosa G.', 'Sami J.', 'Tess C.', 'Uma Y.', 'Vik Z.', 'Wren I.', 'Xan Q.', 'Yara U.', 'Zeke X.', 'Ada N.', 'Bo P.', 'Cyd R.', 'Dina S.'];
const CAFES = ['Alder Street Café', 'Bluebird Roasters', 'Copper Pot Café', 'Driftwood Espresso', 'Elm & Ember', 'Foxglove Coffee', 'Granary Café', 'Harbor Bean', 'Ironleaf Café', 'Juniper Corner'];

export type CreateOpts = { seed?: number; storyline?: boolean; policies?: Partial<Policies>; scenarios?: Scenario[] };

/** Record that `phase` of hour `clock` is finished. Always called inside the transaction that did the phase's work. */
async function advancePhase(q: Q, company: string, clock: number, phase: number) {
  const n = await q.run('UPDATE companies SET phase = ? WHERE id = ? AND clock = ? AND phase = ?', [phase + 1, company, clock, phase]);
  if (n !== 1) throw new Error('phase advanced concurrently');
}

export class Engine {
  private locks = new Map<string, Promise<unknown>>();
  db: Db;
  constructor(db: Db) { this.db = db; }

  /** One operation at a time per company in this process (the database row lock covers other processes). */
  serial<T>(company: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(company) ?? Promise.resolve();
    const p = prev.then(fn, fn);
    const tail = p.catch(() => {});
    this.locks.set(company, tail);
    tail.then(() => { if (this.locks.get(company) === tail) this.locks.delete(company); });
    return p;
  }

  async create(o: CreateOpts = {}): Promise<{ id: string; token: string }> {
    const id = `co_${randomBytes(8).toString('hex')}`;
    const token = randomBytes(24).toString('base64url');
    const seed = o.seed ?? 7;
    const policies: Policies = { selfCorrect: true, watchdog: true, ...o.policies };
    const scenarios = o.scenarios ?? (o.storyline === false ? [] : STORYLINE);
    const now = Date.now();
    await this.db.tx(null, async (q) => {
      await q.run('INSERT INTO companies (id, token_hash, seed, policies, world, scenarios, created, last_active) VALUES (?,?,?,?,?,?,?,?)',
        [id, sha256(token), seed, JSON.stringify(policies), JSON.stringify({ surge: {}, freeze: null }), JSON.stringify(scenarios), now, now]);
      for (const r of ROLES) await q.run('INSERT INTO agents (company, role, status, memory) VALUES (?,?,?,?)', [id, r, 'running', '{}']);
      for (const s of SUPPLIERS) await q.run('INSERT INTO suppliers (company, id, name, lead_ticks, cost_bp) VALUES (?,?,?,?,?)', [id, s.id, s.name, s.lead_ticks, s.cost_bp]);
      const ctx = new Ctx(q, id, 0, 'system', seed);
      let invValue = 0;
      for (const p of PRODUCTS) {
        await q.run('INSERT INTO products (company, sku, name, price, std_cost, reorder_point, target_stock) VALUES (?,?,?,?,?,?,?)', [id, p.sku, p.name, p.price, p.std_cost, p.reorder_point, p.target_stock]);
        await q.run('INSERT INTO inventory (company, sku, on_hand, reserved, value_cents) VALUES (?,?,?,?,?)', [id, p.sku, 0, 0, 0]);
        await ctx.stock(p.sku, p.stock, 0, p.stock * p.std_cost, 'opening', 'genesis');
        invValue += p.stock * p.std_cost;
      }
      const custs = [...RETAIL.map((n, i) => ({ id: `R-${String(i + 1).padStart(2, '0')}`, name: n, kind: 'retail' })), ...CAFES.map((n, i) => ({ id: `C-${String(i + 1).padStart(2, '0')}`, name: n, kind: 'cafe' }))];
      for (const c of custs) {
        const patience = c.kind === 'cafe' ? 16 + Math.floor((seed * 7 + c.id.charCodeAt(3)) % 9) : 8 + Math.floor((seed * 3 + c.id.charCodeAt(3)) % 9);
        await q.run('INSERT INTO customers (company, id, name, kind, patience, satisfaction, status) VALUES (?,?,?,?,?,?,?)', [id, c.id, c.name, c.kind, patience, 72, 'active']);
        ctx.facts.customers.push({ id: c.id, status: 'active' });
      }
      await ctx.post('genesis', id, 'opening', 'Opening balance: owner capital and opening stock', [[A.CASH, OPENING_CASH, 0], [A.INVENTORY, invValue, 0], [A.EQUITY, 0, OPENING_CASH + invValue]]);
      await ctx.emit('CompanyFounded', id, `${COMPANY.name} opens (fictional; seed ${seed}${scenarios.length ? `; ${scenarios.length} scheduled scenarios` : ''})`, { seed, policies, scenarios });
    });
    return { id, token };
  }

  async resolve(token: string | undefined): Promise<string | null> {
    if (!token || token.length > 100) return null;
    const r = await this.db.tx(null, (q) => q.one<{ id: string }>('SELECT id FROM companies WHERE token_hash = ?', [sha256(token)]));
    if (!r) return null;
    await this.db.tx(null, (q) => q.run('UPDATE companies SET last_active = ? WHERE id = ?', [Date.now(), r.id]));
    return r.id;
  }

  async drop(company: string) {
    await this.serial(company, () => this.db.tx(null, async (q) => {
      for (const t of TABLES) await q.run(`DELETE FROM ${t} WHERE company = ?`, [company]);
      await q.run('DELETE FROM companies WHERE id = ?', [company]);
    }));
  }
  async expire(idleMs: number) {
    const old = await this.db.tx(null, (q) => q.all<{ id: string }>('SELECT id FROM companies WHERE last_active < ?', [Date.now() - idleMs]));
    for (const o of old) await this.drop(o.id);
    return old.length;
  }
  async count() { return Number((await this.db.tx(null, (q) => q.one<any>('SELECT COUNT(*) AS n FROM companies')))!.n); }

  // ------------------------------------------------------------------ the scheduler
  /** Advance one business hour: world, then each role's own turn, each phase durable. Resumes mid-tick after a crash. */
  tick(company: string) {
    return this.serial(company, async () => {
      const c = await this.db.tx(null, (q) => companyRow(q, company));
      if (c.clock >= DAYS * TICKS_PER_DAY) throw new Rejected('the simulated week is complete; reset to start a new company');
      const policies: Policies = JSON.parse(c.policies);
      const turns: Record<string, string> = {};
      for (let phase = c.phase; phase < PHASES.length; phase++) {
        // Each phase's effects and its checkpoint commit in ONE transaction, so a crash can never leave a phase done
        // but unrecorded (which would replay the world twice, or block the clock on a duplicate DayStarted).
        if (phase === 0) await this.db.tx(company, async (q) => { await worldPhase(q, company, c.clock, c.seed); await advancePhase(q, company, c.clock, phase); });
        else turns[PHASES[phase]] = await this.runRole(company, PHASES[phase] as Role, c.clock, policies, phase);
      }
      await this.db.tx(company, async (q) => {
        const kpis = await computeKpis(q, company);
        const seq = (await q.one<any>('SELECT ev_seq FROM companies WHERE id = ?', [company])).ev_seq;
        await q.run('INSERT INTO tick_metrics (company, clock, seq, kpis) VALUES (?,?,?,?)', [company, c.clock, seq, JSON.stringify(kpis)]);
        await q.run('UPDATE companies SET clock = clock + 1, phase = 0 WHERE id = ? AND clock = ? AND phase = ?', [company, c.clock, PHASES.length]);
      });
      return { clock: c.clock + 1, turns };
    });
  }

  async run(company: string, ticks: number) {
    const n = Math.max(1, Math.min(TICKS_PER_DAY * DAYS, Math.floor(ticks)));
    let last: any;
    for (let i = 0; i < n; i++) {
      const c = await this.db.tx(null, (q) => q.one<any>('SELECT clock FROM companies WHERE id = ?', [company]));
      if (!c) throw new NotFound('company');
      if (c.clock >= DAYS * TICKS_PER_DAY) break;
      last = await this.tick(company);
    }
    return last;
  }
  /** Run until the start of the next business day. */
  async runDay(company: string) {
    const c = await this.db.tx(null, (q) => companyRow(q, company));
    return this.run(company, TICKS_PER_DAY - (c.clock % TICKS_PER_DAY));
  }

  /** The role runtime: own inbox, own memory, own status. A faulted or paused role simply gets no turn. */
  private async runRole(company: string, role: Role, clock: number, policies: Policies, phase: number): Promise<string> {
    const db = this.db;
    const a = await db.tx(null, (q) => q.one<any>('SELECT * FROM agents WHERE company = ? AND role = ?', [company, role]));
    if (a.status !== 'running') { await db.tx(company, (q) => advancePhase(q, company, clock, phase)); return a.status; }
    const rows = await db.tx(null, (q) => q.all<any>(`SELECT t.source_seq AS seq, t.kind, t.subject, t.created_at, e.payload FROM agent_tasks t
      JOIN events e ON e.company = t.company AND e.seq = t.source_seq WHERE t.company = ? AND t.role = ? AND t.status = 'queued' ORDER BY t.source_seq LIMIT 400`, [company, role]));
    const tasks: Task[] = rows.map((r) => ({ seq: r.seq, kind: r.kind, subject: r.subject, created_at: r.created_at, payload: JSON.parse(r.payload) }));
    let plan = '';
    const acks: number[] = [];
    const turn: Turn = {
      role, company, clock, policies, mem: JSON.parse(a.memory), tasks,
      exec: (cmd, params, why, causation) => exec(db, company, role, HANDLERS, cmd, params, why, causation ?? null),
      // Acknowledgements are batched and written with the end-of-turn checkpoint. A crash loses them, so delivery is
      // at-least-once: the redelivered tasks hit idempotent commands and are refused as duplicates.
      done: async (task) => { acks.push(task.seq); },
      read: (fn) => db.tx(null, fn),
      checkpoint: (label) => { if (a.fault_mode === 'crash_mid_turn') throw new InjectedFault(`injected crash at "${label}"`); },
      plan: (text) => { plan = text; },
    };
    try {
      await POLICIES[role](turn);
      if (a.fault_mode === 'crash_mid_turn') throw new InjectedFault('injected crash at end of turn');
    } catch (e) {
      const reason = e instanceof InjectedFault ? e.message : `unhandled ${(e as Error).name}: ${(e as Error).message}`.slice(0, 300);
      // A crashed process keeps nothing in memory: the turn's beliefs are lost; committed commands stay committed.
      await db.tx(company, async (q) => {
        await q.run("UPDATE agents SET status = 'faulted', fault_reason = ?, last_turn = ?, turns = turns + 1, version = version + 1 WHERE company = ? AND role = ?", [reason, clock, company, role]);
        const ctx = new Ctx(q, company, clock, 'system', 0);
        await ctx.emit('AgentFailed', role, `${role} runtime crashed: ${reason} (recorded by the runtime; no other agent is notified)`, { role, reason, queued: tasks.length });
        await advancePhase(q, company, clock, phase);
      });
      if (!(e instanceof InjectedFault)) console.error(`[firmhand] ${role} turn failed: ${(e as Error).stack}`);
      return 'faulted';
    }
    await db.tx(company, async (q) => {
      for (let i = 0; i < acks.length; i += 200) {
        const part = acks.slice(i, i + 200);
        await q.run(`UPDATE agent_tasks SET status = 'done', done_at = ? WHERE company = ? AND role = ? AND status = 'queued' AND source_seq IN (${part.map(() => '?').join(',')})`, [clock, company, role, ...part]);
      }
      await q.run('UPDATE agents SET memory = ?, plan = ?, last_turn = ?, turns = turns + 1 WHERE company = ? AND role = ?', [JSON.stringify(turn.mem), plan, clock, company, role]);
      await advancePhase(q, company, clock, phase);
    });
    return 'ran';
  }

  // ------------------------------------------------------------------ operator controls (the human's only levers)
  decide(company: string, approvalId: string, approve: boolean, hash: string, note = '') {
    return this.serial(company, () => this.db.tx(company, async (q) => {
      const c = await companyRow(q, company);
      const a = await q.one<any>('SELECT * FROM approvals WHERE company = ? AND id = ?', [company, approvalId]);
      if (!a) throw new NotFound('approval');
      if (a.status !== 'pending') throw new Rejected(`${approvalId} is ${a.status}; only a pending request can be decided`);
      if (c.clock > a.expires_at) throw new Rejected(`${approvalId} has expired`);
      if (hash !== a.hash) throw new Rejected('the request changed since you viewed it; reload and decide again');
      await q.run('UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, decided_real = ?, outcome = ? WHERE company = ? AND id = ? AND status = ?',
        [approve ? 'approved' : 'denied', 'operator (demo role, not an authenticated identity)', c.clock, Date.now(), note.slice(0, 200), company, approvalId, 'pending']);
      const ctx = new Ctx(q, company, c.clock, 'operator', c.seed);
      await ctx.emit(approve ? 'ApprovalGranted' : 'ApprovalDenied', approvalId, `Human ${approve ? 'approved' : 'denied'} ${approvalId}: ${a.summary}`, { approval: approvalId, kind: a.kind, params: JSON.parse(a.params) }, null, a.requester);
      return { id: approvalId, status: approve ? 'approved' : 'denied' };
    }));
  }

  setPaused(company: string, role: Role, paused: boolean) {
    return this.serial(company, () => this.db.tx(company, async (q) => {
      const c = await companyRow(q, company);
      const a = await q.one<any>('SELECT status FROM agents WHERE company = ? AND role = ?', [company, role]);
      if (a.status === 'faulted') throw new Rejected(`${role} has faulted; it restarts only through a human-approved recovery`);
      if ((a.status === 'paused') === paused) throw new Rejected(`${role} is already ${a.status}`);
      await q.run('UPDATE agents SET status = ?, version = version + 1 WHERE company = ? AND role = ?', [paused ? 'paused' : 'running', company, role]);
      await new Ctx(q, company, c.clock, 'operator', c.seed).emit(paused ? 'AgentPaused' : 'AgentResumed', role, `Operator ${paused ? 'paused' : 'resumed'} ${role}; the other agents keep running`, { role });
      return { role, status: paused ? 'paused' : 'running' };
    }));
  }

  inject(company: string, kind: ScenarioKind) {
    if (!SCENARIOS.includes(kind)) throw new Rejected('unknown scenario');
    return this.serial(company, () => this.db.tx(company, async (q) => {
      const c = await companyRow(q, company);
      if (c.clock >= DAYS * TICKS_PER_DAY) throw new Rejected('the week is complete');
      const scen: Scenario[] = JSON.parse(c.scenarios);
      if (scen.filter((s: any) => !s.done).length >= 6) throw new Rejected('too many scenarios queued');
      // Takes effect in the world phase of the next hour (or this hour if its world phase has not yet run).
      const at = c.phase === 0 ? c.clock : c.clock + 1;
      scen.push({ at, kind, by: 'operator' });
      await q.run('UPDATE companies SET scenarios = ? WHERE id = ?', [JSON.stringify(scen), company]);
      await new Ctx(q, company, c.clock, 'operator', c.seed).emit('ScenarioScheduled', kind, `Operator scheduled "${kind}" for ${fmtClock(at)}`, { kind, at });
      return { kind, at };
    }));
  }

  // ------------------------------------------------------------------ read models
  async state(company: string) {
    return this.db.tx(null, async (q) => {
      const c = await companyRow(q, company);
      const agents = await q.all<any>('SELECT role, status, fault_mode, fault_reason, plan, last_turn, last_progress, turns, committed, rejected, escalated, memory FROM agents WHERE company = ? ORDER BY role', [company]);
      const queued = await q.all<any>("SELECT role, COUNT(*) AS n, MIN(created_at) AS oldest FROM agent_tasks WHERE company = ? AND status = 'queued' GROUP BY role", [company]);
      const decisions: Record<string, any[]> = {};
      for (const r of ROLES) decisions[r] = (await q.all<any>('SELECT * FROM decisions WHERE company = ? AND role = ? ORDER BY id DESC LIMIT 8', [company, r])).map(dec);
      const kpis = await computeKpis(q, company);
      const checks = await reconcile(q, company);
      return {
        company: { id: company, name: COMPANY.name, note: COMPANY.note, seed: c.seed, clock: c.clock, phase: c.phase, day: dayOf(Math.min(c.clock, DAYS * TICKS_PER_DAY - 1)), label: c.clock >= DAYS * TICKS_PER_DAY ? 'Week complete' : fmtClock(c.clock),
          complete: c.clock >= DAYS * TICKS_PER_DAY, version: c.version, seq: (await q.one<any>('SELECT ev_seq FROM companies WHERE id = ?', [company])).ev_seq,
          policies: JSON.parse(c.policies), scenarios: JSON.parse(c.scenarios), freeze: JSON.parse(c.world).freeze, surge: JSON.parse(c.world).surge },
        agents: agents.map((a) => ({ ...a, memory: JSON.parse(a.memory), queued: Number(queued.find((x) => x.role === a.role)?.n ?? 0), oldestQueued: queued.find((x) => x.role === a.role)?.oldest ?? null, decisions: decisions[a.role] })),
        kpis, checks,
        flow: {
          leads: Number((await q.one<any>('SELECT COUNT(*) AS n FROM leads WHERE company = ?', [company])).n),
          quotes: Number((await q.one<any>('SELECT COUNT(*) AS n FROM quotes WHERE company = ?', [company])).n),
          orders: Object.fromEntries((await q.all<any>('SELECT status, COUNT(*) AS n FROM orders WHERE company = ? GROUP BY status', [company])).map((r) => [r.status, Number(r.n)])),
        },
        approvals: (await q.all<any>("SELECT * FROM approvals WHERE company = ? ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, requested_at DESC LIMIT 20", [company])).map(appr),
        incidents: (await q.all<any>('SELECT * FROM incidents WHERE company = ? ORDER BY opened_at DESC LIMIT 20', [company])).map((i) => ({ ...i, detail: JSON.parse(i.detail) })),
        inventory: await q.all<any>('SELECT i.sku, p.name, p.price, i.on_hand, i.reserved, i.value_cents FROM inventory i JOIN products p ON p.company = i.company AND p.sku = i.sku WHERE i.company = ? ORDER BY i.sku', [company]),
        purchases: await q.all<any>('SELECT * FROM purchase_orders WHERE company = ? ORDER BY proposed_at DESC, id DESC LIMIT 12', [company]),
        series: (await q.all<any>('SELECT clock, kpis FROM tick_metrics WHERE company = ? ORDER BY clock', [company])).map((r) => ({ clock: r.clock, ...pickSeries(JSON.parse(r.kpis)) })),
        days: (await q.all<any>('SELECT day, seq, checks, checksum FROM snapshots WHERE company = ? ORDER BY day', [company])).map((d) => ({ day: d.day, seq: d.seq, checksum: d.checksum, checks: JSON.parse(d.checks) })),
        // Payload without the replay facts: the narration needs fields like the closed day and its checksum.
        events: (await q.all<any>('SELECT seq, at, type, actor, subject, causation, summary, payload FROM events WHERE company = ? ORDER BY seq DESC LIMIT 80', [company]))
          .reverse().map(({ payload, ...ev }) => { const { facts: _f, ...rest } = JSON.parse(payload); return { ...ev, payload: rest }; }),
      };
    });
  }

  async eventsAfter(company: string, after: number, limit = 300) {
    return this.db.tx(null, (q) => q.all<any>('SELECT seq, at, type, actor, subject, causation, idem, version, summary, payload FROM events WHERE company = ? AND seq > ? ORDER BY seq LIMIT ?', [company, after, Math.min(1000, limit)]))
      .then((rows) => rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) })));
  }

  async decisions(company: string, role: Role | null, limit = 50, before?: number) {
    return this.db.tx(null, (q) => q.all<any>(`SELECT * FROM decisions WHERE company = ?${role ? ' AND role = ?' : ''}${before ? ' AND id < ?' : ''} ORDER BY id DESC LIMIT ?`,
      [company, ...(role ? [role] : []), ...(before ? [before] : []), Math.min(200, limit)])).then((r) => r.map(dec));
  }

  /** Follow one record through every role: events about it and the decisions that touched it. */
  async trace(company: string, subject: string) {
    return this.db.tx(null, async (q) => {
      const events = await q.all<any>('SELECT seq, at, type, actor, summary, payload FROM events WHERE company = ? AND (subject = ? OR payload LIKE ?) ORDER BY seq LIMIT 200', [company, subject, `%"${subject}"%`]);
      const decisions = await q.all<any>('SELECT * FROM decisions WHERE company = ? AND params LIKE ? ORDER BY id LIMIT 200', [company, `%"${subject}"%`]);
      const journal = await q.all<any>("SELECT j.id, j.at, j.memo, j.actor, j.event_seq, l.account, l.debit, l.credit FROM journal_entries j JOIN journal_lines l ON l.company = j.company AND l.entry_id = j.id WHERE j.company = ? AND j.source_id = ? ORDER BY j.at, j.id, l.line", [company, subject]);
      return { subject, events: events.map((e) => ({ ...e, payload: JSON.parse(e.payload) })), decisions: decisions.map(dec), journal };
    });
  }

  /** The records behind one KPI. */
  async sources(company: string, key: string) {
    const accountFor: Record<string, string[]> = { recognizedRevenue: [A.REVENUE], cash: [A.CASH], cogs: [A.COGS], refundsAndCredits: [A.REFUNDS], customerDeposits: [A.DEPOSITS],
      inventoryValue: [A.INVENTORY], operatingCosts: [A.SHIPPING, A.ADS, A.STAFF], netIncome: [A.REVENUE, A.REFUNDS, A.COGS, A.SHIPPING, A.ADS, A.STAFF], grossProfit: [A.REVENUE, A.REFUNDS, A.COGS] };
    return this.db.tx(null, async (q) => {
      if (accountFor[key]) {
        const ph = accountFor[key].map(() => '?').join(',');
        const lines = await q.all<any>(`SELECT j.id, j.at, j.memo, j.actor, j.event_seq, l.account, l.debit, l.credit FROM journal_lines l JOIN journal_entries j ON j.company = l.company AND j.id = l.entry_id
          WHERE l.company = ? AND l.account IN (${ph}) ORDER BY j.at DESC, j.id DESC LIMIT 400`, [company, ...accountFor[key]]);
        return { key, kind: 'journal', accounts: accountFor[key], rows: lines };
      }
      const clockNow = Number((await q.one<any>('SELECT clock FROM companies WHERE id = ?', [company])).clock);
      const orderSql: Record<string, string> = {
        bookedValue: "status IS NOT NULL", backlogValue: "status IN ('placed','reserved','backordered','packed')", backlogOrders: "status IN ('placed','reserved','backordered','packed')",
        fulfilled: "status IN ('shipped','delivered')", brokenPromises: `status <> 'cancelled' AND ((shipped_at IS NOT NULL AND shipped_at > promised_tick) OR (shipped_at IS NULL AND ${clockNow} > promised_tick))`,
        lateVsOriginal: `status <> 'cancelled' AND ((shipped_at IS NOT NULL AND shipped_at > original_promise) OR (shipped_at IS NULL AND ${clockNow} > original_promise))`,
        renegotiated: 'notified = 1',
        backordered: "status = 'backordered'", lateCancellations: "status = 'cancelled' AND cancel_requested = 1", cashCollected: 'paid > 0',
      };
      if (orderSql[key]) return { key, kind: 'orders', rows: await q.all<any>(`SELECT o.id, o.customer, o.status, o.total, o.paid, o.placed_at, o.promised_tick, o.original_promise, o.shipped_at, o.notified, l.sku, l.qty
        FROM orders o JOIN order_lines l ON l.company = o.company AND l.order_id = o.id AND l.line = 1 WHERE o.company = ? AND ${orderSql[key]} ORDER BY o.placed_at DESC, o.id DESC LIMIT 400`, [company]) };
      const customerSql: Record<string, string> = { customersActive: "status = 'active'", customersAtRisk: "status = 'at_risk'", customersChurned: "status = 'churned'", customersTotal: '1 = 1' };
      if (customerSql[key]) return { key, kind: 'customers', rows: await q.all<any>(`SELECT id, name, kind, status, satisfaction, patience, orders FROM customers WHERE company = ? AND ${customerSql[key]} ORDER BY status DESC, id`, [company]) };
      throw new NotFound(`no source view for ${key}`);
    });
  }

  async checksumNow(company: string) { return this.db.tx(null, async (q) => checksum(await liveState(q, company))); }
  async digest(company: string) {
    return this.db.tx(null, async (q) => {
      const parts: string[] = [];
      for (const t of TABLES) parts.push(`${t}:${JSON.stringify(await q.all(`SELECT * FROM ${t} WHERE company = ? ORDER BY 1,2,3`, [company]))}`);
      parts.push(JSON.stringify(await q.one('SELECT clock, phase, version, ev_seq, world, scenarios FROM companies WHERE id = ?', [company])));
      return sha256(parts.join('|'));
    });
  }
}

function dec(d: any) { return { ...d, inputs: JSON.parse(d.inputs), params: JSON.parse(d.params) }; }
function appr(a: any) { return { ...a, params: JSON.parse(a.params), bound: JSON.parse(a.bound), evidence: JSON.parse(a.evidence) }; }
function pickSeries(k: any) {
  return { revenue: k.recognizedRevenue, booked: k.bookedValue, cash: k.cash, costs: k.cogs + k.operatingCosts, netIncome: k.netIncome, backlog: k.backlogOrders,
    broken: k.brokenPromises, churned: k.customersChurned, atRisk: k.customersAtRisk };
}
export type { Q };
