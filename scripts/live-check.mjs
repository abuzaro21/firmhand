// Live checks against a deployed FIRMHAND (docs/EXECUTION_STATE.md, gate G15).
// Usage: node scripts/live-check.mjs <baseUrl> run            -> full check, prints JSON, saves the session to .live-session.json
//        node scripts/live-check.mjs <baseUrl> persist        -> after a restart: the saved session still resolves, unchanged
// Uses only the public API, as a browser would. Creates a few demo companies, which expire after 2 idle hours.
import { readFileSync, writeFileSync } from 'node:fs';

const [base, mode = 'run'] = process.argv.slice(2);
if (!base?.startsWith('https://')) { console.error('usage: live-check.mjs https://host run|persist'); process.exit(2); }
const SAVE = '.live-session.json';
const bodies = [];
const out = { base, mode, at: new Date().toISOString(), checks: [] };
const check = (name, ok, detail) => { out.checks.push({ name, ok: !!ok, detail }); };

async function call(method, path, cookie = '', body) {
  const t0 = Date.now();
  const r = await fetch(base + path, { method, redirect: 'manual', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined });
  const text = await r.text();
  bodies.push(text);
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, headers: r.headers, json, text, ms: Date.now() - t0, cookie: (r.headers.get('set-cookie') ?? '').split(';')[0], setCookie: r.headers.get('set-cookie') ?? '' };
}

