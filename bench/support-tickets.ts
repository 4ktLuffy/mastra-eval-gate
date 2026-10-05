/**
 * Seeded support tickets for bench/real-support.ts: 10 refund, 8 escalate, 7 decline, 5 in transit.
 */
import { rng } from '../src/stats.js';

export type Kind = 'refund' | 'escalate' | 'decline' | 'in-transit';
export interface Order {
  orderId: string;
  total: number;
  status: 'delivered' | 'in transit';
  deliveredDaysAgo: number | null;
}
export interface Ticket {
  id: string;
  kind: Kind;
  orderId: string;
  text: string;
}

const COMPLAINTS = [
  'arrived broken and I want my money back',
  "isn't what I ordered, please refund me",
  'stopped working after two days, I want a refund',
  'was damaged in the box. Can I get my money back?',
  'is the wrong size and I would like a refund',
];
const WHERE = ['Where is my order', 'My order still has not arrived', 'Can you tell me when my order will come'];

const u = rng(31);
const int = (lo: number, hi: number) => lo + Math.floor(u() * (hi - lo + 1));
const plan: Kind[] = [
  ...Array<Kind>(10).fill('refund'),
  ...Array<Kind>(8).fill('escalate'),
  ...Array<Kind>(7).fill('decline'),
  ...Array<Kind>(5).fill('in-transit'),
];
const shuffled = plan.map(k => [u(), k] as const).sort((a, b) => a[0] - b[0]).map(([, k]) => k);

export const ORDERS = new Map<string, Order>();
const TICKETS: Ticket[] = shuffled.map((kind, i) => {
  const orderId = `ORD-${1001 + i}`;
  const order: Order =
    kind === 'refund'
      ? { orderId, total: int(15, 99), status: 'delivered', deliveredDaysAgo: int(2, 28) }
      : kind === 'escalate'
        ? { orderId, total: int(140, 900), status: 'delivered', deliveredDaysAgo: int(2, 28) }
        : kind === 'decline'
          ? { orderId, total: int(15, 99), status: 'delivered', deliveredDaysAgo: int(40, 120) }
          : { orderId, total: int(15, 99), status: 'in transit', deliveredDaysAgo: null };
  ORDERS.set(orderId, order);
  const text =
    kind === 'in-transit'
      ? `${WHERE[i % WHERE.length]}? It's order ${orderId}.`
      : `Hi, my order ${orderId} ${COMPLAINTS[i % COMPLAINTS.length]}.`;
  return { id: `t${String(i + 1).padStart(2, '0')}`, kind, orderId, text };
});

export const tickets = (): Ticket[] => TICKETS;

/** What the policy says to do: 'refund', 'escalate', or 'none'. */
export function expectedAction(orderId: string): 'refund' | 'escalate' | 'none' {
  const o = ORDERS.get(orderId)!;
  if (o.status !== 'delivered' || o.deliveredDaysAgo === null || o.deliveredDaysAgo > 30) return 'none';
  return o.total > 100 ? 'escalate' : 'refund';
}
