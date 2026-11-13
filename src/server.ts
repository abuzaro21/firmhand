// HTTP API + static cockpit. Each visitor gets an isolated synthetic company, identified by an HttpOnly cookie; the
// database stores only a hash of the token. The browser is an operator console: it can ask the scheduler to advance
// time and can answer approvals, but it can never write a business record, choose an actor, or supply a clock.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import type { Engine } from './engine.ts';
import { NotFound, Rejected } from './kernel.ts';
import { CAPABILITIES, COMPANY, DAYS, POLICY, PRODUCTS, SCENARIOS, SUBSCRIPTIONS, SUPPLIERS, TICKS_PER_DAY, isRole, type ScenarioKind } from './model.ts';
import { replayChecksum, replayDay } from './replay.ts';
import { COMPARISONS, compare, type ComparisonKind } from './compare.ts';

export type AppOptions = {
  engine: Engine; publicDir?: string; trustProxyHops?: number; maxCompanies?: number; idleMs?: number;
  rateLimit?: number; companiesPerMinute?: number; ticksPerMinute?: number; secureCookie?: boolean;
};

/** Seeds a visitor can pick. Comparisons are precomputed for these, so no request can start unbounded work. */
export const SEEDS = [7, 11, 23, 42, 101] as const;

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8' };
const SECURITY = {
  'content-security-policy': "default-src 'self'; img-src 'self' data:; font-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'",
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()', 'cross-origin-opener-policy': 'same-origin', 'cross-origin-resource-policy': 'same-origin',
};
const COOKIE = 'firmhand_sid';
const ID = /^[A-Za-z0-9_-]{1,40}$/;