if (mode === 'persist') {
  const saved = JSON.parse(readFileSync(SAVE, 'utf8'));
  const s = await call('GET', '/api/state', saved.cookie);
  check('session survives restart', s.status === 200 && s.json.company.id === saved.company, { status: s.status });
  check('clock unchanged after restart', s.json?.company.clock === saved.clock, { before: saved.clock, after: s.json?.company.clock });
  const v = await call('GET', '/api/verify', saved.cookie);
  check('state checksum unchanged after restart', v.json?.live === saved.checksum && v.json?.match === true, { before: saved.checksum.slice(0, 16), after: v.json?.live?.slice(0, 16), match: v.json?.match });
} else {
  // 1. Reachability, TLS and headers.
  const h = await call('GET', '/api/health');
  check('health over HTTPS', h.status === 200 && h.json?.ok === true, { status: h.status, store: h.json?.store, ms: h.ms });
  check('durable store is PostgreSQL', h.json?.store === 'pg' || h.json?.store === 'postgres', { store: h.json?.store });
  check('HSTS header', /max-age=\d+/.test(h.headers.get('strict-transport-security') ?? ''), h.headers.get('strict-transport-security'));
  check('CSP and nosniff headers', !!h.headers.get('content-security-policy') && h.headers.get('x-content-type-options') === 'nosniff', { csp: (h.headers.get('content-security-policy') ?? '').slice(0, 60) });
  const plain = await fetch(base.replace('https://', 'http://') + '/api/health', { redirect: 'manual' });
  check('plain HTTP redirects to HTTPS', plain.status >= 300 && plain.status < 400 && (plain.headers.get('location') ?? '').startsWith('https://'), { status: plain.status });
  const ui = await call('GET', '/');
  check('cockpit UI served', ui.status === 200 && ui.text.includes('FIRMHAND'), { status: ui.status });

  // 2. Session.
  const a = await call('POST', '/api/session', '', { seed: 7 });
  check('session cookie HttpOnly, Secure, SameSite=Strict', a.status === 200 && /HttpOnly/i.test(a.setCookie) && /Secure/i.test(a.setCookie) && /SameSite=Strict/i.test(a.setCookie), { status: a.status });
  const A = a.cookie;

  // 3. Run the default week as the operator, approving each request with the hash it was shown.
  const decided = [];
  let s = a.json;
  for (let i = 0; i < 40 && !s.company.complete; i++) {
    const pend = s.approvals.find((x) => x.status === 'pending');
    if (pend) {
      const d = await call('POST', `/api/approvals/${pend.id}`, A, { approve: true, hash: pend.hash, note: 'live check' });
      decided.push({ id: pend.id, kind: pend.kind, status: d.status });
      s = d.json ?? s; continue;
    }
    const t = await call('POST', '/api/tick', A, { ticks: 8 });
    if (t.status !== 200) { check('tick', false, { status: t.status, body: t.text.slice(0, 120) }); break; }
    s = t.json;
  }
  check('week completes', s.company.complete === true, { clock: s.company.clock });
  check('agents ran: decisions by all three roles', s.agents.every((g) => g.decisions.length > 0), s.agents.map((g) => `${g.role}:${g.status}`));
  check('all agents running at week end', s.agents.every((g) => g.status === 'running'), s.agents.map((g) => `${g.role}:${g.status}`));
  check('human approvals requested and executed (discount, recovery)', decided.some((d) => d.kind === 'discount') && decided.some((d) => d.kind === 'recover-agent') && decided.every((d) => d.status === 200), decided);
  check('forged hash refused', (await call('POST', `/api/approvals/${decided[0]?.id}`, A, { approve: true, hash: 'f'.repeat(64) })).status >= 400, null);
  const exp = s.purchases.filter((p) => /expedite/i.test(JSON.stringify(p)));
  check('inventory shock: expedite purchase funded without a human', exp.length > 0, exp.map((p) => `${p.id}:${p.status}`));
  const stall = s.incidents.find((i) => i.kind === 'ops-stalled');
  check('Operations crash detected and resolved', !!stall && stall.status === 'resolved', stall && { id: stall.id, status: stall.status });
  check('nine reconciliation checks pass', s.checks.length === 9 && s.checks.every((c) => c.ok), s.checks.filter((c) => !c.ok).map((c) => c.name));
  check('seven days closed', s.days.length === 7, s.days.length);
  out.kpis = s.kpis;

  // 4. KPI drill-down, replay, verification, comparison.
  const kd = await call('GET', '/api/kpi/recognizedRevenue', A);
  check('KPI drill-down returns source rows', kd.status === 200 && JSON.stringify(kd.json).length > 50, { status: kd.status });
  const rp = await call('GET', '/api/replay/3', A);
  check('replay Day 3: no side effects, matches the close', rp.json?.sideEffects?.none === true && rp.json?.verified?.match === true, rp.json?.sideEffects);
  const v = await call('GET', '/api/verify', A);
  check('whole-company replay matches live state', v.json?.match === true, { live: v.json?.live?.slice(0, 16) });
  const cmp = await call('GET', '/api/compare/inventory-shock?seed=7', A);
  check('naive-baseline comparison available', cmp.status === 200, { status: cmp.status, ms: cmp.ms });

  // 5. Isolation.
  const b = await call('POST', '/api/session', '', { seed: 7 });
  const B = b.cookie;
  check('a second visitor gets a different company', b.json?.company.id && b.json.company.id !== s.company.id, null);
  check("a visitor cannot decide another company's approval", (await call('POST', `/api/approvals/${decided[0]?.id}`, B, { approve: true, hash: 'a'.repeat(64) })).status === 404, null);
  check("a visitor cannot trace another company's records", JSON.stringify((await call('GET', `/api/trace/${s.purchases[0]?.id}`, B)).json ?? {}).includes(s.company.id) === false, null);
  check('a forged cookie gets nothing', (await call('GET', '/api/state', 'firmhand_sid=forged-token-value')).status === 401, null);

  // 6. Rate limit on new companies per address (10 a minute).
  let limited = null;
  for (let i = 0; i < 12 && !limited; i++) { const r = await call('POST', '/api/session', '', {}); if (r.status === 429) limited = i; }
  check('new-company rate limit returns 429', limited !== null, { after: limited });
  // Forged left-most X-Forwarded-For entries must not open fresh buckets: still limited from the same address.
  const forged = await fetch(base + '/api/session', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7, 198.51.100.9' }, body: '{}' });
  bodies.push(await forged.text());
  check('forged X-Forwarded-For cannot bypass the limit', forged.status === 429, { status: forged.status });

  // 7. No secrets in any response.
  const all = bodies.join('\n');
  check('no secrets in responses', !/postgres(ql)?:\/\/|DATABASE_URL|password|BEGIN [A-Z ]*PRIVATE KEY/i.test(all), null);

  const fin = await call('GET', '/api/verify', A);
  writeFileSync(SAVE, JSON.stringify({ cookie: A, company: s.company.id, clock: s.company.clock, checksum: fin.json.live }));
}
out.pass = out.checks.filter((c) => c.ok).length; out.total = out.checks.length;
console.log(JSON.stringify(out, null, 2));
process.exit(out.pass === out.total ? 0 : 1);
