// One SQL schema, two drivers: SQLite (node:sqlite) for local runs, tests and isolated baseline simulations; PostgreSQL
// for the hosted demo, whose web-service disk is ephemeral. Statements use `?`; the PostgreSQL driver rewrites them to
// $n. Every business command runs in one transaction that first locks the company row (FOR UPDATE on PostgreSQL; SQLite
// serialises all transactions on its single connection), so commands from different agents never interleave mid-write.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import pg from 'pg';

pg.types.setTypeParser(20, (v) => Number(v)); // BIGINT -> number (all our values are far below 2^53)

export interface Q {
  all<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T = any>(sql: string, params?: unknown[]): Promise<T | undefined>;
  run(sql: string, params?: unknown[]): Promise<number>;
}
export interface Db {
  readonly kind: 'sqlite' | 'postgres';
  tx<T>(lock: string | null, fn: (q: Q) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// Money: INTEGER cents. Time: INTEGER virtual ticks (1 tick = 1 business hour, 8 per day). Real time: BIGINT ms.
export const DDL = `
CREATE TABLE IF NOT EXISTS counters (company TEXT NOT NULL, name TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (company, name));
CREATE TABLE IF NOT EXISTS companies (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, seed INTEGER NOT NULL,
  clock INTEGER NOT NULL DEFAULT 0, phase INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 0,
  ev_seq INTEGER NOT NULL DEFAULT 0, policies TEXT NOT NULL, world TEXT NOT NULL, scenarios TEXT NOT NULL,
  created BIGINT NOT NULL, last_active BIGINT NOT NULL, lease_until BIGINT NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS agents (company TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE, role TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','paused','faulted')), fault_mode TEXT NOT NULL DEFAULT '',
  fault_reason TEXT NOT NULL DEFAULT '', memory TEXT NOT NULL, plan TEXT NOT NULL DEFAULT '',
  last_turn INTEGER NOT NULL DEFAULT -1, last_progress INTEGER NOT NULL DEFAULT 0, turns INTEGER NOT NULL DEFAULT 0,
  committed INTEGER NOT NULL DEFAULT 0, rejected INTEGER NOT NULL DEFAULT 0, escalated INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (company, role));
CREATE TABLE IF NOT EXISTS agent_tasks (company TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE, role TEXT NOT NULL,
  source_seq INTEGER NOT NULL, kind TEXT NOT NULL, subject TEXT NOT NULL, created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','done')), done_at INTEGER,
  PRIMARY KEY (company, role, source_seq));
CREATE INDEX IF NOT EXISTS agent_tasks_q ON agent_tasks (company, role, status, source_seq);
CREATE TABLE IF NOT EXISTS products (company TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE, sku TEXT NOT NULL,
  name TEXT NOT NULL, price INTEGER NOT NULL CHECK (price > 0), std_cost INTEGER NOT NULL CHECK (std_cost > 0),
  reorder_point INTEGER NOT NULL, target_stock INTEGER NOT NULL, PRIMARY KEY (company, sku));
CREATE TABLE IF NOT EXISTS inventory (company TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE, sku TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT 'main', on_hand INTEGER NOT NULL, reserved INTEGER NOT NULL DEFAULT 0,
  value_cents INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 0,
  CHECK (on_hand >= 0 AND reserved >= 0 AND reserved <= on_hand AND value_cents >= 0),
  PRIMARY KEY (company, sku));
CREATE TABLE IF NOT EXISTS inventory_movements (company TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  id TEXT NOT NULL, sku TEXT NOT NULL, kind TEXT NOT NULL, qty_delta INTEGER NOT NULL, reserved_delta INTEGER NOT NULL,
  value_delta INTEGER NOT NULL, ref TEXT NOT NULL, at INTEGER NOT NULL, actor TEXT NOT NULL, PRIMARY KEY (company, id));
CREATE TABLE IF NOT EXISTS suppliers (company TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE, id TEXT NOT NULL,
  name TEXT NOT NULL, lead_ticks INTEGER NOT NULL, cost_bp INTEGER NOT NULL, delay_ticks INTEGER NOT NULL DEFAULT 0, delay_sku TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'normal', PRIMARY KEY (company, id));
CREATE TABLE IF NOT EXISTS customers (company TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE, id TEXT NOT NULL,
  name TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('retail','cafe')), patience INTEGER NOT NULL,
  satisfaction INTEGER NOT NULL, status TEXT NOT NULL CHECK (status IN ('active','at_risk','churned')),
  orders INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (company, id));
CREATE TABLE IF NOT EXISTS leads (company TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE, id TEXT NOT NULL,
  customer TEXT NOT NULL, sku TEXT NOT NULL, qty INTEGER NOT NULL CHECK (qty > 0), requested_discount_bp INTEGER NOT NULL DEFAULT 0,
  at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','escalated','quoted','won','lost')),
  version INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (company, id),
  FOREIGN KEY (company, customer) REFERENCES customers(company, id), FOREIGN KEY (company, sku) REFERENCES products(company, sku));
CREATE TABLE IF NOT EXISTS quotes (company TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE, id TEXT NOT NULL,
  lead TEXT NOT NULL, customer TEXT NOT NULL, sku TEXT NOT NULL, qty INTEGER NOT NULL, unit_price INTEGER NOT NULL,
  discount_bp INTEGER NOT NULL CHECK (discount_bp >= 0 AND discount_bp <= 2500), total INTEGER NOT NULL CHECK (total >= 0),
  promised_tick INTEGER NOT NULL, status TEXT NOT NULL CHECK (status IN ('open','accepted','declined')),
  at INTEGER NOT NULL, approval_id TEXT, PRIMARY KEY (company, id), UNIQUE (company, lead),
  FOREIGN KEY (company, lead) REFERENCES leads(company, id));
CREATE TABLE IF NOT EXISTS orders (company TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE, id TEXT NOT NULL,
  quote TEXT NOT NULL, customer TEXT NOT NULL, total INTEGER NOT NULL CHECK (total >= 0), promised_tick INTEGER NOT NULL,
  original_promise INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('placed','reserved','backordered','packed','shipped','delivered','cancelled')),
  paid INTEGER NOT NULL DEFAULT 0, placed_at INTEGER NOT NULL, shipped_at INTEGER, delivered_at INTEGER,
  notified INTEGER NOT NULL DEFAULT 0, cancel_requested INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (company, id), UNIQUE (company, quote), FOREIGN KEY (company, quote) REFERENCES quotes(company, id));
CREATE TABLE IF NOT EXISTS order_lines (company TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE, order_id TEXT NOT NULL,
  line INTEGER NOT NULL, sku TEXT NOT NULL, qty INTEGER NOT NULL CHECK (qty > 0), unit_price INTEGER NOT NULL,
  discount_bp INTEGER NOT NULL, amount INTEGER NOT NULL, PRIMARY KEY (company, order_id, line),
  FOREIGN KEY (company, order_id) REFERENCES orders(company, id));
CREATE TABLE IF NOT EXISTS reservations (company TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE, id TEXT NOT NULL,
  order_id TEXT NOT NULL, sku TEXT NOT NULL, qty INTEGER NOT NULL CHECK (qty > 0),
  status TEXT NOT NULL CHECK (status IN ('active','consumed','released')), at INTEGER NOT NULL,
  PRIMARY KEY (company, id), UNIQUE (company, order_id, sku), FOREIGN KEY (company, order_id) REFERENCES orders(company, id));
CREATE TABLE IF NOT EXISTS shipments (company TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE, id TEXT NOT NULL,
  order_id TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('packed','dispatched','delivered')),
  cost_value INTEGER NOT NULL, packed_at INTEGER NOT NULL, dispatched_at INTEGER, delivered_at INTEGER,
  PRIMARY KEY (company, id), UNIQUE (company, order_id), FOREIGN KEY (company, order_id) REFERENCES orders(company, id));
CREATE TABLE IF NOT EXISTS purchase_orders (company TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE, id TEXT NOT NULL,
  supplier TEXT NOT NULL, sku TEXT NOT NULL, qty INTEGER NOT NULL CHECK (qty > 0), unit_cost INTEGER NOT NULL,
  total INTEGER NOT NULL CHECK (total > 0), kind TEXT NOT NULL CHECK (kind IN ('replenish','expedite')),
  status TEXT NOT NULL CHECK (status IN ('proposed','awaiting_approval','funded','declined','arrived','received')),
  eta_tick INTEGER, proposed_at INTEGER NOT NULL, funded_at INTEGER, received_at INTEGER, approval_id TEXT,
  reason TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (company, id));
CREATE TABLE IF NOT EXISTS payments (company TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE, id TEXT NOT NULL,
  order_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('capture','deposit_refund','credit')),
  amount INTEGER NOT NULL CHECK (amount > 0), idem TEXT NOT NULL, at INTEGER NOT NULL, approval_id TEXT,
  PRIMARY KEY (company, id), UNIQUE (company, idem), FOREIGN KEY (company, order_id) REFERENCES orders(company, id));
CREATE UNIQUE INDEX IF NOT EXISTS one_capture_per_order ON payments (company, order_id) WHERE kind = 'capture';
CREATE UNIQUE INDEX IF NOT EXISTS one_deposit_refund_per_order ON payments (company, order_id) WHERE kind = 'deposit_refund';
CREATE TABLE IF NOT EXISTS expenses (company TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE, id TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('shipping','advertising','staff')), amount INTEGER NOT NULL CHECK (amount > 0),
  ref TEXT NOT NULL, at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'paid', PRIMARY KEY (company, id));
CREATE TABLE IF NOT EXISTS journal_entries (company TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE, id TEXT NOT NULL,
  at INTEGER NOT NULL, memo TEXT NOT NULL, source_type TEXT NOT NULL, source_id TEXT NOT NULL, kind TEXT NOT NULL,
  actor TEXT NOT NULL, event_seq INTEGER NOT NULL, PRIMARY KEY (company, id), UNIQUE (company, source_type, source_id, kind));
CREATE TABLE IF NOT EXISTS journal_lines (company TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE, entry_id TEXT NOT NULL,
  line INTEGER NOT NULL, account TEXT NOT NULL, debit INTEGER NOT NULL CHECK (debit >= 0), credit INTEGER NOT NULL CHECK (credit >= 0),
  CHECK ((debit = 0) <> (credit = 0)), PRIMARY KEY (company, entry_id, line),
  FOREIGN KEY (company, entry_id) REFERENCES journal_entries(company, id));
CREATE INDEX IF NOT EXISTS journal_lines_acct ON journal_lines (company, account);
CREATE TABLE IF NOT EXISTS approvals (company TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE, id TEXT NOT NULL,
  requester TEXT NOT NULL, kind TEXT NOT NULL, params TEXT NOT NULL, bound TEXT NOT NULL, hash TEXT NOT NULL,
  policy_version TEXT NOT NULL, summary TEXT NOT NULL, evidence TEXT NOT NULL, threshold TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','denied','expired','executed','stale')),
  requested_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, decided_by TEXT, decided_at INTEGER, decided_real BIGINT,
  executed_at INTEGER, outcome TEXT NOT NULL DEFAULT '', idem TEXT NOT NULL, PRIMARY KEY (company, id), UNIQUE (company, idem));
CREATE TABLE IF NOT EXISTS incidents (company TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE, id TEXT NOT NULL,
  kind TEXT NOT NULL, severity TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('open','resolved')),
  opened_by TEXT NOT NULL, opened_at INTEGER NOT NULL, resolved_at INTEGER, resolved_by TEXT, summary TEXT NOT NULL,
  detail TEXT NOT NULL, human_needed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (company, id));
CREATE TABLE IF NOT EXISTS events (company TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE, seq INTEGER NOT NULL,
  at INTEGER NOT NULL, type TEXT NOT NULL, actor TEXT NOT NULL, subject TEXT NOT NULL, causation INTEGER,
  idem TEXT, version INTEGER NOT NULL, summary TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (company, seq));
CREATE UNIQUE INDEX IF NOT EXISTS events_idem ON events (company, idem) WHERE idem IS NOT NULL;
CREATE TABLE IF NOT EXISTS decisions (company TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE, id INTEGER NOT NULL,
  role TEXT NOT NULL, at INTEGER NOT NULL, rule TEXT NOT NULL, why TEXT NOT NULL, inputs TEXT NOT NULL, command TEXT NOT NULL,
  params TEXT NOT NULL, outcome TEXT NOT NULL CHECK (outcome IN ('committed','rejected','escalated','duplicate')),
  detail TEXT NOT NULL, first_seq INTEGER, last_seq INTEGER, PRIMARY KEY (company, id));
CREATE INDEX IF NOT EXISTS decisions_role ON decisions (company, role, id);
CREATE TABLE IF NOT EXISTS tick_metrics (company TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE, clock INTEGER NOT NULL,
  seq INTEGER NOT NULL, kpis TEXT NOT NULL, PRIMARY KEY (company, clock));
CREATE TABLE IF NOT EXISTS snapshots (company TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE, day INTEGER NOT NULL,
  seq INTEGER NOT NULL, kpis TEXT NOT NULL, checks TEXT NOT NULL, checksum TEXT NOT NULL, PRIMARY KEY (company, day));
`;

/** Every company-scoped table, children first (for deletes and digests). */
export const TABLES = ['snapshots', 'tick_metrics', 'decisions', 'events', 'incidents', 'approvals', 'journal_lines', 'journal_entries',
  'expenses', 'payments', 'purchase_orders', 'shipments', 'reservations', 'order_lines', 'orders', 'quotes', 'leads', 'customers',
  'suppliers', 'inventory_movements', 'inventory', 'products', 'agent_tasks', 'agents', 'counters'] as const;

export class SqliteDb implements Db {
  readonly kind = 'sqlite' as const;
  private db: DatabaseSync;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode = ${path === ':memory:' ? 'MEMORY' : 'WAL'}; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;`);
    this.db.exec(DDL);
  }
  tx<T>(_lock: string | null, fn: (q: Q) => Promise<T>): Promise<T> {
    const run = async () => {
      const db = this.db;
      const all = async (sql: string, p: unknown[] = []) => db.prepare(sql).all(...(p as any[])) as any[];
      const q: Q = {
        all,
        one: async (sql, p = []) => db.prepare(sql).get(...(p as any[])) as any,
        run: async (sql, p = []) => Number(db.prepare(sql).run(...(p as any[])).changes),
      };
      db.exec('BEGIN IMMEDIATE');
      try { const r = await fn(q); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }
  async close() { await this.chain; this.db.close(); }
}

export class PgDb implements Db {
  readonly kind = 'postgres' as const;
  private pool: pg.Pool;
  private constructor(pool: pg.Pool) { this.pool = pool; }
  static async open(url: string, schema = 'firmhand') {
    if (!/^[a-z_][a-z0-9_]{0,40}$/.test(schema)) throw new Error('bad schema name');
    const pool = new pg.Pool({ connectionString: url, max: 5, ssl: /sslmode=require|render\.com/.test(url) ? { rejectUnauthorized: false } : undefined,
      options: `-c search_path=${schema}` });
    const c = await pool.connect();
    try {
      await c.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
      await c.query(`SET search_path TO ${schema}`);
      await c.query('SELECT pg_advisory_lock(424242)'); // two instances booting at once must not race the DDL
      try { await c.query(DDL); } finally { await c.query('SELECT pg_advisory_unlock(424242)'); }
    } finally { c.release(); }
    return new PgDb(pool);
  }
  async tx<T>(lock: string | null, fn: (q: Q) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    const conv = (sql: string) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };
    const all = async (sql: string, p: unknown[] = []) => (await c.query(conv(sql), p)).rows;
    const q: Q = { all, one: async (sql, p = []) => (await all(sql, p))[0], run: async (sql, p = []) => (await c.query(conv(sql), p)).rowCount ?? 0 };
    try {
      if (lock) {
        if (!/^co_[0-9a-f]{16}$/.test(lock)) throw new Error('bad company id');
        await c.query(`BEGIN; SELECT 1 FROM companies WHERE id = '${lock}' FOR UPDATE`);
      } else await c.query('BEGIN');
      const r = await fn(q);
      await c.query('COMMIT');
      return r;
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  }
  async close() { await this.pool.end(); }
}

export async function openDb(): Promise<Db> {
  const url = process.env.DATABASE_URL;
  if (url) return PgDb.open(url, process.env.FIRMHAND_PG_SCHEMA ?? 'firmhand');
  return new SqliteDb(process.env.FIRMHAND_DB ?? 'data/firmhand.db');
}
