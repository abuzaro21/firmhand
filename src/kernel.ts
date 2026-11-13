// The command kernel. Every business mutation goes through exec(): capability check against the executing role,
// one transaction under the company lock, typed records + journal + append-only event + inbox fan-out committed
// together, and a causal receipt (decision row) for every attempt — committed, rejected, escalated or duplicate.
import type { Db, Q } from './db.ts';
import { ACCOUNTS, CAPABILITIES, POLICY, SUBSCRIPTIONS, canon, sha256, type Actor, type Role } from './model.ts';

export class Rejected extends Error { override name = 'Rejected'; }
export class NotFound extends Error { override name = 'NotFound'; }
export class Duplicate extends Error { override name = 'Duplicate'; }
export class RoleViolation extends Error { override name = 'RoleViolation'; }
export class InjectedFault extends Error { override name = 'InjectedFault'; }
/** Thrown by a handler whose action crosses an authority threshold and carries no valid approval. */
export class NeedsApproval extends Error {
  override name = 'NeedsApproval';
  spec: ApprovalSpec;
  constructor(spec: ApprovalSpec) { super(`needs human approval: ${spec.summary}`); this.spec = spec; }
}
/** Thrown when a presented approval no longer matches the state it was granted against. */
export class StaleApproval extends Error { override name = 'StaleApproval'; approvalId: string; constructor(approvalId: string, msg: string) { super(msg); this.approvalId = approvalId; } }

export type Bound = [table: string, id: string, version: number][];
export type ApprovalSpec = { kind: string; params: Record<string, unknown>; bound: Bound; summary: string; evidence: Record<string, unknown>; threshold: string; idem: string };
export type Posting = [account: string, debit: number, credit: number];
export type Facts = { postings: { entry: string; lines: Posting[] }[]; stock: { sku: string; qty: number; reserved: number; value: number }[];
  orders: { id: string; status: string; total?: number }[]; customers: { id: string; status: string }[] };
const noFacts = (): Facts => ({ postings: [], stock: [], orders: [], customers: [] });
const hasFacts = (f: Facts) => f.postings.length + f.stock.length + f.orders.length + f.customers.length > 0;

export class Ctx {
  facts = noFacts();
  private pendingEntries: string[] = [];
  seqs: number[] = [];
  q: Q; company: string; clock: number; actor: Actor; seed: number; causation: number | null;
  constructor(q: Q, company: string, clock: number, actor: Actor, seed: number, causation: number | null = null) {
    this.q = q; this.company = company; this.clock = clock; this.actor = actor; this.seed = seed; this.causation = causation;
  }

