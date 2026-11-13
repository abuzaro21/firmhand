import { openDb } from './db.ts';
import { Engine } from './engine.ts';
import { createApp, prewarm } from './server.ts';

const db = await openDb();
const engine = new Engine(db);
const { server } = createApp({
  engine,
  trustProxyHops: Number(process.env.FIRMHAND_TRUST_PROXY_HOPS ?? 0),
  companiesPerMinute: Number(process.env.FIRMHAND_COMPANIES_PER_MINUTE ?? 10), // per client address; raised only for local browser tests
  maxCompanies: Number(process.env.FIRMHAND_MAX_COMPANIES ?? 400),
  secureCookie: process.env.NODE_ENV === 'production',
});
const port = Number(process.env.PORT ?? 3000);
server.listen(port, () => {
  console.log(`[firmhand] listening on :${port} (store ${db.kind})`);
  // Comparison runs use private in-memory databases, never the main store.
  if (process.env.FIRMHAND_PREWARM !== '0') setTimeout(() => { prewarm().then(() => console.log('[firmhand] comparisons ready')); }, 500);
});
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { server.close(); db.close().finally(() => process.exit(0)); });
