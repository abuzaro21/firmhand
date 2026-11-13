// The HTTP boundary: per-visitor isolation, no forged events, backend-enforced approvals, rate limits, safe static serving.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { Engine } from '../src/engine.ts';
import { createApp } from '../src/server.ts';
import { dropSchemas, newDb } from './helpers.ts';

let base = '';
let close: () => Promise<void> = async () => {};
const pub = join(tmpdir(), `firmhand-pub-${randomBytes(4).toString('hex')}`);
before(async () => {
  mkdirSync(join(pub, 'assets'), { recursive: true });
  writeFileSync(join(pub, 'index.html'), '<!doctype html><title>t</title>');
  writeFileSync(join(pub, 'assets', 'a.js'), 'x');
  const db = await newDb();
  const { server } = createApp({ engine: new Engine(db), publicDir: pub, rateLimit: 400, companiesPerMinute: 50, ticksPerMinute: 400 });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  close = async () => { server.close(); await db.close(); };
});
after(async () => { await close(); await dropSchemas(); });

class Visitor {
  cookie = '';
  async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(this.cookie ? { cookie: this.cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
    const text = await r.text();
    let json: any = null; try { json = JSON.parse(text); } catch { /* static */ }
    return { status: r.status, json, headers: r.headers, text };
  }
}

test('a session cookie is HttpOnly and SameSite=Strict, with strict security headers', async () => {
  const r = await fetch(base + '/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const sc = r.headers.get('set-cookie')!;
  assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Strict/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.match(r.headers.get('content-security-policy')!, /default-src 'self'/);
});

test('visitors are isolated; a forged or missing cookie gets nothing', async () => {
  const a = new Visitor(); const b = new Visitor();
  const sa = (await a.call('POST', '/api/session', { seed: 7 })).json;
  const sb = (await b.call('POST', '/api/session', { seed: 7 })).json;
  assert.notEqual(sa.company.id, sb.company.id);
  await a.call('POST', '/api/day');
  await a.call('POST', '/api/day');
  const bState = (await b.call('GET', '/api/state')).json;
  assert.equal(bState.company.clock, 0, "A's activity does not move B's company");
  const aTrace = (await a.call('GET', '/api/trace/O-1')).json;
  const bTrace = (await b.call('GET', '/api/trace/O-1')).json;
  assert.ok(aTrace.events.length > 0); assert.equal(bTrace.events.length, 0);
  const forged = new Visitor(); forged.cookie = 'firmhand_sid=' + 'A'.repeat(32);
  assert.equal((await forged.call('GET', '/api/state')).status, 401);
  assert.equal((await new Visitor().call('POST', '/api/day')).status, 401);
});

test('there is no way to write an event, a record, an actor or a clock from the browser', async () => {
  const v = new Visitor(); await v.call('POST', '/api/session', {});
  for (const p of ['/api/events', '/api/orders', '/api/journal', '/api/payments', '/api/command', '/api/clock'])
    assert.equal((await v.call('POST', p, { type: 'PaymentCaptured', actor: 'finance', at: 99 })).status, 404, p);
  // Extra fields on real endpoints are ignored: the scheduler decides who acts and when.
  const s = (await v.call('POST', '/api/tick', { ticks: 1, actor: 'finance', clock: 50, role: 'operator' })).json;
  assert.equal(s.company.clock, 1);
  assert.equal((await v.call('POST', '/api/tick', { ticks: 1 }, { 'content-type': 'text/plain' })).status, 415);
});

test('approvals are enforced by the backend: the shown hash is required and must match', async () => {
  const v = new Visitor(); await v.call('POST', '/api/session', { seed: 7 });
  await v.call('POST', '/api/tick', { ticks: 8 }); await v.call('POST', '/api/tick', { ticks: 3 });
  const s = (await v.call('GET', '/api/state')).json;
  const ap = s.approvals.find((a: any) => a.status === 'pending');
  assert.ok(ap, 'the storyline discount request is pending');
  assert.equal((await v.call('POST', `/api/approvals/${ap.id}`, { approve: true })).status, 400);
  assert.equal((await v.call('POST', `/api/approvals/${ap.id}`, { approve: true, hash: 'f'.repeat(64) })).status, 400);
  assert.equal((await v.call('POST', `/api/approvals/${ap.id}`, { approve: 'yes', hash: ap.hash })).status, 400);
  const other = new Visitor(); await other.call('POST', '/api/session', { seed: 7 });
  assert.equal((await other.call('POST', `/api/approvals/${ap.id}`, { approve: true, hash: ap.hash })).status, 404, "cannot decide another company's request");
  const ok = await v.call('POST', `/api/approvals/${ap.id}`, { approve: false, hash: ap.hash, note: 'too deep' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.approvals.find((a: any) => a.id === ap.id).status, 'denied');
});

test('replay over HTTP reports zero side effects and verifies the close', async () => {
  const v = new Visitor(); await v.call('POST', '/api/session', { seed: 23 });
  await v.call('POST', '/api/day'); await v.call('POST', '/api/day');
  const r = (await v.call('GET', '/api/replay/1')).json;
  assert.equal(r.sideEffects.none, true); assert.equal(r.verified.match, true);
  assert.equal((await v.call('GET', '/api/replay/5')).status, 404);
  assert.equal((await v.call('GET', '/api/verify')).json.match, true);
});

test('operator controls: pause, resume, inject, KPI drill-down, comparison', async () => {
  const v = new Visitor(); await v.call('POST', '/api/session', { seed: 7, storyline: false });
  let s = (await v.call('POST', '/api/agents/sales/pause', {})).json;
  assert.equal(s.agents.find((a: any) => a.role === 'sales').status, 'paused');
  assert.equal((await v.call('POST', '/api/agents/sales/pause', {})).status, 400);
  assert.equal((await v.call('POST', '/api/agents/ceo/pause', {})).status, 400);
  s = (await v.call('POST', '/api/agents/sales/resume', {})).json;
  assert.equal(s.agents.find((a: any) => a.role === 'sales').status, 'running');
  s = (await v.call('POST', '/api/scenario/inventory-shock', {})).json;
  assert.ok(s.company.scenarios.some((x: any) => x.kind === 'inventory-shock'));
  assert.equal((await v.call('POST', '/api/scenario/rm-rf', {})).status, 400);
  await v.call('POST', '/api/day');
  const k = (await v.call('GET', '/api/kpi/recognizedRevenue')).json;
  assert.equal(k.kind, 'journal');
  assert.equal((await v.call('GET', '/api/kpi/nope')).status, 404);
  const c = (await v.call('GET', '/api/compare/inventory-shock?seed=7')).json;
  assert.ok(c.managed && c.naive && c.label.includes('Simulation'));
  assert.equal((await v.call('GET', '/api/compare/everything')).status, 404);
});

test('static serving refuses traversal and serves the SPA fallback', async () => {
  const v = new Visitor();
  for (const p of ['/..%2f..%2fpackage.json', '/%2e%2e/%2e%2e/etc/passwd', '/a%5c..%5c..%5cx', '/%00']) {
    const r = await v.call('GET', p);
    assert.ok(r.status === 400 || !r.text.includes('"name"'), p);
  }
  const r = await v.call('GET', '/day/3');
  assert.equal(r.status, 200); assert.match(r.text, /<title>t<\/title>/);
  assert.match((await v.call('GET', '/assets/a.js')).headers.get('cache-control')!, /immutable/);
});

test('rate limits: new companies per address and simulated hours per minute are bounded', async () => {
  const db = await newDb();
  const { server } = createApp({ engine: new Engine(db), publicDir: pub, companiesPerMinute: 2, ticksPerMinute: 16 });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const b2 = `http://127.0.0.1:${(server.address() as any).port}`;
  const post = (p: string, cookie = '') => fetch(b2 + p, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{}' });
  const r1 = await post('/api/reset'); const ck = r1.headers.get('set-cookie')!.split(';')[0];
  await post('/api/reset');
  assert.equal((await post('/api/reset')).status, 429);
  assert.equal((await post('/api/day', ck)).status, 200);
  assert.equal((await post('/api/day', ck)).status, 200);
  assert.equal((await post('/api/day', ck)).status, 400, 'the third day in a minute exceeds the 16-hour budget');
  server.close(); await db.close();
});