  /** Append one event (with any facts recorded since the last emit) and fan it out to subscriber inboxes. */
  async emit(type: string, subject: string, summary: string, payload: Record<string, unknown> = {}, idem: string | null = null, to?: Role): Promise<number> {
    if (idem) {
      const dup = await this.q.one('SELECT seq FROM events WHERE company = ? AND idem = ?', [this.company, idem]);
      if (dup) throw new Duplicate(`event ${idem} already recorded`);
    }
    const c = await this.q.one<{ ev_seq: number; version: number }>('UPDATE companies SET ev_seq = ev_seq + 1, version = version + 1 WHERE id = ? RETURNING ev_seq, version', [this.company]);
    const seq = Number(c!.ev_seq); const version = Number(c!.version);
    const body = hasFacts(this.facts) ? { ...payload, facts: this.facts } : payload;
    await this.q.run('INSERT INTO events (company, seq, at, type, actor, subject, causation, idem, version, summary, payload) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [this.company, seq, this.clock, type, this.actor, subject, this.causation, idem, version, summary, JSON.stringify(body)]);
    for (const e of this.pendingEntries) await this.q.run('UPDATE journal_entries SET event_seq = ? WHERE company = ? AND id = ?', [seq, this.company, e]);
    this.pendingEntries = []; this.facts = noFacts();
    const roles = (to ? [to] : SUBSCRIPTIONS[type] ?? []).filter((r) => r !== this.actor); // an agent does not inbox its own events
    if (roles.length) await this.q.run(`INSERT INTO agent_tasks (company, role, source_seq, kind, subject, created_at) VALUES ${roles.map(() => '(?,?,?,?,?,?)').join(',')}`,
      roles.flatMap((r) => [this.company, r, seq, type, subject, this.clock]));
    this.seqs.push(seq);
    return seq;
  }

  /** Post one balanced journal entry. Its source key is unique: a retried posting is a Duplicate, never a second entry. */
  async post(sourceType: string, sourceId: string, kind: string, memo: string, lines: Posting[]) {
    const dr = lines.reduce((s, l) => s + l[1], 0); const cr = lines.reduce((s, l) => s + l[2], 0);
    if (dr !== cr || dr <= 0) throw new Error(`unbalanced journal entry ${sourceType}:${sourceId}:${kind} (${dr} != ${cr})`);
    for (const l of lines) if (!Number.isInteger(l[1]) || !Number.isInteger(l[2]) || l[1] < 0 || l[2] < 0) throw new Error('journal amounts must be non-negative integer cents');
    const known = Object.values(ACCOUNTS) as string[];
    for (const l of lines) if (!known.includes(l[0])) throw new Error(`unknown account ${l[0]}`);
    if (await this.q.one('SELECT 1 AS x FROM journal_entries WHERE company = ? AND source_type = ? AND source_id = ? AND kind = ?', [this.company, sourceType, sourceId, kind]))
      throw new Duplicate(`journal entry ${sourceType}:${sourceId}:${kind} already posted`);
    const id = `JE-${sourceType}-${sourceId}-${kind}`;
    await this.q.run('INSERT INTO journal_entries (company, id, at, memo, source_type, source_id, kind, actor, event_seq) VALUES (?,?,?,?,?,?,?,?,?)',
      [this.company, id, this.clock, memo, sourceType, sourceId, kind, this.actor, -1]);
    await this.q.run(`INSERT INTO journal_lines (company, entry_id, line, account, debit, credit) VALUES ${lines.map(() => '(?,?,?,?,?,?)').join(',')}`,
      lines.flatMap(([account, d, c], i) => [this.company, id, i + 1, account, d, c]));
    // Overdraft invariant: no posting may leave Cash below zero.
    if (lines.some((l) => l[0] === ACCOUNTS.CASH && l[2] > 0) && (await this.balance(ACCOUNTS.CASH)) < 0) throw new Rejected(`overdraft: ${memo} would take cash below zero`);
    this.pendingEntries.push(id);
    this.facts.postings.push({ entry: id, lines });
  }

  async balance(account: string): Promise<number> {
    const r = await this.q.one<{ d: number | null; c: number | null }>('SELECT SUM(debit) AS d, SUM(credit) AS c FROM journal_lines WHERE company = ? AND account = ?', [this.company, account]);
    return Number(r?.d ?? 0) - Number(r?.c ?? 0);
  }

  /** Move stock. Constraint-checked conditional update: it cannot drive on-hand or reserved negative or over-reserve. */
  async stock(sku: string, qty: number, reserved: number, value: number, kind: string, ref: string) {
    const n = await this.q.run(`UPDATE inventory SET on_hand = on_hand + ?, reserved = reserved + ?, value_cents = value_cents + ?, version = version + 1
      WHERE company = ? AND sku = ? AND on_hand + ? >= 0 AND reserved + ? >= 0 AND reserved + ? <= on_hand + ? AND value_cents + ? >= 0`,
      [qty, reserved, value, this.company, sku, qty, reserved, reserved, qty, value]);
    if (n !== 1) throw new Rejected(`stock movement refused for ${sku}: would break on-hand/reserved limits`);
    const id = `MV-${await this.nextId('mv')}`;
    await this.q.run('INSERT INTO inventory_movements (company, id, sku, kind, qty_delta, reserved_delta, value_delta, ref, at, actor) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [this.company, id, sku, kind, qty, reserved, value, ref, this.clock, this.actor]);
    this.facts.stock.push({ sku, qty, reserved, value });
  }

  /** Change an order's status with an optimistic version check. */
  async orderStatus(id: string, from: string[], to: string, extra = '', extraParams: unknown[] = []) {
    const o = await this.q.one<{ status: string; version: number; total: number }>('SELECT status, version, total FROM orders WHERE company = ? AND id = ?', [this.company, id]);
    if (!o) throw new NotFound(`order ${id}`);
    if (!from.includes(o.status)) throw new Rejected(`order ${id} is ${o.status}, not ${from.join('/')}`);
    const n = await this.q.run(`UPDATE orders SET status = ?, version = version + 1${extra} WHERE company = ? AND id = ? AND version = ?`, [to, ...extraParams, this.company, id, o.version]);
    if (n !== 1) throw new Rejected(`order ${id} changed concurrently`);
    this.facts.orders.push({ id, status: to, total: o.total });
  }

  async customerStatus(id: string, status: string) {
    const c = await this.q.one<{ status: string }>('SELECT status FROM customers WHERE company = ? AND id = ?', [this.company, id]);
    if (!c || c.status === status) return;
    await this.q.run('UPDATE customers SET status = ? WHERE company = ? AND id = ?', [status, this.company, id]);
    this.facts.customers.push({ id, status });
  }

  /** Per-company counters for readable ids (O-12, PO-3 ...): one upsert, one round trip, inside the command's transaction. */
  async nextId(name: string): Promise<number> {
    const r = await this.q.one<{ n: number }>('INSERT INTO counters (company, name, n) VALUES (?, ?, 1) ON CONFLICT (company, name) DO UPDATE SET n = counters.n + 1 RETURNING n', [this.company, name]);
    return Number(r!.n);
  }

  flushCheck() { if (hasFacts(this.facts)) throw new Error('kernel bug: records changed without an event'); }
}

/** Approval binding: the hash covers the company, the action kind, canonical params, the versions of every record the
 *  decision depended on, and the policy version. Changing any of them yields a different hash. */
export const approvalHash = (company: string, kind: string, params: Record<string, unknown>, bound: Bound) =>
  sha256(`${company}|${kind}|${canon(params)}|${canon(bound)}|${POLICY.version}`);

export async function currentBound(q: Q, company: string, bound: Bound): Promise<Bound> {
  const out: Bound = [];
  for (const [table, id, _v] of bound) {
    const key = table === 'agents' ? 'role' : 'id';
    if (!['leads', 'orders', 'purchase_orders', 'agents'].includes(table)) throw new Error(`unbindable table ${table}`);
    const r = await q.one<{ version: number }>(`SELECT version FROM ${table} WHERE company = ? AND ${key} = ?`, [company, id]);
    out.push([table, id, r ? r.version : -1]);
  }
  return out;
}

/** Called by a handler for an action above its autonomous limit. Without a matching, approved, unexpired, unused
 *  approval for exactly these params against exactly these record versions, the action does not happen. */
export async function requireApproval(ctx: Ctx, role: Role, spec: ApprovalSpec, approvalId: unknown) {
  if (typeof approvalId !== 'string' || !approvalId) throw new NeedsApproval(spec);
  const a = await ctx.q.one<any>('SELECT * FROM approvals WHERE company = ? AND id = ?', [ctx.company, approvalId]);
  if (!a) throw new Rejected(`approval ${approvalId} does not exist in this company`);
  if (a.requester !== role) throw new Rejected(`approval ${approvalId} was requested by ${a.requester}, not ${role}`);
  if (a.kind !== spec.kind) throw new Rejected(`approval ${approvalId} is for ${a.kind}, not ${spec.kind}`);
  if (a.status === 'executed') throw new Rejected(`approval ${approvalId} was already used`);
  if (a.status !== 'approved') throw new Rejected(`approval ${approvalId} is ${a.status}`);
  if (ctx.clock > a.expires_at) throw new StaleApproval(approvalId, `approval ${approvalId} expired`);
  const presented = approvalHash(ctx.company, spec.kind, spec.params, JSON.parse(a.bound));
  if (presented !== a.hash) throw new Rejected(`approval ${approvalId} does not cover these parameters`);
  const now = await currentBound(ctx.q, ctx.company, JSON.parse(a.bound));
  if (canon(now) !== a.bound) throw new StaleApproval(approvalId, `records changed since approval ${approvalId} was granted`);
  const n = await ctx.q.run("UPDATE approvals SET status = 'executed', executed_at = ? WHERE company = ? AND id = ? AND status = 'approved'", [ctx.clock, ctx.company, approvalId]);
  if (n !== 1) throw new Rejected(`approval ${approvalId} was already used`);
}

export type Why = { rule: string; text: string; inputs?: Record<string, unknown> };
export type ExecResult = { outcome: 'committed' | 'rejected' | 'escalated' | 'duplicate'; result?: any; error?: string; approval?: string; approvalStatus?: string; seqs: number[] };
export type Handler = (ctx: Ctx, p: any, role: Role) => Promise<any>;

/** Load company basics for a command. */
export async function companyRow(q: Q, company: string) {
  const c = await q.one<any>('SELECT id, seed, clock, phase, version, policies, world, scenarios FROM companies WHERE id = ?', [company]);
  if (!c) throw new NotFound('company');
  return c;
}

/** The Gate. `role` is the executing agent's runtime identity, supplied by the scheduler, never by a client. */
export async function exec(db: Db, company: string, role: Role, handlers: Record<string, Handler>, cmd: string, params: any, why: Why, causation: number | null = null): Promise<ExecResult> {
  const record = async (q: Q, ctx: Ctx, outcome: ExecResult['outcome'], detail: string) => {
    await q.run('INSERT INTO decisions (company, id, role, at, rule, why, inputs, command, params, outcome, detail, first_seq, last_seq) SELECT ?, COALESCE(MAX(id), 0) + 1, ?,?,?,?,?,?,?,?,?,?,? FROM decisions WHERE company = ?',
      [company, role, ctx.clock, why.rule, why.text, JSON.stringify(why.inputs ?? {}), cmd, JSON.stringify(params ?? {}), outcome, detail, ctx.seqs[0] ?? null, ctx.seqs.at(-1) ?? null, company]);
    const col = outcome === 'committed' ? 'committed' : outcome === 'escalated' ? 'escalated' : outcome === 'rejected' ? 'rejected' : null;
    if (col) await q.run(`UPDATE agents SET ${col} = ${col} + 1${outcome === 'committed' ? ', last_progress = ?' : ''} WHERE company = ? AND role = ?`, outcome === 'committed' ? [ctx.clock, company, role] : [company, role]);
  };
  const failTx = (outcome: 'rejected' | 'duplicate', msg: string, emitRejection: boolean) => db.tx(company, async (q) => {
    const c = await companyRow(q, company);
    const ctx = new Ctx(q, company, c.clock, role, c.seed, causation);
    if (emitRejection) await ctx.emit('ActionRejected', cmd, `${role} ${cmd} rejected: ${msg}`, { command: cmd, reason: msg });
    await record(q, ctx, outcome, msg);
    return { outcome, error: msg, seqs: ctx.seqs } as ExecResult;
  });

  if (!CAPABILITIES[role].includes(cmd) || !handlers[cmd]) return failTx('rejected', `role violation: ${role} may not ${cmd}`, true);
  try {
    return await db.tx(company, async (q) => {
      const c = await q.one<any>('SELECT c.seed, c.clock, a.status AS agent_status FROM companies c LEFT JOIN agents a ON a.company = c.id AND a.role = ? WHERE c.id = ?', [role, company]);
      if (!c) throw new NotFound('company');
      if (c.agent_status !== 'running') throw new Rejected(`${role} is ${c.agent_status ?? 'missing'} and cannot act`);
      const ctx = new Ctx(q, company, c.clock, role, c.seed, causation);
      const result = await handlers[cmd](ctx, params ?? {}, role);
      ctx.flushCheck();
      await record(q, ctx, 'committed', typeof result?.detail === 'string' ? result.detail : '');
      return { outcome: 'committed', result, seqs: ctx.seqs } as ExecResult;
    });
  } catch (e) {
    if (e instanceof Duplicate) return failTx('duplicate', e.message, false);
    if (e instanceof NeedsApproval) return escalate(db, company, role, cmd, params, why, e.spec, causation, record);
    if (e instanceof StaleApproval) {
      return db.tx(company, async (q) => {
        const c = await companyRow(q, company);
        const ctx = new Ctx(q, company, c.clock, role, c.seed, causation);
        const n = await q.run("UPDATE approvals SET status = 'stale', outcome = ? WHERE company = ? AND id = ? AND status = 'approved'", [e.message, company, e.approvalId]);
        if (n) await ctx.emit('ApprovalStale', e.approvalId, `${e.approvalId} is stale: ${e.message}; ${role} will decide again`, { approval: e.approvalId, reason: e.message }, null, role);
        await record(q, ctx, 'rejected', e.message);
        return { outcome: 'rejected', error: e.message, seqs: ctx.seqs } as ExecResult;
      });
    }
    if (e instanceof Rejected || e instanceof NotFound) return failTx('rejected', e.message, true);
    // A unique-constraint violation is the database refusing a duplicate effect: report it as such.
    if (/UNIQUE|duplicate key/i.test(String((e as Error).message))) return failTx('duplicate', `duplicate refused by constraint: ${(e as Error).message.slice(0, 120)}`, false);
    if (/CHECK constraint|violates check constraint/i.test(String((e as Error).message))) return failTx('rejected', `refused by constraint: ${(e as Error).message.slice(0, 120)}`, true);
    throw e;
  }
}

async function escalate(db: Db, company: string, role: Role, cmd: string, params: any, why: Why, spec: ApprovalSpec, causation: number | null,
  record: (q: Q, ctx: Ctx, o: ExecResult['outcome'], d: string) => Promise<void>): Promise<ExecResult> {
  return db.tx(company, async (q) => {
    const c = await companyRow(q, company);
    const ctx = new Ctx(q, company, c.clock, role, c.seed, causation);
    const existing = await q.one<{ id: string; status: string }>('SELECT id, status FROM approvals WHERE company = ? AND idem = ?', [company, spec.idem]);
    if (existing) {
      await record(q, ctx, 'duplicate', `approval ${existing.id} already ${existing.status}`);
      // Report the existing request and its status (unless already used), so a requester whose memory was lost in a
      // crash can resume it: wait if pending, act on the recorded decision otherwise (see agents/continuations.ts).
      return { outcome: 'duplicate', approval: existing.status === 'executed' ? undefined : existing.id, approvalStatus: existing.status, seqs: [] } as ExecResult;
    }
    const n = await ctx.nextId('ap');
    const id = `AP-${n}`;
    const bound = await currentBound(q, company, spec.bound);
    const hash = approvalHash(company, spec.kind, spec.params, bound);
    await q.run(`INSERT INTO approvals (company, id, requester, kind, params, bound, hash, policy_version, summary, evidence, threshold, status, requested_at, expires_at, idem)
      VALUES (?,?,?,?,?,?,?,?,?,?,?, 'pending', ?, ?, ?)`,
      [company, id, role, spec.kind, canon(spec.params), canon(bound), hash, POLICY.version, spec.summary, JSON.stringify(spec.evidence), spec.threshold, c.clock, c.clock + POLICY.approvalTtlTicks, spec.idem]);
    await ctx.emit('EscalationRequested', id, `${role} asks a human: ${spec.summary}`, { approval: id, kind: spec.kind, params: spec.params, threshold: spec.threshold });
    await record(q, ctx, 'escalated', `${id}: ${spec.threshold}`);
    return { outcome: 'escalated', approval: id, seqs: ctx.seqs } as ExecResult;
  });
}