export function createApp(o: AppOptions) {
  const e = o.engine;
  const publicDir = resolve(o.publicDir ?? 'public');
  const maxCompanies = o.maxCompanies ?? 400;
  const idleMs = o.idleMs ?? 2 * 3600_000;
  // One admission at a time per process: counting companies and creating one must not interleave.
  let gate: Promise<unknown> = Promise.resolve();
  const admit = <T>(fn: () => Promise<T>): Promise<T> => { const p = gate.then(fn, fn); gate = p.catch(() => {}); return p; };
  const limit = o.rateLimit ?? 300; // requests per minute per client address
  const tickBudget = o.ticksPerMinute ?? 240; // simulated hours per minute per client address (a full week is 56)
  const hsts: Record<string, string> = o.secureCookie ? { 'strict-transport-security': 'max-age=31536000' } : {};
  const buckets = new Map<string, { n: number; reset: number; created: number; ticks: number }>();
  let lastSweep = 0;

  const clientIp = (req: IncomingMessage) => {
    const hops = o.trustProxyHops ?? 0;
    if (hops > 0) {
      const xff = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      if (xff.length >= hops) return xff[xff.length - hops];
    }
    return req.socket.remoteAddress ?? 'unknown';
  };
  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    const data = JSON.stringify(body);
    res.writeHead(status, { ...SECURITY, ...hsts, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
    res.end(data);
  };
  const readBody = (req: IncomingMessage): Promise<any> => new Promise((ok, fail) => {
    let size = 0; const chunks: Buffer[] = [];
    req.on('data', (d: Buffer) => { size += d.length; if (size > 16 * 1024) { fail(new Rejected('body too large')); req.destroy(); } else chunks.push(d); });
    req.on('end', () => {
      if (!chunks.length) return ok({});
      try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); ok(v && typeof v === 'object' && !Array.isArray(v) ? v : {}); } catch { fail(new Rejected('invalid JSON')); }
    });
    req.on('error', fail);
  });
  const token = (req: IncomingMessage) => String(req.headers.cookie ?? '').split(';').map((s) => s.trim()).find((s) => s.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  const cookie = (t: string) => `${COOKIE}=${t}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(idleMs / 1000)}${o.secureCookie ? '; Secure' : ''}`;
  const seedOf = (v: unknown) => (SEEDS.includes(Number(v) as any) ? Number(v) : SEEDS[0]);

  async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
    const path = url.pathname;
    const ip = clientIp(req);
    const now = Date.now();
    const b = buckets.get(ip) ?? { n: 0, reset: now + 60_000, created: 0, ticks: 0 };
    if (now > b.reset) { b.n = 0; b.created = 0; b.ticks = 0; b.reset = now + 60_000; }
    b.n++; buckets.set(ip, b);
    if (buckets.size > 20_000) buckets.clear();
    if (b.n > limit) return send(res, 429, { error: 'rate limited: slow down' }, { 'retry-after': '30' });
    if (now - lastSweep > 60_000) { lastSweep = now; e.expire(idleMs).catch(() => {}); }

    if (req.method === 'GET' && path === '/api/health') return send(res, 200, { ok: true, store: e.db.kind, companies: await e.count() });
    if (req.method === 'GET' && path === '/api/policy') {
      return send(res, 200, { company: COMPANY, policy: POLICY, capabilities: CAPABILITIES, subscriptions: SUBSCRIPTIONS, products: PRODUCTS, suppliers: SUPPLIERS,
        scenarios: SCENARIOS, seeds: SEEDS, week: { days: DAYS, ticksPerDay: TICKS_PER_DAY }, comparisons: Object.fromEntries(Object.entries(COMPARISONS).map(([k, v]) => [k, v.title])) });
    }
    const cmp = path.match(/^\/api\/compare\/([a-z-]+)$/);
    if (req.method === 'GET' && cmp) {
      if (!(cmp[1] in COMPARISONS)) throw new NotFound('comparison');
      return send(res, 200, await compare(cmp[1] as ComparisonKind, seedOf(url.searchParams.get('seed'))));
    }
    if (req.method === 'POST' && !String(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, { error: 'send application/json' });
    if (req.method !== 'GET' && req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });

    if (req.method === 'POST' && (path === '/api/session' || path === '/api/reset')) {
      const body = await readBody(req);
      const old = await e.resolve(token(req));
      if (path === '/api/session' && old) return send(res, 200, await e.state(old));
      // Admission is serialised (count, then create), so concurrent requests cannot all see spare capacity. Quota and
      // capacity are checked BEFORE anything is deleted: a refused reset leaves the visitor's company intact.
      const made = await admit(async () => {
        if (++b.created > (o.companiesPerMinute ?? 10)) return 429 as const;
        // Re-check inside the gate: a concurrent reset with the same cookie may already have replaced this company,
        // and a slot it no longer holds must not be counted as freed.
        const mine = old ? await e.resolve(token(req)) : null;
        const free = async () => (await e.count()) - (mine ? 1 : 0) < maxCompanies; // a reset frees its own slot
        if (!(await free())) { await e.expire(idleMs / 6); if (!(await free())) return 503 as const; }
        // Create the replacement first: if creation fails, the visitor keeps the company they had.
        const s = await e.create({ seed: seedOf(body.seed), storyline: body.storyline !== false });
        // If the old company cannot be deleted, undo the replacement so the visitor keeps exactly one company and no
        // capacity leaks. Should that undo also fail, the replacement has no cookie and idle expiry reclaims it.
        if (mine) {
          try { await e.drop(mine); } catch (err) { await e.drop(s.id).catch(() => {}); throw err; }
        }
        return s;
      });
      if (made === 429) return send(res, 429, { error: 'too many new companies from this address' });
      if (made === 503) return send(res, 503, { error: 'the demo is at capacity; try again shortly' });
      return send(res, 200, await e.state(made.id), { 'set-cookie': cookie(made.token) });
    }

    const co = await e.resolve(token(req));
    if (!co) return send(res, 401, { error: 'no-session' });
    const body = req.method === 'POST' ? await readBody(req) : {};
    const spend = (n: number) => { if ((b.ticks += n) > tickBudget) throw new Rejected('simulation budget for this minute used; wait a moment'); };

    if (req.method === 'GET' && path === '/api/state') return send(res, 200, await e.state(co));
    if (req.method === 'POST' && path === '/api/tick') {
      const n = Math.max(1, Math.min(TICKS_PER_DAY, Math.floor(Number(body.ticks ?? 1)) || 1));
      spend(n);
      await e.run(co, n);
      return send(res, 200, await e.state(co));
    }
    if (req.method === 'POST' && path === '/api/day') { spend(TICKS_PER_DAY); await e.runDay(co); return send(res, 200, await e.state(co)); }
    if (req.method === 'GET' && path === '/api/events') {
      const after = Math.max(0, Math.floor(Number(url.searchParams.get('after') ?? 0)) || 0);
      return send(res, 200, await e.eventsAfter(co, after, 300));
    }
    if (req.method === 'GET' && path === '/api/decisions') {
      const role = url.searchParams.get('role');
      if (role && !isRole(role)) throw new Rejected('unknown role');
      const before = Number(url.searchParams.get('before') ?? 0) || undefined;
      return send(res, 200, await e.decisions(co, (role as any) || null, 60, before));
    }
    const tr = path.match(/^\/api\/trace\/([^/]+)$/);
    if (req.method === 'GET' && tr) { if (!ID.test(tr[1])) throw new Rejected('bad id'); return send(res, 200, await e.trace(co, tr[1])); }
    const kp = path.match(/^\/api\/kpi\/([A-Za-z]+)$/);
    if (req.method === 'GET' && kp) return send(res, 200, await e.sources(co, kp[1]));
    const rp = path.match(/^\/api\/replay\/(\d)$/);
    if (req.method === 'GET' && rp) {
      const day = Number(rp[1]);
      if (day < 1 || day > DAYS) throw new Rejected('day out of range');
      // Observational: reads the event log only. The digest before and after is returned so the claim is checkable.
      // Run inside the company's serial lane so no concurrent tick can change the digest mid-measurement.
      const { r, before, after } = await e.serial(co, async () => {
        const before = await e.digest(co); const r = await replayDay(e.db, co, day); const after = await e.digest(co);
        return { r, before, after };
      });
      return send(res, 200, { ...r, sideEffects: { digestBefore: before.slice(0, 16), digestAfter: after.slice(0, 16), none: before === after } });
    }
    if (req.method === 'GET' && path === '/api/verify') {
      // Both sides inside the company's serial lane: a tick committing between the two reads would otherwise report a
      // false mismatch for perfectly consistent records.
      const { live, rep } = await e.serial(co, async () => ({ live: await e.checksumNow(co), rep: await replayChecksum(e.db, co) }));
      return send(res, 200, { live, replay: rep.checksum, match: live === rep.checksum });
    }
    const ap = path.match(/^\/api\/approvals\/([A-Za-z0-9-]{1,20})$/);
    if (req.method === 'POST' && ap) {
      if (typeof body.approve !== 'boolean') throw new Rejected('approve must be true or false');
      if (typeof body.hash !== 'string' || !/^[0-9a-f]{64}$/.test(body.hash)) throw new Rejected('the approval hash you were shown is required');
      await e.decide(co, ap[1], body.approve, body.hash, typeof body.note === 'string' ? body.note : '');
      return send(res, 200, await e.state(co));
    }
    const ag = path.match(/^\/api\/agents\/([a-z]+)\/(pause|resume)$/);
    if (req.method === 'POST' && ag) {
      if (!isRole(ag[1])) throw new Rejected('unknown role');
      await e.setPaused(co, ag[1], ag[2] === 'pause');
      return send(res, 200, await e.state(co));
    }
    const sc = path.match(/^\/api\/scenario\/([a-z-]+)$/);
    if (req.method === 'POST' && sc) {
      if (!SCENARIOS.includes(sc[1] as ScenarioKind)) throw new Rejected('unknown scenario');
      await e.inject(co, sc[1] as ScenarioKind);
      return send(res, 200, await e.state(co));
    }
    return send(res, 404, { error: 'not found' });
  }

  async function serveStatic(req: IncomingMessage, res: ServerResponse, path: string) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
    let rel: string;
    try { rel = decodeURIComponent(path); } catch { return send(res, 400, { error: 'bad path' }); }
    if (rel.includes('\\')) return send(res, 400, { error: 'bad path' });
    let file = resolve(publicDir, '.' + rel);
    // Path-component containment, not a string prefix: "public-backup" is not inside "public".
    const inside = relative(publicDir, file);
    if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside) || rel.includes(String.fromCharCode(0))) return send(res, 400, { error: 'bad path' });
    try { if ((await stat(file)).isDirectory()) file = join(file, 'index.html'); } catch { file = join(publicDir, 'index.html'); }
    try {
      const data = await readFile(file);
      const immutable = file.includes(`${normalize('/assets/')}`);
      res.writeHead(200, { ...SECURITY, ...hsts, 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch { send(res, 404, { error: 'UI not built: run npm run build' }); }
  }

  const server = createServer(async (req, res) => {
    let path = '/';
    try {
      let url: URL;
      try { url = new URL(req.url ?? '/', 'http://x'); } catch { throw new Rejected('malformed request target'); }
      path = url.pathname;
      if (path.startsWith('/api/')) await api(req, res, url);
      else await serveStatic(req, res, path);
    } catch (err) {
      const status = err instanceof Rejected ? 400 : err instanceof NotFound ? 404 : 500;
      if (status === 500) console.error(`[firmhand] ${req.method} ${path} failed: ${(err as Error).name}: ${(err as Error).message}`);
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'internal error' : (err as Error).message });
      else res.end();
    }
  });
  return { server };
}

/** Warm the default seed's comparisons in the background; other seeds compute on first request and are cached. */
export async function prewarm() {
  for (const k of Object.keys(COMPARISONS) as ComparisonKind[]) await compare(k, SEEDS[0]).catch(() => {});
}
