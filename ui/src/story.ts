// "Watch a Company Day": the narration is derived from real events in the log. Nothing here is scripted text that
// could drift from what happened. Each beat names the event (seq) it explains, so the viewer can click through.
import type { Ev } from './api.ts';
import { money } from './api.ts';

export type Beat = { seq: number; at: number; tone: 'info' | 'warn' | 'bad' | 'good' | 'human'; title: string; body: string; subject?: string };

const p = (e: Ev) => e.payload ?? {};

export function beatFor(e: Ev): Beat | null {
  const b = (tone: Beat['tone'], title: string, body: string): Beat => ({ seq: e.seq, at: e.at, tone, title, body, subject: e.subject });
  switch (e.type) {
    case 'CompanyFounded': return b('info', 'A company opens', 'Hearthbrew Coffee Gear is fictional. It starts with $14,000 cash and four products. Sales, Operations and Finance each run their own loop over one shared ledger.');
    case 'DayStarted': return Number(p(e).day) === 1 ? b('info', 'Day 1 begins', 'Leads arrive from the simulated market. Sales quotes them, Operations reserves and ships stock, and Finance captures payments and posts every entry.') : null;
    case 'EscalationRequested': return b('human', 'A decision needs you', `${e.summary}. The agent has no authority above its policy limit, so the action waits in your inbox. Approving binds you to these exact parameters and record versions.`);
    case 'ApprovalGranted': return b('human', 'You approved', e.summary);
    case 'ApprovalDenied': return b('human', 'You denied', `${e.summary}. The requesting agent adapts within its own limits.`);
    case 'ApprovalStale': return b('warn', 'An approval went stale', `${e.summary}. The record it covered changed after you approved it, so it cannot be used.`);
    case 'DemandSurge': return b('warn', 'Shock: demand surge', e.summary);
    case 'SupplierDelayed': return b('bad', 'Shock: supplier delay', `${e.summary}. No human is involved from here on. Watch the agents correct course.`);
    case 'ShortageDetected': return b('warn', 'Operations sees a shortage coming', `${e.summary}. Sales and Finance are subscribed and will react on their next turn.`);
    case 'PurchaseFunded': return p(e).kind === 'expedite' ? (p(e).approval ? b('human', 'Expedite funded with your approval', `${e.summary}. It was above Finance's own authority, so it waited for you.`) : b('good', 'Finance funds an expedite', `${e.summary}. It was within Finance's own authority, so no human was needed.`)) : null;
    case 'CustomerNotified': return null; // aggregated below
    case 'ShortageResolved': return b('good', 'Shortage covered', e.summary);
    case 'FaultInjected': return b('bad', 'Fault injected into Operations', 'Operations will crash on its next turn, part-way through: after it packs orders and before it dispatches them.');
    case 'AgentFailed': return b('bad', 'Operations crashed silently', 'No other agent was told. The failure event has no subscribers, just as a dead process announces nothing.');
    case 'IncidentOpened': return b('warn', 'Finance noticed', `${e.summary}. Finance's watchdog saw paid orders stop moving. It did not need a heartbeat.`);
    case 'SpendFreezeChanged': return p(e).on ? b('warn', 'Compensation: spend frozen', e.summary) : b('good', 'Spend freeze lifted', e.summary);
    case 'CapacityLost': return b('warn', 'Sales re-promises', 'Sales has been told fulfilment is down. It stops promising dates it cannot keep and tells waiting customers.');
    case 'AgentRecovered': return b('good', 'Operations restarted', e.summary);
    case 'RecoveryReconciled': return b('good', 'Recovered without duplicates', `${e.summary}. Each half-finished shipment was dispatched once, because shipments are unique per order.`);
    case 'IncidentResolved': return b('good', 'Incident resolved', e.summary);
    case 'DayClosed': return b(String(e.summary).includes('FAILED') ? 'bad' : 'good', `Day ${p(e).day} closed`, `${e.summary}. Snapshot checksum ${String(p(e).checksum ?? '').slice(0, 8)}.`);
    case 'ActionRejected': return b('bad', 'The kernel refused an action', e.summary);
    case 'OrderCancelled': return String(p(e).reason ?? '').includes('patience') ? b('bad', 'A customer gave up', `${e.summary}. Their deposit is refunded in full.`) : null;
    default: return null;
  }
}

export function beats(events: Ev[]): Beat[] {
  const out: Beat[] = [];
  let notified = 0; let notifiedAt = -1; let firstSeq = 0;
  for (const e of events) {
    if (e.type === 'CustomerNotified') { if (!notified) firstSeq = e.seq; notified++; notifiedAt = e.at; continue; }
    if (notified && e.at !== notifiedAt) {
      out.push({ seq: firstSeq, at: notifiedAt, tone: 'info', title: 'Sales keeps customers informed', body: `${notified} customer${notified > 1 ? 's were' : ' was'} told of a new date for a waiting order. Late customers get a small goodwill credit within Finance's limits.` });
      notified = 0;
    }
    const b = beatFor(e); if (b) out.push(b);
  }
  if (notified) out.push({ seq: firstSeq, at: notifiedAt, tone: 'info', title: 'Sales keeps customers informed', body: `${notified} customer${notified > 1 ? 's were' : ' was'} told of a new date for a waiting order.` });
  return out;
}

export const kpiHelp: Record<string, string> = {
  recognizedRevenue: 'Revenue counts only when goods are dispatched and Finance posts the shipment. Bookings are not revenue.',
  bookedValue: 'Value of every order placed. Money is captured at order time but held as a customer deposit (a liability).',
  cash: 'Ledger cash: opening capital + captured payments − refunds, credits, expenses and prepaid purchases.',
  netIncome: 'Net revenue − cost of goods − shipping − advertising − staff. Straight from journal lines.',
  grossMarginPct: 'Gross profit ÷ net revenue. Cost of goods is weighted-average cost of what actually shipped.',
  backlogOrders: 'Orders placed but not yet dispatched.',
  lateVsOriginal: 'Orders later than the date first promised. Renegotiating a date never hides a slip here.',
  customersChurned: 'Customers who cancelled after waiting past their patience. They stop ordering.',
};
export { money };
