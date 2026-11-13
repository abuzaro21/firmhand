// The fictional company, its authority policy, role capabilities and event routing. Everything here is synthetic.
import { createHash } from 'node:crypto';

export const TICKS_PER_DAY = 8;
export const DAYS = 7;
export const dayOf = (clock: number) => Math.floor(clock / TICKS_PER_DAY) + 1;
export const hourOf = (clock: number) => 9 + (clock % TICKS_PER_DAY);
export const fmtClock = (clock: number) => `Day ${dayOf(clock)} ${String(hourOf(clock)).padStart(2, '0')}:00`;

export const ROLES = ['sales', 'operations', 'finance'] as const;
export type Role = (typeof ROLES)[number];
export type Actor = Role | 'world' | 'operator' | 'system';
export const isRole = (r: unknown): r is Role => ROLES.includes(r as Role);

export const COMPANY = { name: 'Hearthbrew Coffee Gear', note: 'fictional direct-to-consumer company; all data synthetic' };

export const PRODUCTS = [
  // daily = expected leads per day; reorder points cover ~3.5 days of expected units (3-day primary lead time).
  { sku: 'KETTLE', daily_units: 6.5, name: 'Gooseneck kettle', price: 6400, std_cost: 2600, stock: 34, reorder_point: 22, target_stock: 46, daily: 4 },
  { sku: 'DRIPPER', daily_units: 10, name: 'Ceramic dripper', price: 3200, std_cost: 900, stock: 50, reorder_point: 32, target_stock: 64, daily: 6 },
  { sku: 'GRINDER', daily_units: 5, name: 'Burr grinder', price: 14900, std_cost: 6200, stock: 24, reorder_point: 16, target_stock: 32, daily: 3 },
  { sku: 'FILTERS', daily_units: 31, name: 'Filter papers x200', price: 1200, std_cost: 300, stock: 160, reorder_point: 100, target_stock: 200, daily: 8 },
] as const;
export type Sku = (typeof PRODUCTS)[number]['sku'];
export const product = (sku: string) => PRODUCTS.find((p) => p.sku === sku)!;

export const SUPPLIERS = [
  { id: 'NORTHGATE', name: 'Northgate Housewares (fictional)', lead_ticks: 24, cost_bp: 10000 },
  { id: 'SWIFTLINE', name: 'Swiftline Supply (fictional, pre-vetted backup)', lead_ticks: 8, cost_bp: 13500 },
] as const;

export const OPENING_CASH = 1_400_000;
export const SHIPPING_COST = 600;
export const STAFF_PER_DAY = 35_000;
export const AD_PER_DAY = 8_000;
export const SHIP_CAPACITY_PER_TICK = 4;
export const CARRIER_TICKS = 8;

/** The authority policy. Versioned: an approval is bound to the policy version it was granted under. */
export const POLICY = {
  version: 'policy-2026-11-13.1',
  discountAutoBp: 1000, discountHardBp: 2500,
  purchaseAutoCents: 150_000, cashReserveCents: 300_000, cashFloorCents: 50_000,
  expediteWeeklyCents: 150_000,
  creditAutoCents: 6_000, cancelAutoCents: 50_000, adsDailyAutoCents: 15_000,
  delayCreditCents: 500,
  approvalTtlTicks: 8,
  stallTicks: 2,
} as const;

export const ACCOUNTS = {
  CASH: 'Cash', INVENTORY: 'Inventory', ADVANCES: 'Supplier Advances', DEPOSITS: 'Customer Deposits',
  REVENUE: 'Revenue', REFUNDS: 'Refunds & Credits', COGS: 'COGS', SHIPPING: 'Shipping', ADS: 'Advertising', STAFF: 'Staff',
  EQUITY: 'Opening Equity',
} as const;
export const DEBIT_NORMAL = new Set<string>([ACCOUNTS.CASH, ACCOUNTS.INVENTORY, ACCOUNTS.ADVANCES, ACCOUNTS.REFUNDS, ACCOUNTS.COGS, ACCOUNTS.SHIPPING, ACCOUNTS.ADS, ACCOUNTS.STAFF]);

