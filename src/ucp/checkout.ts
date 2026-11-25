import { randomUUID } from "node:crypto";
import type { LineRequest, PricedLine, PricedLines, PricingMessage } from "../pricing.js";
import { type QuoteState, quoteAdjustment, toUcpQuote } from "./quote.js";
import { UCP_VERSION } from "./schemas.js";

// UCP Checkout and Order for account buyers, paid on account under the Payment Terms extension
// (dev.ucp.common.payment.terms), with the #929 quote carried from Cart to Checkout to Order.

export const TERMS_CAPABILITY = "dev.ucp.common.payment.terms";

export type CheckoutState = "open" | "completed" | "canceled";

export interface Checkout {
  id: string;
  owner: string;
  /** On-account terms and quotes need a known buyer account. */
  quotable: boolean;
  /** The Cart this Checkout was created from, kept in sync while both exist. */
  cartId?: string;
  lines: LineRequest[];
  quote: QuoteState;
  state: CheckoutState;
  selectedTermId: string;
  /** Total under the selected term in the last response, to report `payment_term_changed`. */
  reportedTermTotal?: number;
  orderId?: string;
  /** The response at completion or cancellation: a finished Checkout is immutable. */
  final?: Record<string, unknown>;
  createdAt: Date;
  expiresAt: Date;
}

export interface CheckoutStore {
  create(checkout: Omit<Checkout, "id">): Promise<Checkout>;
  get(id: string): Promise<Checkout | undefined>;
  /** The open Checkout created from a Cart, if any (one per Cart, cart/index.md). */
  openForCart(cartId: string): Promise<Checkout | undefined>;
  save(checkout: Checkout): Promise<void>;
}

export class InMemoryCheckoutStore implements CheckoutStore {
  readonly #checkouts = new Map<string, Checkout>();

  async create(checkout: Omit<Checkout, "id">): Promise<Checkout> {
    const created = { ...checkout, id: `chk_${randomUUID()}` };
    this.#checkouts.set(created.id, created);
    return created;
  }

  async get(id: string): Promise<Checkout | undefined> {
    return this.#checkouts.get(id);
  }

  async openForCart(cartId: string): Promise<Checkout | undefined> {
    for (const c of this.#checkouts.values()) if (c.cartId === cartId && c.state === "open") return c;
    return undefined;
  }

  async save(checkout: Checkout): Promise<void> {
    this.#checkouts.set(checkout.id, checkout);
  }
}

export interface Order {
  id: string;
  owner: string;
  checkoutId: string;
  currency: string;
  lines: PricedLine[];
  totals: Total[];
  /** The accepted quotation, if one was accepted when the Order was placed (#929 §9). */
  quote?: { id: string; subtotal: number };
  acceptedTerm: PaymentTerm;
  createdAt: Date;
}

export interface OrderStore {
  create(order: Omit<Order, "id">): Promise<Order>;
  get(id: string): Promise<Order | undefined>;
}

export class InMemoryOrderStore implements OrderStore {
  readonly #orders = new Map<string, Order>();

  async create(order: Omit<Order, "id">): Promise<Order> {
    const created = { ...order, id: `ord_${randomUUID()}` };
    this.#orders.set(created.id, created);
    return created;
  }

