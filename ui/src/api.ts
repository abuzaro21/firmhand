// Thin client for the FIRMHAND API. The browser holds no authority: it asks the server to advance time and answers
// approval requests with the hash it was shown. Everything it displays is read back from server records.

export type Role = 'sales' | 'operations' | 'finance';
export const ROLES: Role[] = ['sales', 'operations', 'finance'];

export type Decision = { id: number; role: Role; at: number; rule: string; why: string; inputs: Record<string, unknown>; command: string; params: Record<string, unknown>; outcome: 'committed' | 'rejected' | 'escalated' | 'duplicate'; detail: string; first_seq: number | null; last_seq: number | null };
export type Agent = { role: Role; status: 'running' | 'paused' | 'faulted'; fault_mode: string; fault_reason: string; plan: string; last_turn: number | null; last_progress: number | null; turns: number;
  committed: number; rejected: number; escalated: number; memory: any; queued: number; oldestQueued: number | null; decisions: Decision[] };
export type Approval = { id: string; requester: Role; kind: string; params: Record<string, unknown>; bound: [string, string, number][]; hash: string; policy_version: string; summary: string;
  evidence: Record<string, any>; threshold: string; status: string; requested_at: number; expires_at: number; decided_by: string | null; decided_at: number | null; outcome: string | null; executed_at: number | null };
export type Incident = { id: string; kind: string; status: string; opened_at: number; resolved_at: number | null; summary: string; detail: any; opened_by: string };
export type Check = { name: string; ok: boolean; ledger: number | string; records: number | string; note: string };
export type Ev = { seq: number; at: number; type: string; actor: string; subject: string; causation: number | null; summary: string; payload?: any };
export type Kpis = Record<string, any>;
export type State = {
  company: { id: string; name: string; note: string; seed: number; clock: number; phase: number; day: number; label: string; complete: boolean; version: number; seq: number;
    policies: { selfCorrect: boolean; watchdog: boolean }; scenarios: { at: number; kind: string; by: string; done?: boolean }[]; freeze: any; surge: Record<string, { factor: number; until: number }> };
  agents: Agent[]; kpis: Kpis; checks: Check[]; approvals: Approval[]; incidents: Incident[]; flow: { leads: number; quotes: number; orders: Record<string, number> };
  inventory: { sku: string; name: string; price: number; on_hand: number; reserved: number; value_cents: number }[];
  purchases: any[]; series: { clock: number; revenue: number; booked: number; cash: number; costs: number; netIncome: number; backlog: number; broken: number; churned: number; atRisk: number }[];
  days: { day: number; seq: number; checksum: string; checks: Check[] }[]; events: Ev[];
};

export class ApiError extends Error { status: number; constructor(status: number, msg: string) { super(msg); this.status = status; } }

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, { method, credentials: 'same-origin', headers: method === 'POST' ? { 'content-type': 'application/json' } : {}, body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, j.error ?? `HTTP ${r.status}`);
  return j as T;
}

export const api = {
  session: (seed?: number) => call<State>('POST', '/api/session', { seed }),
  reset: (seed: number, storyline = true) => call<State>('POST', '/api/reset', { seed, storyline }),
  state: () => call<State>('GET', '/api/state'),
  tick: (ticks: number) => call<State>('POST', '/api/tick', { ticks }),
  day: () => call<State>('POST', '/api/day'),
  decide: (id: string, approve: boolean, hash: string, note = '') => call<State>('POST', `/api/approvals/${encodeURIComponent(id)}`, { approve, hash, note }),
  pause: (role: Role, paused: boolean) => call<State>('POST', `/api/agents/${role}/${paused ? 'pause' : 'resume'}`),
  inject: (kind: string) => call<State>('POST', `/api/scenario/${kind}`),
  events: (after: number) => call<Ev[]>('GET', `/api/events?after=${after}`),
  decisions: (role?: Role) => call<Decision[]>('GET', `/api/decisions${role ? `?role=${role}` : ''}`),
  trace: (id: string) => call<{ subject: string; events: Ev[]; decisions: Decision[]; journal: any[] }>('GET', `/api/trace/${encodeURIComponent(id)}`),
  kpi: (key: string) => call<{ key: string; kind: 'journal' | 'orders' | 'customers'; accounts?: string[]; rows: any[] }>('GET', `/api/kpi/${key}`),
  replay: (day: number) => call<any>('GET', `/api/replay/${day}`),
  verify: () => call<{ live: string; replay: string; match: boolean }>('GET', '/api/verify'),
  compare: (kind: string, seed: number) => call<any>('GET', `/api/compare/${kind}?seed=${seed}`),
  policy: () => call<any>('GET', '/api/policy'),
};

export const money = (c: number | null | undefined, cents = false) => {
  const v = Number(c ?? 0) / 100;
  return `${v < 0 ? '−' : ''}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 })}`;
};
export const TICKS_PER_DAY = 8;
export const clockLabel = (c: number) => `Day ${Math.floor(c / 8) + 1} ${String(9 + (c % 8)).padStart(2, '0')}:00`;
export const shortClock = (c: number) => `D${Math.floor(c / 8) + 1} ${String(9 + (c % 8)).padStart(2, '0')}h`;
export const ROLE_LABEL: Record<string, string> = { sales: 'Sales', operations: 'Operations', finance: 'Finance', world: 'Market', operator: 'You (COO)', system: 'Runtime' };
