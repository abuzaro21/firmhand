// Renders the brand ending frame by frame from the product's vector mark (ui/public/favicon.svg geometry):
// - the ink tile settles in;
// - the three role bars (Sales amber, Operations teal, Finance indigo) rise one after another;
// - the shared base slides in under them: three hands, one record;
// - the wordmark and tagline reveal, then the composition holds.
// Animations are CSS, paused and stepped to exact times, so every frame is deterministic.
// Output: film/out/logo/%04d.png (30 fps), encoded by build.mjs. Usage: node film/logo.mjs [seconds]
import { chromium } from '@playwright/test';
import { mkdirSync, rmSync, readFileSync } from 'node:fs';

const F = (p) => new URL(p, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const SECONDS = Number(process.argv[2] ?? 8), FPS = 30, DIR = F('./out/logo/');
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
const font = (pkg, file) => readFileSync(F(`../node_modules/@fontsource-variable/${pkg}/files/${file}`)).toString('base64');

const html = `<!doctype html><style>
@font-face{font-family:'Fraunces';src:url(data:font/woff2;base64,${font('fraunces', 'fraunces-latin-wght-normal.woff2')}) format('woff2');font-weight:100 900}
@font-face{font-family:'Inter';src:url(data:font/woff2;base64,${font('inter', 'inter-latin-wght-normal.woff2')}) format('woff2');font-weight:100 900}
*{margin:0;box-sizing:border-box}
body{width:1920px;height:1080px;background:radial-gradient(1100px 720px at 50% 34%,#22201a 0%,#14130f 72%);display:grid;place-items:center;font-family:'Inter',system-ui,sans-serif;color:#f1ece1;overflow:hidden}
.c{text-align:center;display:flex;flex-direction:column;align-items:center}
svg{width:240px;height:240px;overflow:visible}
.tile{transform-origin:16px 16px;transform:scale(.86);opacity:0;animation:tile .9s cubic-bezier(.2,.8,.2,1) .15s forwards}
.bar{transform-box:fill-box;transform-origin:50% 100%;transform:scaleY(0);animation:rise .7s cubic-bezier(.3,1.4,.5,1) forwards}
.b1{animation-delay:.75s}.b2{animation-delay:1.0s}.b3{animation-delay:1.25s}
.base{transform:translateX(-6px);opacity:0;animation:slide .8s cubic-bezier(.2,.8,.2,1) 1.6s forwards}
.w{font-family:'Fraunces',Georgia,serif;font-size:124px;font-weight:700;letter-spacing:.34em;margin:44px 0 0 .1em;opacity:0;animation:word 1.3s cubic-bezier(.2,.8,.2,1) 2.1s forwards}
.t{font-family:'Fraunces',Georgia,serif;font-style:italic;font-size:46px;color:#e8b55a;margin-top:16px;opacity:0;transform:translateY(14px);animation:up .9s ease-out 3.1s forwards}
.u{font-size:28px;color:#9a927f;margin-top:48px;font-family:Consolas,monospace;opacity:0;animation:fade .8s ease-out 3.9s forwards}
.d{position:fixed;left:0;right:0;bottom:44px;text-align:center;font-size:21px;color:#7a7466;opacity:0;animation:fade .8s ease-out 4.4s forwards}
@keyframes tile{to{transform:none;opacity:1}}
@keyframes rise{to{transform:scaleY(1)}}
@keyframes slide{to{transform:none;opacity:1}}
@keyframes fade{to{opacity:1}}
@keyframes word{from{opacity:0;letter-spacing:.34em}to{opacity:1;letter-spacing:.1em}}
@keyframes up{to{opacity:1;transform:none}}
</style><div class="c">
<svg viewBox="0 0 32 32" aria-label="FIRMHAND">
  <rect class="tile" width="32" height="32" rx="7" fill="#1d1b16" stroke="#3c3830" stroke-width=".3"/>
  <rect class="bar b1" x="7" y="9" width="4" height="12" rx="2" fill="#e08a3c"/>
  <rect class="bar b2" x="14" y="6" width="4" height="15" rx="2" fill="#3fa39a"/>
  <rect class="bar b3" x="21" y="11" width="4" height="10" rx="2" fill="#7c83e0"/>
  <rect class="base" x="6" y="23" width="20" height="3" rx="1.5" fill="#f4f1ea"/>
</svg>
<div class="w">FIRMHAND</div><div class="t">One company. One shared truth. Many accountable hands.</div><div class="u">github.com/abuzaro21/firmhand</div></div>
<div class="d">Real captures of the running build · fictional company, synthetic data · synthetic narration (Kokoro-82M)</div>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.setContent(html);
await page.evaluate(() => document.fonts.ready);
await page.evaluate(() => document.getAnimations().forEach((a) => a.pause()));
const n = Math.round(SECONDS * FPS);
for (let i = 0; i < n; i++) {
  await page.evaluate((ms) => document.getAnimations().forEach((a) => { a.currentTime = ms; }), (i * 1000) / FPS);
  await page.screenshot({ path: `${DIR}${String(i).padStart(4, '0')}.png` });
}
await browser.close();
console.log(`logo: ${n} frames`);
