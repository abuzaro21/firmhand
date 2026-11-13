// Captures REAL footage of the current FIRMHAND build for the film: one continuous browser session against a local
// server with an in-memory SQLite store, driven only by the clicks below. A small ring marks the pointer.
// Scenes are paced to the narration (film/out/audio/durations.json), so each scene is one continuous take.
// Output: film/out/raw/session.webm and session.json (the second at which each scene starts).
// Usage: npm run build && film/.venv/Scripts/python film/tts.py && node film/capture.mjs
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdirSync, renameSync, writeFileSync, rmSync, readFileSync } from 'node:fs';

const F = (p) => new URL(p, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const PORT = 3421, OUT = F('./out/raw/');
mkdirSync(OUT, { recursive: true });
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/main.ts'], {
  env: { ...process.env, PORT: String(PORT), FIRMHAND_DB: ':memory:', DATABASE_URL: '' }, stdio: 'inherit',
});
for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 250)); }
await new Promise((r) => setTimeout(r, 4000)); // let the server pre-compute the comparisons shown at the end

const POINTER = `addEventListener('DOMContentLoaded', () => {
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;z-index:99999;width:24px;height:24px;margin:-12px 0 0 -12px;border-radius:50%;border:2px solid #4f57c4;background:#4f57c42e;pointer-events:none;transition:transform .12s;left:-50px;top:-50px';
  document.body.appendChild(d);
  addEventListener('mousemove', (e) => { d.style.left = e.clientX + 'px'; d.style.top = e.clientY + 'px'; }, true);
  addEventListener('mousedown', () => { d.style.transform = 'scale(.6)'; }, true);
  addEventListener('mouseup', () => { d.style.transform = 'scale(1)'; }, true);
});`;

const browser = await chromium.launch();
const tmp = F('./out/raw/tmp/');
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, colorScheme: 'light', recordVideo: { dir: tmp, size: { width: 1920, height: 1080 } } });
await ctx.addInitScript(POINTER);
const page = await ctx.newPage();
const t0 = Date.now(), marks = {};
const wait = (ms) => page.waitForTimeout(ms);
const glide = async (loc) => { await loc.scrollIntoViewIfNeeded(); const b = await loc.boundingBox(); if (b) await page.mouse.move(b.x + Math.min(b.width / 2, 260), b.y + Math.min(b.height / 2, 60), { steps: 18 }); };
const press = async (loc) => { await glide(loc); await wait(450); await loc.click(); };
const top = () => page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
const voice = JSON.parse(readFileSync(F('./out/audio/durations.json'), 'utf8'));
const LEAD = 0.3, TAIL = 0.4;
const at = async (start, s) => { const ms = start + s * 1000 - Date.now(); if (ms > 0) await wait(ms); };
async function scene(id, fn) {
  const start = Date.now();
  marks[id] = (start - t0) / 1000;
  console.log(`${id} @ ${marks[id].toFixed(1)}s`);
  await fn((s) => at(start, s));
  await at(start, voice[id] + LEAD + TAIL);
}
const run = page.getByTestId('run-week');
const approval = page.getByTestId('approval').first();
const lane = (name) => page.getByRole('article', { name: `${name} agent` });

try {
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await run.waitFor();
  await page.mouse.move(960, 500);
  await wait(800);
  await scene('title', async (t) => { await t(1.2); await glide(page.locator('.brand')); await t(3.2); await glide(page.locator('.kpis')); });
  await scene('agents', async (t) => {
    await t(0.3); await press(page.getByRole('button', { name: '3×' }));
    await press(run);
    for (const [name, s] of [['Sales', 2.5], ['Operations', 5.5], ['Finance', 8.5]]) { await t(s); await glide(lane(name).locator('.receipts')); }
  });
  await scene('approval', async (t) => {
    await approval.waitFor({ timeout: 30_000 });
    await glide(approval.locator('.ap-sum'));
    await t(4.5); await glide(approval.locator('.evidence'));
    await t(8.0); await glide(approval.locator('.ap-bind'));
    await t(10.6); await press(approval.getByRole('button', { name: 'Approve' }));
  });
  await scene('shock', async (t) => {
    await t(0.2); await press(run);
    await t(3.5); await glide(page.getByRole('region', { name: 'Incidents' }));
    await t(7.0); await glide(page.getByRole('region', { name: 'Inventory and purchasing' }).locator('.pos'));
    await t(10.5); await glide(lane('Sales').locator('.receipts'));
  });
  await scene('crash', async (t) => {
    await approval.waitFor({ timeout: 40_000 });
    await top();
    await glide(lane('Operations').locator('.lane-head'));
    await t(5.0); await glide(lane('Finance').locator('.receipts'));
    await t(8.5); await glide(approval.locator('.ap-sum'));
  });
  await scene('recover', async (t) => {
    await t(0.2); await press(approval.getByRole('button', { name: 'Approve' }));
    await t(1.6); await press(page.getByRole('button', { name: 'Fast' })); await press(run);
    await t(3.0); await glide(lane('Operations').locator('.receipts'));
  });
  const drawer = page.getByRole('dialog');
  await scene('kpi', async (t) => {
    await page.getByTestId('run-week').and(page.locator(':disabled')).waitFor({ timeout: 30_000 }).catch(() => {});
    await top();
    await t(0.3); await press(page.getByRole('button', { name: /Recognised revenue/ }).first());
    await drawer.waitFor();
    await t(2.6); await glide(drawer.locator('tr').nth(1));
    await t(5.0); await glide(drawer.locator('tr').nth(6));
  });
  await scene('proof', async (t) => {
    await t(0.2); await press(drawer.getByRole('button', { name: 'Close' }));
    await press(page.getByRole('button', { name: 'Replay' }));
    await page.getByText('side effects: none').waitFor();
    await glide(page.getByText('side effects: none'));
    await t(4.6); await press(page.getByRole('button', { name: 'Proof' }));
    await page.locator('.tbl.cmp').first().waitFor({ timeout: 20_000 });
    const row = page.locator('.tbl.cmp').first().getByRole('row', { name: /Customers lost/ });
    await row.scrollIntoViewIfNeeded(); await glide(row);
  });
  marks.end = (Date.now() - t0) / 1000;
} finally {
  const video = page.video();
  await ctx.close();
  renameSync(await video.path(), F('./out/raw/session.webm'));
  rmSync(tmp, { recursive: true, force: true });
  writeFileSync(F('./out/raw/session.json'), JSON.stringify(marks, null, 2));
  await browser.close();
  server.kill();
}