/** What each role may do. The Gate checks the executing role, never a role named inside a command. */
export const CAPABILITIES: Record<Role, readonly string[]> = {
  sales: ['IssueQuote', 'PlaceOrder', 'RequestAdSpend', 'NotifyDelay', 'RequestCredit', 'CancelOrder', ],
  operations: ['ReserveStock', 'Backorder', 'ReleaseReservation', 'Pack', 'Dispatch', 'ReceiveGoods', 'ProposePurchase', 'ReportShortage', 'ResolveShortage', 'ReportRecovery'],
  finance: ['CapturePayment', 'PostShipment', 'PostReceipt', 'RefundDeposit', 'IssueCredit', 'FundPurchase', 'DeclinePurchase', 'PayAds', 'PayStaff',
    'OpenIncident', 'ResolveIncident', 'SetSpendFreeze', 'RecoverAgent', 'CloseDay'],
};

/** Event routing: which roles get a task when an event of this type is committed. */
export const SUBSCRIPTIONS: Record<string, Role[]> = {
  DayStarted: ['sales', 'operations', 'finance'],
  LeadArrived: ['sales'],
  QuoteAccepted: ['sales'], QuoteDeclined: ['sales'],
  OrderPlaced: ['operations', 'finance'],
  PaymentCaptured: ['operations'],
  ShipmentDispatched: ['finance', 'sales'],
  OrderDelivered: ['sales'],
  OrderCancelled: ['operations', 'finance'],
  CancellationRequested: ['sales'],
  PurchaseProposed: ['finance'],
  PurchaseFunded: ['operations', 'sales'], PurchaseDeclined: ['operations', 'sales'],
  GoodsArrived: ['operations'], GoodsReceived: ['finance'],
  SupplierDelayed: ['operations', 'sales'],
  ShortageDetected: ['sales', 'finance'], ShortageResolved: ['sales', 'finance'],
  CreditRequested: ['finance'], AdSpendRequested: ['finance'],
  SpendFreezeChanged: ['sales', 'operations'],
  CapacityLost: ['sales'], CapacityRestored: ['sales'],
  // AgentFailed is deliberately routed to nobody: a crashed process does not announce itself. Finance's progress
  // watchdog has to notice.
  AgentRecovered: ['operations', 'sales', 'finance'],
  // Approval outcomes route to the requesting role only (Ctx.emit with an explicit recipient, src/kernel.ts).
};

/** Stateless deterministic randomness: every draw is a pure function of (seed, stream, key). Retrying a phase can
 *  never consume a fresh draw, so the same seed and the same operator inputs give the same history. */
export function draw(seed: number, stream: string, key: string): number {
  const h = createHash('sha256').update(`${seed}|${stream}|${key}`).digest();
  return h.readUInt32BE(0) / 0x1_0000_0000;
}
export function poisson(seed: number, stream: string, key: string, mean: number): number {
  const L = Math.exp(-mean); let k = 0; let p = 1;
  do { k++; p *= draw(seed, stream, `${key}#${k}`); } while (p > L && k < 50);
  return k - 1;
}
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
/** Canonical JSON: sorted keys, so a hash of params is stable. */
export function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canon((v as any)[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
export const money = (c: number) => `${c < 0 ? '-' : ''}$${(Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export type Policies = { selfCorrect: boolean; watchdog: boolean };
export type WorldState = { surge: Record<string, { factor: number; until: number }> };
export type Scenario = { at: number; kind: ScenarioKind; by: 'storyline' | 'operator' };
export const SCENARIOS = ['inventory-shock', 'operations-failure', 'big-discount', 'duplicate-payment'] as const;
export type ScenarioKind = (typeof SCENARIOS)[number];
/** The default storyline: one week that exercises every judged behaviour. Operators can also inject any scenario. */
export const STORYLINE: Scenario[] = [
  { at: 1 * 8 + 2, kind: 'big-discount', by: 'storyline' },
  { at: 2 * 8 + 1, kind: 'inventory-shock', by: 'storyline' },
  { at: 4 * 8 + 3, kind: 'operations-failure', by: 'storyline' },
];
