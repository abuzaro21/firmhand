// Shared fixtures. Tests run on SQLite by default; set FIRMHAND_TEST_PG to a PostgreSQL URL to run the same suite on
// PostgreSQL (each test database gets its own schema, dropped afterwards).
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { PgDb, SqliteDb, type Db } from '../src/db.ts';
import { Engine, type CreateOpts } from '../src/engine.ts';
import { HANDLERS } from '../src/commands.ts';
import { exec } from '../src/kernel.ts';
import type { Role } from '../src/model.ts';

export const PG_URL = process.env.FIRMHAND_TEST_PG ?? '';
const schemas: string[] = [];

export async function newDb(file?: string): Promise<Db> {
  if (PG_URL) {
    const schema = file ?? `t_${randomBytes(5).toString('hex')}`;
    schemas.push(schema);
    return PgDb.open(PG_URL, schema);
  }
  return new SqliteDb(file ?? ':memory:');
}
/** A durable location that survives closing the database (for restart tests). */
export const durableName = () => (PG_URL ? `t_${randomBytes(5).toString('hex')}` : join(tmpdir(), `firmhand-test-${randomBytes(5).toString('hex')}.db`));

export async function dropSchemas() {
  if (!PG_URL || !schemas.length) return;
  const c = new pg.Client({ connectionString: PG_URL });
  await c.connect();
  for (const s of schemas.splice(0)) await c.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
  await c.end();
}

export async function company(opts: CreateOpts = {}, db?: Db) {
  const d = db ?? (await newDb());
  const e = new Engine(d);
  const { id, token } = await e.create(opts);
  return { db: d, e, id, token };
}

export const q1 = (db: Db, sql: string, p: unknown[] = []) => db.tx(null, (q) => q.one<any>(sql, p));
export const qa = (db: Db, sql: string, p: unknown[] = []) => db.tx(null, (q) => q.all<any>(sql, p));
export const run = (db: Db, id: string, role: Role, cmd: string, params: any) => exec(db, id, role, HANDLERS, cmd, params, { rule: 'test', text: 'test harness' });

/** A placed, paid order for `qty` × `sku`. The lead insert and quote acceptance stand in for the world phase (the
 *  customer side); every business step goes through the real command kernel under the real role. */
export async function placedOrder(db: Db, id: string, sku: string, qty: number, customer = 'R-01', discountBp = 0) {
  const n = Number((await q1(db, 'SELECT COUNT(*) AS n FROM leads WHERE company = ?', [id])).n) + 1;
  const lead = `L-T${n}`;
  const clock = Number((await q1(db, 'SELECT clock FROM companies WHERE id = ?', [id])).clock);
  await db.tx(id, (q) => q.run('INSERT INTO leads (company, id, customer, sku, qty, requested_discount_bp, at) VALUES (?,?,?,?,?,?,?)', [id, lead, customer, sku, qty, discountBp, clock]));
  const quote = await run(db, id, 'sales', 'IssueQuote', { lead, discount_bp: discountBp, promised_tick: clock + 16 });
  if (quote.outcome !== 'committed') return { lead, quote, order: null as string | null };
  await db.tx(id, (q) => q.run("UPDATE quotes SET status = 'accepted' WHERE company = ? AND id = ?", [id, quote.result.quote]));
  const o = await run(db, id, 'sales', 'PlaceOrder', { quote: quote.result.quote });
  const order = o.result.order as string;
  return { lead, quote, order };
}

export async function runWeek(e: Engine, id: string, autoApprove = true) {
  for (let t = 0; t < 56; t++) {
    await e.tick(id);
    if (!autoApprove) continue;
    for (const a of await qa(e.db, "SELECT id, hash FROM approvals WHERE company = ? AND status = 'pending'", [id])) await e.decide(id, a.id, true, a.hash);
  }
}