  async get(id: string): Promise<Order | undefined> {
    return this.#orders.get(id);
  }
}

export interface Total {
  type: string;
  amount: number;
  display_text?: string;
}

export interface PaymentSchedule {
  id: string;
  type: string;
  description: { plain: string };
  amount: number;
  due_at?: string;
}

export interface PaymentTerm {
  id: string;
  title: string;
  description?: { plain: string };
  schedules: PaymentSchedule[];
}

interface TermOffer {
  id: string;
  title: string;
  description: string;
  netDays: number;
  /** Fee for paying later, in basis points of the amount before the fee. */
  feeBps: number;
}

/** Trade credit offered to account buyers. Net 30 is the default. */
export const TERM_OFFERS: readonly TermOffer[] = [
  { id: "net_30", title: "Net 30 on account", description: "Invoiced to your account when the order is placed.", netDays: 30, feeBps: 0 },
  { id: "net_60", title: "Net 60 on account", description: "Invoiced to your account, with a 1.5% fee for 60-day terms.", netDays: 60, feeBps: 150 },
];
export const DEFAULT_TERM_ID = "net_30";

export function termFee(offer: TermOffer, base: number): number {
  return Math.round((base * offer.feeBps) / 10_000);
}

/** The term as offered: one invoice, due a fixed number of days after the order is placed. */
export function paymentTerm(offer: TermOffer, base: number, placedAt?: Date): PaymentTerm {
  const schedule: PaymentSchedule = {
    id: "invoice",
    // Not `immediate`: nothing is charged at completion.
    type: "deferred",
    description: { plain: `Invoice due ${offer.netDays} days after the order is placed, payable by bank transfer.` },
    amount: base + termFee(offer, base),
  };
  // The due date is only known once the order is placed (terms.md, Due dates).
  if (placedAt) schedule.due_at = new Date(placedAt.getTime() + offer.netDays * 24 * 3600_000).toISOString();
  return { id: offer.id, title: offer.title, description: { plain: offer.description }, schedules: [schedule] };
}

export type CheckoutStatus = "incomplete" | "requires_escalation" | "ready_for_complete" | "completed" | "canceled";

export interface PricedCheckout {
  status: CheckoutStatus;
  totals: Total[];
  terms: PaymentTerm[];
  /** Subtotal plus any accepted quotation adjustment, before a term fee. */
  base: number;
  termTotal: number;
  messages: PricingMessage[];
}

const termChanged = (content: string): PricingMessage => ({ type: "warning", code: "payment_term_changed", content, path: "$.payment.selected_term_id" });

/**
 * Totals, terms and status for a Checkout whose quote has already been advanced. Applies a term
 * selection if one was sent, and reports `payment_term_changed` whenever the amount due under the
 * selected term differs from the last response, whatever caused it (terms.md; #929 §8).
 */
export function priceCheckout(checkout: Checkout, priced: PricedLines, selection?: string): PricedCheckout {
  const messages: PricingMessage[] = [];
  if (selection !== undefined && selection !== checkout.selectedTermId) {
    if (TERM_OFFERS.some((t) => t.id === selection)) {
      checkout.selectedTermId = selection;
      delete checkout.reportedTermTotal;
    } else {
      messages.push(termChanged(`Payment term ${selection} isn't offered for this checkout; ${checkout.selectedTermId} stays selected.`));
    }
  }

  const totals: Total[] = [{ type: "subtotal", amount: priced.subtotal }];
  const adjustment = checkout.quotable ? quoteAdjustment(checkout.quote, priced.subtotal) : undefined;
  if (adjustment !== undefined) totals.push({ type: "quote", display_text: "Quoted price adjustment", amount: adjustment });
  const base = priced.subtotal + (adjustment ?? 0);

  let terms: PaymentTerm[] = [];
  let termTotal = base;
  if (checkout.quotable) {
    terms = TERM_OFFERS.map((offer) => paymentTerm(offer, base));
    const offer = TERM_OFFERS.find((t) => t.id === checkout.selectedTermId)!;
    const fee = termFee(offer, base);
    if (fee > 0) totals.push({ type: "fee", display_text: `${offer.title} fee`, amount: fee });
    termTotal = base + fee;
    if (checkout.state === "open" && checkout.reportedTermTotal !== undefined && checkout.reportedTermTotal !== termTotal) {
      messages.push(termChanged(`The amount due under ${offer.title} changed to ${termTotal} (minor units) because the checkout total changed.`));
    }
  }
  // Tax and shipping are quoted on the invoice; the gateway doesn't calculate them yet.
  totals.push({ type: "total", amount: termTotal });

  return { status: statusOf(checkout, priced), totals, terms, base, termTotal, messages };
}

function statusOf(checkout: Checkout, priced: PricedLines): CheckoutStatus {
  if (checkout.state === "completed") return "completed";
  if (checkout.state === "canceled") return "canceled";
  // Without an account there is nothing to pay with: no handlers are offered.
  if (!checkout.quotable) return "requires_escalation";
  if (priced.lines.length === 0 || priced.messages.some((m) => m.type === "error")) return "incomplete";
  // A pending or quoted cycle doesn't hold the Checkout: the Buyer pays the totals as they stand (#929 §8).
  return "ready_for_complete";
}

export interface CheckoutRendering {
  quoteCapability: string;
  storefrontOrigin: string;
}

export function toUcpCheckout(checkout: Checkout, priced: PricedLines, result: PricedCheckout, extraMessages: PricingMessage[], opts: CheckoutRendering) {
  const capabilities: Record<string, { version: string }[]> = { "dev.ucp.shopping.checkout": [{ version: UCP_VERSION }] };
  if (checkout.quotable) {
    capabilities[opts.quoteCapability] = [{ version: UCP_VERSION }];
    capabilities[TERMS_CAPABILITY] = [{ version: UCP_VERSION }];
  }
  const body: Record<string, unknown> = {
    ucp: { version: UCP_VERSION, capabilities, payment_handlers: {} },
    id: checkout.id,
    line_items: lineItems(priced.lines),
    status: result.status,
    currency: priced.currency,
    totals: result.totals,
    links: [{ type: "terms_of_service", url: `${opts.storefrontOrigin}/terms` }],
    expires_at: checkout.expiresAt.toISOString(),
  };
  if (result.status !== "completed" && result.status !== "canceled") body.continue_url = `${opts.storefrontOrigin}/checkout/${checkout.id}`;
  if (checkout.quotable) {
    body.payment = { terms: result.terms, selected_term_id: checkout.selectedTermId };
    body.quote = toUcpQuote(checkout.quote);
  }
  if (checkout.orderId) body.order = { id: checkout.orderId, permalink_url: orderPermalink(opts.storefrontOrigin, checkout.orderId) };

  const messages = [...priced.messages, ...extraMessages, ...result.messages];
  if (result.status === "requires_escalation") {
    messages.push({
      type: "error", code: "identity_required", severity: "requires_buyer_input",
      content: "Ordering on account needs a linked buyer account. Continue on the supplier's site to finish.",
    });
  }
  if (messages.length) body.messages = messages;
  return body;
}

export function toUcpOrder(order: Order, opts: CheckoutRendering) {
  const capabilities: Record<string, { version: string }[]> = {
    "dev.ucp.shopping.order": [{ version: UCP_VERSION }],
    [TERMS_CAPABILITY]: [{ version: UCP_VERSION }],
  };
  if (order.quote) capabilities[opts.quoteCapability] = [{ version: UCP_VERSION }];
  const body: Record<string, unknown> = {
    ucp: { version: UCP_VERSION, capabilities },
    id: order.id,
    checkout_id: order.checkoutId,
    permalink_url: orderPermalink(opts.storefrontOrigin, order.id),
    line_items: order.lines.map((l) => ({
      id: l.id,
      item: { id: l.itemId, title: l.title, price: l.unitPrice.amount },
      quantity: { original: l.quantity, total: l.quantity, fulfilled: 0 },
      totals: [{ type: "subtotal", amount: l.subtotal.amount }],
      status: "processing",
    })),
    fulfillment: { expectations: [], events: [] },
    currency: order.currency,
    totals: order.totals,
    payment: { accepted_term: order.acceptedTerm },
  };
  // Only the accepted quotation's id and subtotal are projected (#929 §9).
  if (order.quote) body.quote = order.quote;
  return body;
}

function lineItems(lines: PricedLine[]) {
  return lines.map((l) => ({
    id: l.id,
    item: { id: l.itemId, title: l.title, price: l.unitPrice.amount },
    quantity: l.quantity,
    totals: [{ type: "subtotal", amount: l.subtotal.amount }],
  }));
}

function orderPermalink(storefrontOrigin: string, orderId: string): string {
  return `${storefrontOrigin}/account/orders/${orderId}`;
}
