// Dev diagnostic: drive the cockpit in a headless browser and save screenshots of every tab at desktop and phone widths.
// Usage: node scripts/shots.mjs <baseUrl> <outDir>
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const base = process.argv[2] ?? 'http://127.0.0.1:3017';
const out = process.argv[3] ?? 'shots';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const errors = [];
for (const [name, vp] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
  const ctx = await browser.newContext({ viewport: vp, colorScheme: name === 'phone' ? 'dark' : 'light' });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  await page.goto(base);
  await page.getByTestId('run-day').waitFor();
  await page.screenshot({ path: `${out}/${name}-0-start.png`, fullPage: true });
  for (let d = 0; d < 3; d++) { await page.getByTestId('run-day').click(); await page.waitForTimeout(900); }
  await page.screenshot({ path: `${out}/${name}-1-run.png`, fullPage: true });
  const scroll = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (scroll > 0) errors.push(`${name}: horizontal overflow ${scroll}px`);
  for (const tab of ['Watch', 'Replay', 'Proof']) {
    await page.getByRole('button', { name: new RegExp(`^${tab}`) }).first().click();
    await page.waitForTimeout(tab === 'Proof' ? 4000 : 1200);
    await page.screenshot({ path: `${out}/${name}-${tab.toLowerCase()}.png`, fullPage: true });
  }
  await ctx.close();
}
await browser.close();
console.log(errors.length ? errors.join('\n') : 'no console errors');
